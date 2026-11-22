import { actionsFor, inspectorNumericCases } from './inspector-numeric-cases.mjs';
import { timelineControlCases } from './timeline-control-cases.mjs';
import { TIMELINE_ROWS } from './desktop-timeline-steps.mjs';
import { MONITOR_KEYBOARD_CASES } from './monitor-keyboard-steps.mjs';

const EVIDENCE_ROOT = 'evidence/editor-controls-audit';

function slug(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase();
}

function evidenceKey(id) {
  return `${EVIDENCE_ROOT}/${slug(id)}`;
}

function pointerDriven(id, actionId = '') {
  return /trim|drag|gesture|pointer|color-menu|insert-media|runway/iu.test(`${id} ${actionId}`);
}

function validationError(descriptor, param, seen) {
  if (!descriptor || typeof descriptor.id !== 'string' || descriptor.id.trim() === '')
    return 'descriptor id must be a non-empty string';
  if (!param || typeof param.key !== 'string' || param.key.trim() === '')
    return 'parameter key must be a non-empty string';
  if (seen.has(`${descriptor.id}/${param.key}`)) return 'duplicate descriptor parameter key';
  if (typeof param.label !== 'string' || param.label.trim() === '') return 'label must be a non-empty string';
  if (param.type !== 'number') return 'parameter type must be number';
  for (const field of ['defaultValue', 'min', 'max', 'step']) {
    if (!Number.isFinite(param[field])) return `${field} must be a finite number`;
  }
  if (param.min > param.max) return 'min must be less than or equal to max';
  if (param.step <= 0) return 'step must be greater than zero';
  if (param.defaultValue < param.min || param.defaultValue > param.max)
    return 'defaultValue must be within min and max';
  return undefined;
}

function normalizedResult(result) {
  if (result === true) return { ok: true };
  if (result === false) return { ok: false, detail: 'evidence assertion returned false' };
  if (typeof result === 'string') return { ok: result.length === 0, detail: result || undefined };
  if (result && typeof result === 'object' && typeof result.ok === 'boolean') return result;
  return { ok: false, detail: 'evidence assertion did not return an explicit boolean result' };
}

function unavailable(row, reason, pre, post) {
  return {
    id: row.id,
    status: 'unavailable',
    rerunnable: true,
    reason,
    pre,
    post,
    expectedEvidencePath: row.expectedEvidencePath,
  };
}

function failed(row, reason, pre, post) {
  return {
    id: row.id,
    status: 'failed',
    rerunnable: false,
    reason,
    pre,
    post,
    expectedEvidencePath: row.expectedEvidencePath,
  };
}

function makeRow(helpers, spec) {
  const key = evidenceKey(spec.id);
  const row = {
    ...spec,
    ...(spec.validationError ? { status: 'failed', reason: spec.validationError } : {}),
    evidenceKey: key,
    expectedEvidencePath: `${key}.png`,
    evidencePaths: Object.freeze({ pre: `${key}.pre.json`, post: `${key}.post.json`, screenshot: `${key}.png` }),
    async run(page, context = {}) {
      if (spec.validationError) return failed(row, spec.validationError, null, null);

      let prerequisite = { available: true };
      if (typeof helpers.prerequisite !== 'function') {
        return unavailable(row, 'orchestrator did not supply a prerequisite check', null, null);
      }
      try {
        prerequisite = await helpers.prerequisite(page, row, context);
      } catch (error) {
        return failed(row, `prerequisite check failed: ${errorMessage(error)}`, null, null);
      }
      if (prerequisite === false || prerequisite?.available === false) {
        return unavailable(row, prerequisite?.reason ?? 'prerequisite is not available', null, null);
      }

      const driver = spec.driver === 'pointer' ? helpers.pointer : helpers.cdp;
      if (!driver || typeof driver.snapshot !== 'function' || typeof driver.perform !== 'function') {
        return unavailable(
          row,
          `orchestrator did not supply the ${spec.driver} snapshot and action hooks`,
          null,
          null,
        );
      }

      let pre;
      let post;
      let actionResult;
      try {
        pre = await driver.snapshot(page, row, context);
      } catch (error) {
        return failed(row, `pre-state capture failed: ${errorMessage(error)}`, null, null);
      }
      try {
        actionResult = await driver.perform(page, row, context);
      } catch (error) {
        try {
          post = await driver.snapshot(page, row, context);
        } catch {
          post = null;
        }
        const message = errorMessage(error);
        if (error?.code === 'AUDIT_UNAVAILABLE' || /^(BLOCKED|NOT-REACHABLE)(:|\s)/u.test(message))
          return unavailable(row, message, pre, post);
        return failed(row, `action failed: ${message}`, pre, post);
      }
      try {
        post = await driver.snapshot(page, row, context);
      } catch (error) {
        return failed(row, `post-state capture failed: ${errorMessage(error)}`, pre, null);
      }

      let assertion;
      if (typeof helpers.assert === 'function') {
        try {
          assertion = normalizedResult(
            await helpers.assert({ page, row, pre, post, before: pre, after: post, actionResult, context }),
          );
        } catch (error) {
          return failed(row, `evidence assertion failed: ${errorMessage(error)}`, pre, post);
        }
      } else {
        assertion = {
          ok: JSON.stringify(pre) !== JSON.stringify(post),
          detail: 'expected the observed state to change',
        };
      }

      if (!assertion.ok) return failed(row, assertion.detail ?? 'evidence assertion failed', pre, post);
      return {
        id: row.id,
        status: 'passed',
        rerunnable: false,
        pre,
        post,
        expectedEvidencePath: row.expectedEvidencePath,
        evidence: actionResult?.evidence ?? null,
        assertion: assertion.detail ?? 'evidence assertion passed',
      };
    },
  };
  return Object.freeze(row);
}

