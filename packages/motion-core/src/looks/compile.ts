/**
 * Living Look compiler (R2 / L2).
 *
 * Pure, deterministic, no I/O. Given a pinned definition, an operator's slot
 * assignment and control values, and the composition's dimensions, it emits a
 * flat list of `LookOperation`s — ordinary canonical operations the editor
 * host adapter translates 1:1 to a JoyCode plan.
 *
 * Rules that hold by construction:
 *  - identical inputs produce the identical `operationDigest`;
 *  - a binding the operator has hand-edited (`overriddenBindingIds`) is never
 *    written unless an explicit `resetBindingIds` re-opens it;
 *  - a control value out of range, an unbound required slot, a missing font,
 *    or a definition that fails validation yields **no operations at all** —
 *    the caller never gets a partial plan.
 */

import { validateLookDefinition } from './validate.js';
import {
  type LookCompileInput,
  type LookCompileResult,
  type LookCompilerDiagnostic,
  type LookControl,
  type LookOperation,
  type LookOperationKind,
} from './types.js';

/**
 * Maps a `[0,1]` operator value linearly onto a declared `[minimum, maximum]`
 * property range. The only macro maths the compiler does — everything else is a
 * table lookup.
 */
export function mapLookControl(value: number, minimum: number, maximum: number): number {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1 ||
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    minimum === maximum
  )
    throw new RangeError('Invalid Look control range');
  // A descending range (minimum > maximum) is allowed — higher operator value
  // then moves the property the other way (e.g. more lift = more negative y).
  return minimum + value * (maximum - minimum);
}

