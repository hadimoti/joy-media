/**
 * T-A07 rows D-057, D-058 and D-070: effects, clip audio and the Joy Code Looks (no model connected).
 * Each row takes Monitor pictures (`preview-*.png`) and 2-second exports checked with ffprobe.
 *
 * NOT RUN: written without launching the app. Selectors come from reading EffectsPanel, LibraryCard,
 * InspectorPanel (EffectsSection, AudioSection, PanelShell tabs), AgentPanel and LivingLooksPanel; the first
 * live run must confirm each one.
 *
 *   D-057 Add an effect from the Enhance panel (Effects tool), change its first parameter in the Inspector's
 *         Effects tab, remove it. A frame of the export with the effect differs from one without it.
 *   D-058 Inspector Audio tab: Volume 0.5 lowers the exported level by about 6 dB (ffmpeg volumedetect);
 *         Mute leaves the export silent or without an audio stream. Needs a fixture with audio.
 *   D-070 Joy Code > Looks, with no model: apply a Look (bound to a text element), update a control, reset a
 *         hand-edited binding when the panel offers one (otherwise not reachable), detach, and Undo the detach.
 */
import { spawnSync } from 'node:child_process';
import { blockedRow, notReachable, runParts } from './rows.mjs';
import {
  blurFocus,
  clickMenuItem,
  ensureTimelineClip,
  previewShot,
  selectClipById,
  snapshot,
} from './ui-steps.mjs';
import { exportAndProbe, measureMeanVolumeDb } from './export-probe.mjs';
import { mediaHasAudio, readNodeLabels, readOptionValues } from './left-panels-steps.mjs';

export const FX_SEL = Object.freeze({
  effectsTool: '[role="tab"][data-feature-tool="effects"]',
  effectAddButtons: 'button[aria-label^="Add "]',
  // Scoped to the Inspector: the Create panel has its own Audio and Effects tabs with the same ids (found live).
  inspectorTab: (id) => `.inspector-panel button[role="tab"][data-panel-tab-id="${id}"]`,
  effectItem: '.inspector-effect-item[data-effect-id]',
  effectRemove: '.inspector-effect-actions button[aria-label^="Remove "]',
  gain: '#insp-gain',
  mute: 'section.inspector-section button[aria-pressed]',
  looksButton: 'button.joy-code-capability',
  looksRegion: '.living-looks[role="region"]',
  lookSelect: '.living-look-select:not([disabled])',
  lookSlotSelect: '.living-look-slot select',
  appliedLook: '.applied-look',
  appliedControl: '.applied-look-control',
  appliedDetach: '.applied-look-detach',
  appliedReset: '.applied-look-reset',
});

/** Page-side: the numeric limits and current value of an input. */
export function readInputRange(node) {
  return {
    min: Number(node.min === '' ? 0 : node.min),
    max: Number(node.max === '' ? 1 : node.max),
    step: Number(node.step === '' ? 0.01 : node.step),
    value: Number(node.value),
  };
}

/** Page-side: what kind of control a Look control is. */
export function readControlKind(node) {
  return node.tagName === 'SELECT' ? 'select' : node.type;
}

/** Pure: a value for a number input that differs clearly from the current one and stays inside its limits. */
export function pickOtherValue({ min, max, step, value }) {
  const span = max - min;
  const candidate = value < min + span / 2 ? max - span * 0.25 : min + span * 0.25;
  const snapped = Math.round(candidate / step) * step;
  return Number(snapped.toFixed(4));
}