function errorMessage(error) {
  return String(error?.message ?? error).split('\n')[0];
}

function auditFamilyForNumericAction(actionId) {
  return pointerDriven('', actionId) ? 'pointer' : 'cdp';
}

function descriptorRows(helpers, descriptors) {
  const rows = [];
  const seen = new Set();
  for (const descriptor of descriptors ?? []) {
    const params = Array.isArray(descriptor?.params) ? descriptor.params : [];
    if (params.length === 0) {
      rows.push(
        makeRow(helpers, {
          id: `descriptor:${descriptor?.id ?? 'missing-id'}/_descriptor:validation`,
          family: 'effect-descriptor',
          action: { type: 'validate-descriptor' },
          assertion: 'descriptor must contain parameters',
          validationError: 'descriptor params must be a non-empty array',
          parameter: null,
          driver: 'cdp',
        }),
      );
      continue;
    }
    const paramCounts = new Map();
    for (const param of params) {
      if (typeof param?.key === 'string') paramCounts.set(param.key, (paramCounts.get(param.key) ?? 0) + 1);
    }
    for (const [paramIndex, param] of params.entries()) {
      if (param?.type !== 'number') continue;
      const issue = validationError(descriptor, param, seen);
      const duplicateSuffix = (paramCounts.get(param?.key) ?? 0) > 1 ? `~${paramIndex + 1}` : '';
      if (typeof descriptor?.id === 'string' && typeof param?.key === 'string')
        seen.add(`${descriptor.id}/${param.key}`);
      if (issue) {
        rows.push(
          makeRow(helpers, {
            id: `descriptor:${descriptor?.id ?? 'missing-id'}/${param?.key ?? 'missing-key'}${duplicateSuffix}:validation`,
            family: 'effect-descriptor',
            action: { type: 'validate-numeric-parameter' },
            assertion: 'numeric descriptor fields must be valid independently for each parameter',
            validationError: issue,
            parameter: param,
            driver: 'cdp',
          }),
        );
        continue;
      }
      const shared = {
        family: 'effect-descriptor',
        descriptorId: descriptor.id,
        parameter: param,
        descriptor,
        sourceIds: [`${descriptor.id}.${param.key}`],
        assertion: 'read back this parameter value and verify its descriptor bounds and step',
      };
      const uncuedId = `descriptor:${descriptor.id}/${param.key}:uncued-value`;
      rows.push(
        makeRow(helpers, {
          ...shared,
          id: uncuedId.replace(`${param.key}:`, `${param.key}${duplicateSuffix}:`),
          driver: 'cdp',
          action: { type: 'numeric-uncued-value', descriptorId: descriptor.id, parameterKey: param.key },
          keyed: false,
        }),
      );
      if (param.animatable === true) {
        rows.push(
          makeRow(helpers, {
            ...shared,
            id: `descriptor:${descriptor.id}/${param.key}${duplicateSuffix}:keyed-value`,
            driver: 'cdp',
            action: { type: 'numeric-keyed-value', descriptorId: descriptor.id, parameterKey: param.key },
            keyed: true,
          }),
        );
      }
    }
  }
  return rows;
}

function supplementalRows(helpers) {
  const specs = [
    ['space.tap', 'keyboard', { type: 'space-tap', key: 'Space' }, 'Space tap toggles playback once and returns focus ownership to the initiating control.'],
    ['space.hold', 'keyboard', { type: 'space-hold', key: 'Space', durationMs: 700 }, 'Holding Space follows the editor hold behavior without leaking the key after release.'],
    ['space.repeat', 'keyboard', { type: 'space-repeat', key: 'Space', repeats: 3 }, 'Repeated Space taps produce the expected repeat count without a stuck key.'],
    ['space.focus-ownership', 'keyboard', { type: 'focus-ownership', key: 'Space' }, 'Space is handled only by the editor that owns focus; text inputs retain normal typing behavior.'],
    ['gesture.single-undo', 'pointer', { type: 'gesture-single-undo', undoCount: 1 }, 'One complete pointer gesture is undone by exactly one Undo.'],
    ['caption.direction-ltr', 'cdp', { type: 'caption-direction', direction: 'ltr' }, 'Caption text renders and remains editable in left-to-right direction.'],
    ['caption.direction-rtl', 'cdp', { type: 'caption-direction', direction: 'rtl' }, 'Caption text renders and remains editable in right-to-left direction.'],
    ['caption.reopen', 'cdp', { type: 'caption-reopen' }, 'Closing and reopening the caption editor preserves the text and direction.'],
  ];
  return specs.map(([suffix, driver, action, assertion]) =>
    makeRow(helpers, {
      id: `editor:${suffix}`,
      family: suffix.startsWith('caption') ? 'captions' : suffix.startsWith('gesture') ? 'gesture-undo' : 'keyboard',
      driver,
      action,
      assertion,
      prerequisite: 'orchestrator confirms the target editor, caption, focus owner, or gesture is available',
      sourceIds: [],
    }),
  );
}

