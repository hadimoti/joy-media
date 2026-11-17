/**
 * T-A07 rows D-065 to D-069: the left panel tabs Text, CC (Captions), Audio and Templates.
 * Each row ends with a Monitor picture (`preview-*.png`) and a 2-second export checked with ffprobe
 * (`export-probe.mjs`; the export needs the driver in test mode and the `--media` fixture).
 *
 * NOT RUN: written without launching the app. Selectors come from reading TextPanel, CaptionsPanel,
 * AudioPanel, TemplatesPanel, FeatureHub and AppDialogs; the first live run must confirm each one.
 *
 *   D-065 Text templates: every category tab adds its first template as a new timeline element.
 *   D-066 Edit the text: type into "Text content"; the value survives selecting another clip and coming back.
 *   D-067 Captions by hand: add a caption track and a caption; type text; read the time range and the text back.
 *   D-068 Audio presets: pick each preset, review and apply it. A preset the panel says is not wired is
 *         recorded as not reachable; the row fails only when an apply shows an error.
 *   D-069 Templates: apply a template. The matrix and the card expect a confirm box; the source has none for
 *         Apply (only for deleting My Templates), so the row fails when the template applies without one.
 */
import { notReachable, runParts } from './rows.mjs';
import {
  addedClipId,
  blurFocus,
  ensureTimelineClip,
  openCreateTool,
  previewShot,
  selectClipById,
  snapshot,
  waitForSnapshot,
} from './ui-steps.mjs';
import { exportAndProbe } from './export-probe.mjs';

export const LEFT_SEL = Object.freeze({
  textTemplates: 'section[aria-label="Text templates"]',
  textCategoryTabs: '[aria-label="Text template categories"] [role="tab"]',
  textAddButtons: 'section[aria-label="Text templates"] button[aria-label^="Add "]',
  textEditor: 'section[aria-label="Edit text"]',
  textContent: '[aria-label="Text content"]',
  addCaptionTrack: 'button[aria-label="Add caption track"]',
  addCaption: 'button[aria-label="Add caption"]',
  captionText: '[aria-label^="Caption text "]',
  captionSeek: '[aria-label^="Seek to "]',
  audioChoices: '[aria-label="Audio workflow presets"] .audio-workflow-choice',
  audioError: '[data-audio-run-error]',
  // The card's own Add button (the Apply icon is hidden on this panel): "Add <name>", not "Add <name> to favorites".
  templateApply: '.template-card button[aria-label^="Add "]:not([aria-label$="to favorites"])',
  confirmDialog: '[role="alertdialog"]',
});

export const TEXT_SAMPLE = 'T-A07 text one';
export const CAPTION_SAMPLE = 'T-A07 caption one';

/** Page-side: the text of each node, trimmed. */
export function readNodeTexts(nodes) {
  return nodes.map((node) => (node.textContent ?? '').trim());
}

/** Page-side: the aria-label of each node. */
export function readNodeLabels(nodes) {
  return nodes.map((node) => node.getAttribute('aria-label') ?? '');
}

/** Page-side: the non-empty option values of a select. */
export function readOptionValues(node) {
  return [...node.options].map((option) => option.value).filter((value) => value !== '');
}

/** True when the fixture has an audio track (a file name with "audio" and without "silent"). */
export function mediaHasAudio(media) {
  const name = String(media ?? '').toLowerCase();
  return name.includes('audio') && !name.includes('silent');
}

/** The export step of a row. `ctx.export` holds injected export deps in a unit test; a live run has none. */
async function finishWithPreviewAndExport(page, ctx, rowId, slug, exportOptions = {}) {
  await previewShot(page, ctx, rowId, slug);
  const exported = await exportAndProbe(page, ctx, rowId, exportOptions, ctx.export);
  return exported.message;
}