export function firstFrameMd5(file, { run = spawnSync, atSeconds = 1 } = {}) {
  const tool = process.env.JOY_MEDIA_FFMPEG ?? 'ffmpeg';
  const result = run(
    tool,
    ['-v', 'error', '-ss', String(atSeconds), '-i', file, '-frames:v', '1', '-f', 'md5', '-'],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
  const match = /MD5=([0-9a-f]{32})/u.exec(String(result.stdout));
  if (match === null) throw new Error(`ffmpeg printed no frame hash for ${file}`);
  return match[1];
}

async function showInspectorTab(page, id) {
  await clickMenuItem(page, 'View', 'Inspector');
  const tab = page.locator(FX_SEL.inspectorTab(id)).first();
  await tab.click();
  if ((await tab.getAttribute('aria-selected')) !== 'true') {
    throw new Error(`the Inspector ${id} tab did not become the selected tab`);
  }
}

export async function effectsAddChangeRemove(page, ctx, deps = {}) {
  const rowId = 'D-057';
  const md5 = deps.md5 ?? firstFrameMd5;
  const base = await ensureTimelineClip(page, ctx, rowId, { fresh: true });
  await selectClipById(page, base.clips[0].id);
  await previewShot(page, ctx, rowId, 'effect-baseline');
  const baseline = await exportAndProbe(page, ctx, rowId, { tag: 'without-effect' }, deps.export);
  await selectClipById(page, base.clips[0].id);

  const state = { effectId: undefined, target: undefined };
  const outcome = await runParts(
    rowId,
    'effect steps',
    [{ name: 'add' }, { name: 'change' }, { name: 'remove' }],
    async ({ name }) => {
      if (name === 'add') {
        await clickMenuItem(page, 'View', 'Enhance');
        const tool = page.locator(FX_SEL.effectsTool).first();
        await tool.click();
        const labels = await page.locator(FX_SEL.effectAddButtons).evaluateAll(readNodeLabels);
        const label = labels.find((text) => !/to favorites$/u.test(text));
        if (label === undefined) throw new Error('the Effects tool lists no effect to add');
        await page.getByRole('button', { name: label, exact: true }).first().click();
        await showInspectorTab(page, 'effects');
        const items = page.locator(FX_SEL.effectItem);
        await items.first().waitFor({ state: 'attached' });
        state.effectId = await items.first().getAttribute('data-effect-id');
        await previewShot(page, ctx, rowId, 'effect-added');
        const addedExport = await exportAndProbe(
          page,
          ctx,
          rowId,
          { tag: 'effect-added' },
          deps.export,
        );
        return `${label} added; the Inspector lists effect ${state.effectId}; ${addedExport.message}`;
      }
      if (state.effectId === undefined) {
        throw notReachable(rowId, 'the add step did not finish, so there is no effect to work on');
      }
      const item = page.locator(FX_SEL.effectItem).first();
      if (name === 'change') {
        const input = item.locator('input[type="number"], input[type="range"]').first();
        if ((await input.count()) === 0) {
          throw notReachable(rowId, `effect ${state.effectId} has no numeric parameter to change`);
        }
        const range = await input.evaluate(readInputRange);
        state.target = pickOtherValue(range);
        await input.fill(String(state.target));
        await input.press('Enter');
        await blurFocus(page);
        const read = Number(await input.inputValue());
        if (Math.abs(read - state.target) > Math.max(range.step, 0.011)) {
          throw new Error(`the parameter reads ${read} after setting ${state.target}`);
        }
        await previewShot(page, ctx, rowId, 'effect-changed');
        const withEffect = await exportAndProbe(
          page,
          ctx,
          rowId,
          { tag: 'with-effect' },
          deps.export,
        );
        // The proof that the effect does something is made after it is removed: the same timeline exported with
        // and without the effect. Two unrelated exports (baseline versus with-effect) can differ for other reasons.
        state.withEffectHash = md5(withEffect.path);
        return `parameter set to ${read}; export with the effect saved; ${withEffect.message}`;
      }
      await item.locator(FX_SEL.effectRemove).first().click();
      await page.locator(FX_SEL.effectItem).first().waitFor({ state: 'detached' });
      await previewShot(page, ctx, rowId, 'effect-removed');
      const removedExport = await exportAndProbe(
        page,
        ctx,
        rowId,
        { tag: 'effect-removed' },
        deps.export,
      );
      if (state.withEffectHash !== undefined && md5(removedExport.path) === state.withEffectHash) {
        throw new Error(
          `the export frame at 1 s is the same with the effect (${state.effectId}) and after removing it: the effect changes nothing`,
        );
      }
      return `effect ${state.effectId} removed; the Inspector lists none; the export differs from the one with the effect; ${removedExport.message}`;
    },
  );
  return { message: `${outcome.message}; baseline ${baseline.message}`, parts: outcome.parts };
}

export async function clipAudioControls(page, ctx, deps = {}) {
  const rowId = 'D-058';
  if (!mediaHasAudio(ctx.media)) {
    throw blockedRow(
      rowId,
      'needs --media <video fixture with audio> (a name with "audio", not "silent")',
    );
  }
  const base = await ensureTimelineClip(page, ctx, rowId, { fresh: true });
  const measure = deps.measure ?? measureMeanVolumeDb;
  await selectClipById(page, base.clips[0].id);
  await previewShot(page, ctx, rowId, 'gain-1');
  const full = await exportAndProbe(page, ctx, rowId, { tag: 'gain-1', audio: true }, deps.export);
  const fullDb = measure(full.path);
  await selectClipById(page, base.clips[0].id);
  await showInspectorTab(page, 'audio');
  const gain = page.locator(FX_SEL.gain).first();
  await gain.fill('0.5');
  await gain.press('Enter');
  await blurFocus(page);
  if (Number(await gain.inputValue()) !== 0.5) throw new Error('Volume did not keep 0.5');
  await previewShot(page, ctx, rowId, 'gain-0.5');
  const half = await exportAndProbe(
    page,
    ctx,
    rowId,
    { tag: 'gain-0.5', audio: true },
    deps.export,
  );
  const halfDb = measure(half.path);
  const drop = fullDb - halfDb;
  if (Math.abs(drop - 6.02) > 2) {
    throw new Error(
      `Volume 0.5 changed the export level by ${drop.toFixed(1)} dB, expected about 6 dB (${fullDb} -> ${halfDb})`,
    );
  }
  const mute = page.getByRole('button', { name: /^(On|Muted)$/u }).first();
  await mute.click();
  if ((await mute.getAttribute('aria-pressed')) !== 'true')
    throw new Error('Mute did not switch on');
  await previewShot(page, ctx, rowId, 'muted');
  const muted = await exportAndProbe(page, ctx, rowId, { tag: 'muted' }, deps.export);
  const hasAudio = (muted.probe.streams ?? []).some((stream) => stream.codec_type === 'audio');
  let mutedNote = 'the muted export has no audio stream';
  if (hasAudio) {
    const mutedDb = measure(muted.path);
    if (!(mutedDb <= fullDb - 40)) {
      throw new Error(`the muted export is still at ${mutedDb} dB (unmuted ${fullDb} dB)`);
    }
    mutedNote = `the muted export is at ${mutedDb} dB`;
  }
  // Put the clip back as it was, so the rows after this one start from the same sound.
  await mute.click();
  await gain.fill('1');
  await gain.press('Enter');
  await blurFocus(page);
  return `Volume 0.5 lowered the export by ${drop.toFixed(1)} dB; Mute: ${mutedNote}; ${full.message}`;
}

async function openLooks(page) {
  await clickMenuItem(page, 'View', 'Joy Code');
  await page
    .locator(FX_SEL.looksButton)
    .filter({ hasText: /^Looks$/u })
    .first()
    .click();
  await page.locator(FX_SEL.looksRegion).first().waitFor({ state: 'visible' });
}

async function approveLook(page) {
  const approve = page.getByRole('button', { name: /Approve & apply/u }).first();
  await approve.waitFor({ state: 'visible', timeout: 30_000 });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await approve.isEnabled()) break;
    await page.waitForTimeout(500);
  }
  if (!(await approve.isEnabled()))
    throw new Error('the Look preview never became ready to approve');
  await approve.click();
}