/** Stable FNV-1a hex digest of a canonical string — deterministic across runs. */
function digest(canonical: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function fractionToUs(fraction: number, durationUs: number): number {
  return Math.round(fraction * durationUs);
}

function fail(diagnostics: readonly LookCompilerDiagnostic[]): LookCompileResult {
  return {
    ok: false,
    operations: [],
    operationDigest: digest('FAIL'),
    changedBindingIds: [],
    dependencies: { operationKinds: [], fonts: [] },
    diagnostics,
  };
}

export function compileLook(input: LookCompileInput): LookCompileResult {
  const { definition } = input;
  const diagnostics: LookCompilerDiagnostic[] = [];

  const defDiagnostics = validateLookDefinition(definition);
  if (defDiagnostics.length > 0) {
    return fail(
      defDiagnostics.map((d) => ({
        code: `DEFINITION_${d.code}`,
        message: `${d.path}: ${d.message}`,
      })),
    );
  }

  if (input.definitionVersion !== definition.version) {
    return fail([
      {
        code: 'LOOK_COMPILE_VERSION_MISMATCH',
        message: `instance pinned to definition version ${input.definitionVersion}, given ${definition.version}`,
      },
    ]);
  }

  if (!Number.isFinite(input.compositionDurationUs) || input.compositionDurationUs <= 0) {
    return fail([
      { code: 'LOOK_COMPILE_DURATION', message: 'compositionDurationUs must be a positive number' },
    ]);
  }

  // Required slots must resolve to a real entity id.
  for (const slot of definition.slots) {
    if (!slot.required) continue;
    const entityId = input.entityBindings[slot.id];
    if (typeof entityId !== 'string' || entityId.length === 0) {
      diagnostics.push({
        code: 'LOOK_COMPILE_UNBOUND_SLOT',
        message: `required slot "${slot.id}" is not bound to an entity`,
      });
    }
  }

  // Required fonts must be resolved to a bundled family.
  for (const font of definition.requiredFonts) {
    if (typeof input.resolvedFonts[font] !== 'string') {
      diagnostics.push({
        code: 'LOOK_COMPILE_MISSING_FONT',
        message: `required font "${font}" was not resolved`,
      });
    }
  }

  if (diagnostics.length > 0) return fail(diagnostics);

  const bindingById = new Map(definition.bindingTargets.map((t) => [t.bindingId, t]));
  const requiredSlotIds = new Set(
    definition.slots.filter((slot) => slot.required).map((slot) => slot.id),
  );
  const overridden = new Set(input.overriddenBindingIds);
  const reset = new Set(input.resetBindingIds ?? []);
  const isWritable = (bindingId: string): boolean =>
    !overridden.has(bindingId) || reset.has(bindingId);

  // A binding with a pre-baked audio track: the bake is authoritative, so
  // control drives that target it are skipped and the baked keyframes are
  // emitted verbatim below.
  const bakedBindingIds = new Set((input.audioBakes ?? []).map((b) => b.bindingId));

  const operations: LookOperation[] = [];
  const changed = new Set<string>();
  const usedKinds = new Set<LookOperationKind>();

  /**
   * `restValue` is written where `profile[i]` is 0, `fullValue` where it is 1,
   * linearly between. A missing `profile` is treated as all-ones (a flat hold
   * at `fullValue`).
   */
  const emitKeyframes = (
    bindingId: string,
    restValue: number,
    fullValue: number,
    atFractions: readonly number[],
    profile: readonly number[] | undefined,
    interpolation: 'hold' | 'linear' | 'eased',
  ): void => {
    const target = bindingById.get(bindingId);
    if (target === undefined) {
      diagnostics.push({
        code: 'LOOK_COMPILE_UNKNOWN_BINDING',
        message: `no binding target "${bindingId}"`,
        bindingId,
      });
      return;
    }
    if (!isWritable(bindingId)) return;
    // An audio bake owns this binding — its keyframes replace the slider drive.
    if (bakedBindingIds.has(bindingId)) return;
    const ownerId = input.entityBindings[target.ownerSlotId];
    if (typeof ownerId !== 'string' || ownerId.length === 0) {
      // A drive that targets an optional, unbound slot is simply skipped;
      // required slots are already checked upfront so this only fires
      // defensively.
      if (requiredSlotIds.has(target.ownerSlotId)) {
        diagnostics.push({
          code: 'LOOK_COMPILE_UNBOUND_SLOT',
          message: `binding "${bindingId}" needs required slot "${target.ownerSlotId}" bound`,
          bindingId,
        });
      }
      return;
    }
    atFractions.forEach((fraction, i) => {
      const weight = profile === undefined ? 1 : (profile[i] ?? 1);
      operations.push({
        kind: 'motion.setKeyframe',
        bindingId,
        ownerKind: target.ownerKind,
        ownerId,
        propertyId: target.propertyId,
        timeDomain: target.timeDomain,
        timeUs: fractionToUs(fraction, input.compositionDurationUs),
        value: restValue + weight * (fullValue - restValue),
        interpolation,
      });
    });
    changed.add(bindingId);
    usedKinds.add('motion.setKeyframe');
  };

  const emitTemplate = (
    bindingId: string,
    surface: 'text' | 'caption',
    templateId: string,
  ): void => {
    const target = bindingById.get(bindingId);
    if (target === undefined) {
      diagnostics.push({
        code: 'LOOK_COMPILE_UNKNOWN_BINDING',
        message: `no binding target "${bindingId}"`,
        bindingId,
      });
      return;
    }
    if (!isWritable(bindingId)) return;
    const ownerId = input.entityBindings[target.ownerSlotId];
    if (typeof ownerId !== 'string' || ownerId.length === 0) {
      // A drive that targets an optional, unbound slot is simply skipped;
      // required slots are already checked upfront so this only fires
      // defensively.
      if (requiredSlotIds.has(target.ownerSlotId)) {
        diagnostics.push({
          code: 'LOOK_COMPILE_UNBOUND_SLOT',
          message: `binding "${bindingId}" needs required slot "${target.ownerSlotId}" bound`,
          bindingId,
        });
      }
      return;
    }
    if (surface === 'text') {
      operations.push({ kind: 'text.setTemplate', bindingId, objectId: ownerId, templateId });
      usedKinds.add('text.setTemplate');
    } else {
      operations.push({
        kind: 'caption.setTemplate',
        bindingId,
        captionClipId: ownerId,
        templateId,
      });
      usedKinds.add('caption.setTemplate');
    }
    changed.add(bindingId);
  };

  for (const control of definition.controls) {
    compileControl(control, input, emitKeyframes, emitTemplate, diagnostics);
  }

  // Pre-baked audio-reactive tracks (L4). Emitted verbatim onto their binding
  // after control drives were skipped for it.
  const seenBakeBindings = new Set<string>();
  for (const bake of input.audioBakes ?? []) {
    if (seenBakeBindings.has(bake.bindingId)) {
      diagnostics.push({
        code: 'LOOK_COMPILE_BAKE_DUPLICATE',
        message: `audio bake binding "${bake.bindingId}" is supplied more than once`,
        bindingId: bake.bindingId,
      });
      continue;
    }
    seenBakeBindings.add(bake.bindingId);
    const target = bindingById.get(bake.bindingId);
    if (target === undefined) {
      diagnostics.push({
        code: 'LOOK_COMPILE_UNKNOWN_BINDING',
        message: `audio bake references unknown binding "${bake.bindingId}"`,
        bindingId: bake.bindingId,
      });
      continue;
    }
    if (target.channel !== 'keyframe') {
      diagnostics.push({
        code: 'LOOK_COMPILE_BAKE_CHANNEL',
        message: `audio bake binding "${bake.bindingId}" is not a keyframe channel`,
        bindingId: bake.bindingId,
      });
      continue;
    }
    if (!isWritable(bake.bindingId)) continue;
    if (bake.keys.length < 2) {
      diagnostics.push({
        code: 'LOOK_COMPILE_BAKE_KEYS',
        message: `audio bake binding "${bake.bindingId}" needs at least two keys`,
        bindingId: bake.bindingId,
      });
      continue;
    }
    const ownerId = input.entityBindings[target.ownerSlotId];
    if (typeof ownerId !== 'string' || ownerId.length === 0) {
      if (requiredSlotIds.has(target.ownerSlotId)) {
        diagnostics.push({
          code: 'LOOK_COMPILE_UNBOUND_SLOT',
          message: `audio bake "${bake.bindingId}" needs required slot "${target.ownerSlotId}" bound`,
          bindingId: bake.bindingId,
        });
      }
      continue;
    }
    // Validate the rounded times — those are what land on the timeline, so a
    // pair of raw times that round to the same microsecond is a collision.
    let previousTimeUs = Number.NEGATIVE_INFINITY;
    let bakeInvalid = false;
    const roundedKeys: { timeUs: number; value: number }[] = [];
    for (const key of bake.keys) {
      const timeUs = Math.round(key.timeUs);
      if (
        !Number.isFinite(timeUs) ||
        !Number.isFinite(key.value) ||
        timeUs < 0 ||
        timeUs > input.compositionDurationUs ||
        timeUs <= previousTimeUs
      ) {
        diagnostics.push({
          code: 'LOOK_COMPILE_BAKE_KEYS',
          message: `audio bake binding "${bake.bindingId}" has an out-of-range or non-increasing key`,
          bindingId: bake.bindingId,
        });
        bakeInvalid = true;
        break;
      }
      previousTimeUs = timeUs;
      roundedKeys.push({ timeUs, value: key.value });
    }
    if (bakeInvalid) continue;
    for (const key of roundedKeys) {
      operations.push({
        kind: 'motion.setKeyframe',
        bindingId: bake.bindingId,
        ownerKind: target.ownerKind,
        ownerId,
        propertyId: target.propertyId,
        timeDomain: target.timeDomain,
        timeUs: key.timeUs,
        value: key.value,
        interpolation: bake.interpolation ?? 'linear',
      });
    }
    changed.add(bake.bindingId);
    usedKinds.add('motion.setKeyframe');
  }

  if (diagnostics.length > 0) return fail(diagnostics);

  // Deterministic order: group by a stable key, then chronologically within a
  // keyframe binding, so identical inputs always serialize identically and
  // consumers get keyframes in time order.
  operations.sort((a, b) => {
    const keyed = stableGroupKey(a).localeCompare(stableGroupKey(b));
    if (keyed !== 0) return keyed;
    const at = a.kind === 'motion.setKeyframe' ? a.timeUs : 0;
    const bt = b.kind === 'motion.setKeyframe' ? b.timeUs : 0;
    return at - bt;
  });

  const canonical = JSON.stringify(operations);
  return {
    ok: true,
    operations,
    operationDigest: digest(canonical),
    changedBindingIds: [...changed].sort(),
    dependencies: {
      operationKinds: [...usedKinds].sort(),
      fonts: [...new Set(Object.values(input.resolvedFonts))].sort(),
    },
    diagnostics: [],
  };
}

function stableGroupKey(op: LookOperation): string {
  switch (op.kind) {
    case 'motion.setKeyframe':
      return `a:${op.bindingId}:${op.propertyId}`;
    case 'text.setContent':
      return `b:${op.bindingId}:${op.objectId}`;
    case 'text.setTemplate':
      return `c:${op.bindingId}:${op.objectId}`;
    case 'caption.setTemplate':
      return `d:${op.bindingId}:${op.captionClipId}`;
    case 'transition.addAtJunction':
      return `e:${op.bindingId}:${op.outgoingClipId}`;
    default: {
      const exhaustive: never = op;
      return String(exhaustive);
    }
  }
}

function compileControl(
  control: LookControl,
  input: LookCompileInput,
  emitKeyframes: (
    bindingId: string,
    restValue: number,
    fullValue: number,
    atFractions: readonly number[],
    profile: readonly number[] | undefined,
    interpolation: 'hold' | 'linear' | 'eased',
  ) => void,
  emitTemplate: (bindingId: string, surface: 'text' | 'caption', templateId: string) => void,
  diagnostics: LookCompilerDiagnostic[],
): void {
  const raw = input.controlValues[control.id];

  switch (control.kind) {
    case 'scalar': {
      const value01 = typeof raw === 'number' ? raw : control.default;
      if (!Number.isFinite(value01) || value01 < 0 || value01 > 1) {
        diagnostics.push({
          code: 'LOOK_COMPILE_CONTROL_RANGE',
          message: `control "${control.id}" value must be in [0,1]`,
        });
        return;
      }
      for (const drive of control.drives) {
        // Excursion from the resting min towards the operator-scaled mapped
        // value, shaped over time by the profile.
        emitKeyframes(
          drive.bindingId,
          drive.min,
          mapLookControl(value01, drive.min, drive.max),
          drive.atFractions,
          drive.profile,
          drive.interpolation,
        );
      }
      break;
    }
    case 'enum': {
      const option = typeof raw === 'string' ? raw : control.default;
      if (!control.options.includes(option)) {
        diagnostics.push({
          code: 'LOOK_COMPILE_CONTROL_ENUM',
          message: `control "${control.id}" value "${option}" is not an option`,
        });
        return;
      }
      for (const drive of control.drives) {
        emitKeyframes(
          drive.bindingId,
          drive.byOption[option]!,
          drive.settled ?? drive.byOption[option]!,
          drive.atFractions,
          drive.profile,
          drive.interpolation,
        );
      }
      for (const drive of control.templateDrives ?? []) {
        emitTemplate(drive.bindingId, drive.target, drive.templateByOption[option]!);
      }
      break;
    }
    case 'color': {
      const option = typeof raw === 'string' ? raw : control.default;
      if (!control.palettePairs.some((p) => p.id === option)) {
        diagnostics.push({
          code: 'LOOK_COMPILE_CONTROL_COLOR',
          message: `control "${control.id}" value "${option}" is not a palette pair`,
        });
        return;
      }
      for (const drive of control.drives) {
        emitTemplate(drive.bindingId, drive.target, drive.templateByOption[option]!);
      }
      break;
    }
    case 'font': {
      const option = typeof raw === 'string' ? raw : control.default;
      if (!control.families.includes(option)) {
        diagnostics.push({
          code: 'LOOK_COMPILE_CONTROL_FONT',
          message: `control "${control.id}" value "${option}" is not a listed family`,
        });
        return;
      }
      const resolved = input.resolvedFonts[option];
      if (typeof resolved !== 'string') {
        diagnostics.push({
          code: 'LOOK_COMPILE_MISSING_FONT',
          message: `font "${option}" was not resolved`,
        });
        return;
      }
      for (const drive of control.drives) {
        emitTemplate(drive.bindingId, drive.target, drive.templateByOption[option]!);
      }
      break;
    }
    case 'boolean': {
      const on = typeof raw === 'boolean' ? raw : control.default;
      for (const drive of control.drives) {
        const value = on ? drive.whenTrue : drive.whenFalse;
        if (value === 'omit') continue;
        emitKeyframes(
          drive.bindingId,
          value,
          value,
          drive.atFractions,
          drive.profile,
          drive.interpolation,
        );
      }
      break;
    }
    default: {
      const exhaustive: never = control;
      void exhaustive;
    }
  }
}