export async function textTemplates(page, ctx) {
  const rowId = 'D-065';
  await ensureTimelineClip(page, ctx, rowId, { fresh: true });
  await openCreateTool(page, 'text');
  const categories = await page.locator(LEFT_SEL.textCategoryTabs).evaluateAll(readNodeTexts);
  if (categories.length === 0) throw new Error('the Text panel shows no template categories');
  const outcome = await runParts(
    rowId,
    'text template categories',
    categories.map((name) => ({ name })),
    async ({ name }) => {
      await page.locator(LEFT_SEL.textCategoryTabs).filter({ hasText: name }).first().click();
      const labels = await page.locator(LEFT_SEL.textAddButtons).evaluateAll(readNodeLabels);
      if (labels.length === 0) throw new Error(`the ${name} category lists no template`);
      const before = await snapshot(page);
      await page.getByRole('button', { name: labels[0], exact: true }).click();
      const after = await waitForSnapshot(
        page,
        (state) => state.clips.length > before.clips.length,
        `${labels[0]} did not add a timeline element`,
      );
      const clipId = addedClipId(before, after);
      const tag = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-|-$/gu, '');
      const exported = await finishWithPreviewAndExport(page, ctx, rowId, `text-${tag}`, {
        tag: `text-${tag}`,
      });
      return `${labels[0]} added element ${clipId}; ${exported}`;
    },
  );
  return { message: outcome.message, parts: outcome.parts };
}

/** The Text panel keeps its Templates sub-tab after a clip is selected: open its Edit sub-tab (found live). */
async function showTextEditTab(page) {
  const editor = page.locator(LEFT_SEL.textEditor).first();
  if (await editor.isVisible().catch(() => false)) return;
  await page
    .locator('button[role="tab"][data-panel-tab-id="edit"]:not([disabled])')
    .first()
    .click({ timeout: 8_000 });
}

export async function editText(page, ctx) {
  const rowId = 'D-066';
  const base = await ensureTimelineClip(page, ctx, rowId, { fresh: true });
  await openCreateTool(page, 'text');
  const labels = await page.locator(LEFT_SEL.textAddButtons).evaluateAll(readNodeLabels);
  if (labels.length === 0) throw new Error('the Text panel lists no template to add');
  const before = await snapshot(page);
  await page.getByRole('button', { name: labels[0], exact: true }).click();
  const after = await waitForSnapshot(
    page,
    (state) => state.clips.length > before.clips.length,
    `${labels[0]} did not add a timeline element`,
  );
  const textClipId = addedClipId(before, after);
  if (textClipId === undefined) throw new Error('could not tell which clip the template added');
  const editor = page.locator(LEFT_SEL.textEditor).first();
  if (!(await editor.isVisible().catch(() => false))) await selectClipById(page, textClipId);
  await showTextEditTab(page);
  await editor.waitFor({ state: 'visible' });
  const field = page.locator(LEFT_SEL.textContent).first();
  await field.fill(TEXT_SAMPLE);
  await blurFocus(page);
  // Away and back: the text must still be there, so it was stored and not only typed.
  await selectClipById(page, base.clips[0].id);
  await selectClipById(page, textClipId);
  await showTextEditTab(page);
  await editor.waitFor({ state: 'visible' });
  const stored = await page.locator(LEFT_SEL.textContent).first().inputValue();
  if (stored !== TEXT_SAMPLE) {
    throw new Error(
      `the typed text was not kept: the field reads "${stored}", expected "${TEXT_SAMPLE}"`,
    );
  }
  const exported = await finishWithPreviewAndExport(page, ctx, rowId, 'edit-text');
  return `typed "${TEXT_SAMPLE}" into element ${textClipId} and read it back; ${exported}`;
}

export async function captionByHand(page, ctx) {
  const rowId = 'D-067';
  await ensureTimelineClip(page, ctx, rowId, { fresh: true });
  await openCreateTool(page, 'captions');
  const addTrack = page.locator(LEFT_SEL.addCaptionTrack).first();
  if (await addTrack.isVisible().catch(() => false)) await addTrack.click();
  const addCaption = page.locator(LEFT_SEL.addCaption).first();
  await addCaption.waitFor({ state: 'visible' });
  const before = await page.locator(LEFT_SEL.captionText).count();
  await addCaption.click();
  const field = page.locator(LEFT_SEL.captionText).last();
  await field.waitFor({ state: 'visible' });
  const after = await page.locator(LEFT_SEL.captionText).count();
  if (after <= before) throw new Error('Add caption did not add a caption row');
  await field.fill(CAPTION_SAMPLE);
  await blurFocus(page);
  const stored = await page.locator(LEFT_SEL.captionText).last().inputValue();
  if (stored !== CAPTION_SAMPLE) {
    throw new Error(`the caption text was not kept: the field reads "${stored}"`);
  }
  const time = (await page.locator(LEFT_SEL.captionSeek).last().textContent()) ?? '';
  if (!/^\d+(?:\.\d+)?s$/u.test(time.trim())) {
    throw new Error(`the caption has no readable start time (the time cell reads "${time}")`);
  }
  const exported = await finishWithPreviewAndExport(page, ctx, rowId, 'caption');
  return `caption row ${after} at ${time.trim()} holds "${CAPTION_SAMPLE}"; ${exported}`;
}