async function appliedCount(page) {
  await page.locator('#living-looks-tab-applied').click();
  return page.locator(FX_SEL.appliedLook).count();
}

export async function joyCodeLooks(page, ctx, deps = {}) {
  const rowId = 'D-070';
  await ensureTimelineClip(page, ctx, rowId);
  const state = await snapshot(page);
  if (state.clips.length < 2) {
    throw blockedRow(
      rowId,
      'needs a text element on the timeline to bind the Look to (run D-065 or D-066 first)',
    );
  }
  await openLooks(page);
  const flow = { title: undefined, applied: false };
  const outcome = await runParts(
    rowId,
    'Look steps',
    [{ name: 'apply' }, { name: 'update' }, { name: 'reset' }, { name: 'detach' }],
    async ({ name }) => {
      if (name === 'apply') {
        await page.locator('#living-looks-tab-browse').click();
        const pick = page.locator(FX_SEL.lookSelect).first();
        flow.title = ((await pick.locator('strong').textContent()) ?? '').trim();
        await pick.click();
        const slots = page.locator(FX_SEL.lookSlotSelect);
        const total = await slots.count();
        for (let index = 0; index < total; index += 1) {
          const values = await slots.nth(index).evaluate(readOptionValues);
          if (values.length === 0) {
            throw blockedRow(rowId, `${flow.title} has a slot with no element to bind to`);
          }
          await slots.nth(index).selectOption(values[0]);
        }
        await page.getByRole('button', { name: `Run ${flow.title}`, exact: true }).click();
        await approveLook(page);
        if ((await appliedCount(page)) < 1)
          throw new Error(`${flow.title} is not listed under Applied`);
        flow.applied = true;
        await previewShot(page, ctx, rowId, 'look-applied');
        const exported = await exportAndProbe(
          page,
          ctx,
          rowId,
          { tag: 'look-applied' },
          deps.export,
        );
        await openLooks(page);
        return `${flow.title} applied and listed; ${exported.message}`;
      }
      if (!flow.applied)
        throw notReachable(rowId, 'the apply step did not finish, so there is no Look to work on');
      await page.locator('#living-looks-tab-applied').click();
      if (name === 'update') {
        const control = page
          .locator(FX_SEL.appliedControl)
          .first()
          .locator('input, select')
          .first();
        const kind = await control.evaluate(readControlKind);
        if (kind === 'select') {
          const values = await control.evaluate(readOptionValues);
          const current = await control.inputValue();
          const other = values.find((value) => value !== current);
          if (other === undefined)
            throw notReachable(rowId, 'the first Look control has one choice only');
          await control.selectOption(other);
        } else if (kind === 'checkbox') {
          await control.click();
        } else {
          const range = await control.evaluate(readInputRange);
          await control.fill(String(pickOtherValue(range)));
        }
        await approveLook(page);
        await previewShot(page, ctx, rowId, 'look-updated');
        const exported = await exportAndProbe(
          page,
          ctx,
          rowId,
          { tag: 'look-updated' },
          deps.export,
        );
        return `a control of ${flow.title} changed and the update was approved; ${exported.message}`;
      }
      if (name === 'reset') {
        const reset = page.locator(FX_SEL.appliedReset).first();
        if (!(await reset.isVisible().catch(() => false))) {
          throw notReachable(
            rowId,
            'the panel offers Reset only after a binding is hand-edited; no hand edit was made',
          );
        }
        await reset.click();
        await approveLook(page);
        await previewShot(page, ctx, rowId, 'look-reset');
        const exported = await exportAndProbe(page, ctx, rowId, { tag: 'look-reset' }, deps.export);
        return `${flow.title} reset to its Look control; ${exported.message}`;
      }
      const before = await appliedCount(page);
      await page.locator(FX_SEL.appliedDetach).first().click();
      await page.waitForTimeout(300);
      const detached = await page.locator(FX_SEL.appliedLook).count();
      if (detached !== before - 1)
        throw new Error(`Detach left ${detached} Look(s), expected ${before - 1}`);
      await previewShot(page, ctx, rowId, 'look-detached');
      await blurFocus(page);
      await page.keyboard.press('Control+KeyZ');
      const restored = await page.locator(FX_SEL.appliedLook).count();
      if (restored !== before)
        throw new Error(`Undo after Detach left ${restored} Look(s), expected ${before}`);
      await page.locator(FX_SEL.appliedDetach).first().click();
      const exported = await exportAndProbe(
        page,
        ctx,
        rowId,
        { tag: 'look-detached' },
        deps.export,
      );
      return `Detach removed the Look and one Undo restored it; detached again; ${exported.message}`;
    },
  );
  return outcome;
}

export const EFFECTS_LOOKS_ROWS = [
  {
    id: 'D-057',
    area: 'Inspector, Effects tab',
    expected: 'The effect is stored in the clip; the export shows it',
    needs: ['clip', 'export'],
    run: effectsAddChangeRemove,
  },
  {
    id: 'D-058',
    area: 'Inspector, Audio tab',
    expected: "The values are stored; the export's audio follows",
    needs: ['clip-with-audio', 'export'],
    run: clipAudioControls,
  },
  {
    id: 'D-070',
    area: 'Joy Code Looks',
    expected: 'Each action changes the clip as described; detach leaves the clip as it was before',
    needs: ['clip', 'text-element', 'export'],
    run: joyCodeLooks,
  },
];