function monitorRows(helpers) {
  const steps = [
    ['focus-stage', 'Tab reaches the Monitor picture without a pointer action.'],
    ['select-element', 'Tab selects the target element and selection matches the timeline.'],
    ['arrow-right', 'ArrowRight moves the selected element one step.'],
    ['shift-arrow-right', 'Shift+ArrowRight moves further than one step.'],
    ['alt-arrow-up', 'Alt+ArrowUp scales the selected element up.'],
    ['rotate-right', '] rotates the selected element.'],
    ['escape-exit', 'Escape leaves the Monitor picture.'],
    ['shift-tab-exit', 'Shift+Tab at the first element lets focus leave the picture.'],
  ];
  return Object.keys(MONITOR_KEYBOARD_CASES).flatMap((sourceId) =>
    steps.map(([step, assertion]) =>
      makeRow(helpers, {
        id: `monitor:${sourceId}:${step}`,
        family: 'monitor-keyboard',
        sourceIds: [sourceId],
        action: { type: 'monitor-keyboard-step', step, sourceId },
        assertion,
        prerequisite: 'a running editor with one visible visual element and its timeline clip id',
        driver: 'cdp',
      }),
    ),
  );
}

/**
 * Build per-control audit rows. The orchestrator owns app launch, registry state,
 * and teardown; this module uses only injected CDP and native-pointer hooks.
 *
 * Driver hooks: `helpers.prerequisite(page, row, context)`,
 * `helpers.cdp|pointer.snapshot(page, row, context)`, and
 * `helpers.cdp|pointer.perform(page, row, context)`. A custom `helpers.assert`
 * can apply the orchestrator's exact state assertions. Missing hooks and
 * prerequisites produce rerunnable `unavailable` results, never passes.
 */
export function buildEditorControlsAuditRows(helpers = {}, descriptors = []) {
  const rows = [];

  for (const control of timelineControlCases) {
    const id = `timeline:${control.id}`;
    rows.push(
      makeRow(helpers, {
        id,
        family: 'timeline-control',
        sourceIds: [control.id],
        inventory: control,
        action: { type: 'timeline-control', controlId: control.id, label: control.label },
        assertion: control.expected,
        prerequisite: control.prerequisite,
        driver: pointerDriven(control.id, control.scope) ? 'pointer' : 'cdp',
      }),
    );
  }

  for (const control of TIMELINE_ROWS) {
    const id = `desktop:${control.id}`;
    rows.push(
      makeRow(helpers, {
        id,
        family: 'desktop-timeline',
        sourceIds: [control.id],
        inventory: control,
        action: { type: control.command ?? 'desktop-timeline-row', controlId: control.id },
        assertion: control.title,
        prerequisite: control.expected,
        driver: pointerDriven(control.id, control.command) ? 'pointer' : 'cdp',
      }),
    );
  }

  for (const numericCase of inspectorNumericCases) {
    for (const numericAction of actionsFor(numericCase)) {
      const actionId = numericAction.id;
      const id = `inspector:${numericCase.section}/${numericCase.control}:${actionId}`;
      rows.push(
        makeRow(helpers, {
          id,
          family: 'inspector-numeric',
          sourceIds: [`${numericCase.section}/${numericCase.control}`],
          numericCase,
          numericAction,
          parameter: numericCase,
          action: { type: `numeric-${actionId}`, control: numericCase.control },
          assertion: numericAction.label,
          prerequisite: numericCase.input?.selector ?? numericCase.input?.ariaLabel ?? numericCase.control,
          driver: auditFamilyForNumericAction(actionId),
          keyed: numericAction.id === 'keyframe',
        }),
      );
    }
    const uncuedId = `inspector:${numericCase.section}/${numericCase.control}:uncued-value`;
    rows.push(
      makeRow(helpers, {
        id: uncuedId,
        family: 'inspector-numeric',
        sourceIds: [`${numericCase.section}/${numericCase.control}`],
        numericCase,
        parameter: numericCase,
        action: { type: 'numeric-uncued-value', control: numericCase.control },
        assertion: 'edit the numeric value with no keyframe cue and confirm no keyframe was created',
        prerequisite: numericCase.input?.selector ?? numericCase.control,
        driver: 'cdp',
        keyed: false,
      }),
    );
  }

  rows.push(...descriptorRows(helpers, descriptors));
  rows.push(...monitorRows(helpers));
  rows.push(...supplementalRows(helpers));

  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error(`duplicate editor-controls audit row id: ${row.id}`);
    seen.add(row.id);
  }
  return Object.freeze(rows);
}