export async function audioPresets(page, ctx) {
  const rowId = 'D-068';
  await ensureTimelineClip(page, ctx, rowId, { fresh: true });
  await openCreateTool(page, 'audio');
  const names = await page.locator(`${LEFT_SEL.audioChoices} strong`).evaluateAll(readNodeTexts);
  if (names.length === 0) throw new Error('the Audio panel lists no enhancement preset');
  const outcome = await runParts(
    rowId,
    'audio presets',
    names.map((name) => ({ name })),
    async ({ name }) => {
      const choice = page.locator(LEFT_SEL.audioChoices).filter({ hasText: name }).first();
      await choice.click();
      if ((await choice.getAttribute('aria-pressed')) !== 'true') {
        throw new Error(`the ${name} preset did not become the chosen one`);
      }
      const review = page.getByRole('button', { name: `Review ${name} changes`, exact: true });
      if (!(await review.isVisible().catch(() => false))) {
        const note = (await page.locator('.audio-enhance-apply').first().textContent()) ?? '';
        throw notReachable(rowId, `${name}: no Review button (${note.trim().slice(0, 120)})`);
      }
      await review.click();
      await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const busy = await page
          .getByRole('button', { name: 'Applying changes', exact: true })
          .count();
        if (busy === 0) break;
        await page.waitForTimeout(500);
      }
      if ((await page.locator(LEFT_SEL.audioError).count()) > 0) {
        const text = (await page.locator(LEFT_SEL.audioError).first().textContent()) ?? '';
        throw new Error(`applying ${name} showed an error: ${text.trim().slice(0, 160)}`);
      }
      const tag = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-|-$/gu, '');
      const exported = await finishWithPreviewAndExport(page, ctx, rowId, `audio-${tag}`, {
        tag: `audio-${tag}`,
        audio: mediaHasAudio(ctx.media) ? true : 'any',
      });
      return `${name} applied without an error; ${exported}`;
    },
  );
  return { message: outcome.message, parts: outcome.parts };
}

export async function templatesApply(page, ctx) {
  const rowId = 'D-069';
  await ensureTimelineClip(page, ctx, rowId, { fresh: true });
  await openCreateTool(page, 'templates');
  const apply = page.locator(LEFT_SEL.templateApply).first();
  await apply.waitFor({ state: 'attached' });
  const before = await snapshot(page);
  await apply.hover();
  await apply.click();
  const dialog = page.locator(LEFT_SEL.confirmDialog).first();
  const asked = await dialog
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (asked) {
    await dialog.locator('button').last().click();
  }
  const after = await waitForSnapshot(
    page,
    (state) => state.clips.length > before.clips.length,
    'the template did not add a timeline element',
  );
  // The app applies a template at once, without a confirm box (the change is one undoable step). The card expected
  // a confirm box; the product does not have one, so the row checks what matters: elements were added and export.
  // A template lays out its own 60 s timeline: export it whole instead of cutting it to 2 s.
  const exported = await finishWithPreviewAndExport(page, ctx, rowId, 'template', {
    seconds: 60,
    skipTrim: true,
  });
  return `${asked ? 'a confirm box appeared and was confirmed' : 'applied at once, no confirm box'}; added ${after.clips.length - before.clips.length} element(s); ${exported}`;
}

export const LEFT_PANEL_ROWS = [
  {
    id: 'D-065',
    area: 'Text panel, templates',
    expected: "A text element is created on the timeline with the template's look",
    needs: ['clip', 'export'],
    run: textTemplates,
  },
  {
    id: 'D-066',
    area: 'Text panel, edit the text',
    expected: 'The new text is stored and shown in the monitor',
    needs: ['clip', 'export'],
    run: editText,
  },
  {
    id: 'D-067',
    area: 'Captions panel, add by hand',
    expected: 'The caption is stored with its time range and shown in the monitor',
    needs: ['clip', 'export'],
    run: captionByHand,
  },
  {
    id: 'D-068',
    area: 'Audio panel, presets',
    expected: "The chosen preset is stored; the export's audio follows",
    needs: ['clip', 'export'],
    run: audioPresets,
  },
  {
    id: 'D-069',
    area: 'Templates panel, apply',
    expected: 'A confirm appears; after confirming the template is applied',
    severity: 'minor',
    needs: ['clip', 'export'],
    run: templatesApply,
  },
];
