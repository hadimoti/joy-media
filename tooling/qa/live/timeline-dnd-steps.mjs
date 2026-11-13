/* global document */
/**
 * T-H03 live driver steps. Each drag uses Playwright mouse move/down/move/up,
 * which sends real pointer events through the editor. They require an already
 * running app and a project seeded with the ids passed to the step. These steps
 * are intentionally not wired into `run.mjs` and have not been run here.
 */

function quoted(value) {
  return JSON.stringify(String(value));
}

function assetCard(assetId) {
  return `.asset-card[data-asset-id=${quoted(assetId)}]`;
}

function timelineClip(clipId) {
  return `.timeline-clip[data-clip-id=${quoted(clipId)}]`;
}

function timelineTrack(trackId) {
  return `.timeline-lane[data-track-id=${quoted(trackId)}]`;
}

async function box(page, selector) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible' });
  const result = await locator.boundingBox();
  if (result === null) throw new Error(`no visible drag target: ${selector}`);
  return result;
}

function pointIn(rect, fraction = { x: 0.5, y: 0.5 }) {
  return {
    x: rect.x + rect.width * fraction.x,
    y: rect.y + rect.height * fraction.y,
  };
}

/** Drag with actual pointer moves, including intermediate moves past the 4 px threshold. */
async function dragTo(page, sourceSelector, targetSelector, options = {}) {
  const source = pointIn(await box(page, sourceSelector), options.sourceFraction);
  const target = pointIn(await box(page, targetSelector), options.targetFraction);
  const modifier = options.modifier;
  if (modifier !== undefined) await page.keyboard.down(modifier);
  try {
    await page.mouse.move(source.x, source.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: options.steps ?? 10 });
    await page.mouse.up();
  } finally {
    if (modifier !== undefined) await page.keyboard.up(modifier);
  }
  return { source, target };
}

async function waitForAttribute(page, selector, name, value) {
  await page.waitForFunction(
    ({ selector: query, name: attribute, value: expected }) =>
      document.querySelector(query)?.getAttribute(attribute) === expected,
    { selector, name, value: String(value) },
  );
}

async function clipStart(page, clipId) {
  const value = await page.locator(timelineClip(clipId)).getAttribute('data-start-us');
  if (value === null) throw new Error(`timeline clip ${clipId} has no start time`);
  return Number(value);
}

async function clipPosition(page, clipId) {
  return page.locator(timelineClip(clipId)).evaluate((clip) => {
    const startUs = Number(clip.getAttribute('data-start-us'));
    const trackId = clip.closest('.timeline-track')?.getAttribute('data-track-id');
    if (!Number.isFinite(startUs) || trackId === null || trackId === undefined)
      throw new Error(`timeline clip ${clipId} has incomplete position data`);
    return { startUs, trackId };
  });
}

async function selectedClipIds(page) {
  return page
    .locator('.timeline-clip[aria-pressed="true"][data-clip-id]')
    .evaluateAll((clips) => clips.map((clip) => clip.getAttribute('data-clip-id')));
}

async function openInspectorEffects(page) {
  const toggle = page.locator('.inspector-section-toggle').filter({ hasText: 'Effects' }).first();
  if (await toggle.isVisible().catch(() => false)) {
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  }
}

/** D-H03-1: Media card -> an existing compatible track. */
export async function mediaToTrack(page, { assetId, trackId }) {
  await dragTo(page, assetCard(assetId), timelineTrack(trackId));
  const inserted = `.timeline-track[data-track-id=${quoted(trackId)}] .timeline-clip[data-asset-id=${quoted(assetId)}]`;
  await page.locator(inserted).waitFor({ state: 'visible' });
  return `media ${assetId} inserted on ${trackId}`;
}

/** D-H03-2: Ctrl/Command + Media card -> clip inserts and moves later clips. */
export async function ctrlInsertMedia(page, { assetId, targetClipId, durationUs }) {
  const before = await clipStart(page, targetClipId);
  await dragTo(page, assetCard(assetId), timelineClip(targetClipId), { modifier: 'Control' });
  await waitForAttribute(page, timelineClip(targetClipId), 'data-start-us', before + durationUs);
  await page
    .locator(`.timeline-clip[data-asset-id=${quoted(assetId)}]`)
    .waitFor({ state: 'visible' });
  return `Ctrl insert shifted ${targetClipId} by ${durationUs} us`;
}

/** D-H03-3: Alt + Media card -> clip replaces its asset without changing its id or start. */
export async function altReplaceMedia(page, { assetId, clipId }) {
  const before = await clipStart(page, clipId);
  await dragTo(page, assetCard(assetId), timelineClip(clipId), { modifier: 'Alt' });
  await waitForAttribute(page, timelineClip(clipId), 'data-asset-id', assetId);
  await waitForAttribute(page, timelineClip(clipId), 'data-start-us', before);
  return `Alt replace kept ${clipId} and its start`;
}

/** D-H03-4: Move one clip in time and across compatible tracks. */
export async function moveClipAcrossTrack(page, { clipId, targetTrackId, targetFraction }) {
  await dragTo(page, timelineClip(clipId), timelineTrack(targetTrackId), { targetFraction });
  const clip = page.locator(timelineClip(clipId));
  await page.waitForFunction(
    ({ clipId: id, trackId }) =>
      document
        .querySelector(`.timeline-clip[data-clip-id=${JSON.stringify(id)}]`)
        ?.closest('.timeline-track')
        ?.getAttribute('data-track-id') === trackId,
    { clipId, trackId: targetTrackId },
  );
  const value = await clip.getAttribute('data-start-us');
  return `clip ${clipId} moved to ${targetTrackId} at ${value} us`;
}

/** D-H03-5: Ctrl-select a group, then move it as one timeline transaction. */
export async function moveClipGroup(page, { clipIds, primaryClipId, targetFraction }) {
  await page.keyboard.down('Control');
  try {
    for (const clipId of clipIds) await page.locator(timelineClip(clipId)).click();
  } finally {
    await page.keyboard.up('Control');
  }
  const before = await Promise.all(
    clipIds.map(async (clipId) => ({
      clipId,
      ...(await clipPosition(page, clipId)),
    })),
  );
  const pixelsPerSecond = Number(await page.getByLabel('Timeline zoom').inputValue());
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0)
    throw new Error('Timeline zoom has an invalid pixels-per-second value');
  const trackSelector = await timelineTrackForClip(page, primaryClipId);
  const { source, target } = await dragTo(page, timelineClip(primaryClipId), trackSelector, {
    targetFraction,
  });
  const expectedDeltaUs = Math.round(((target.x - source.x) / pixelsPerSecond) * 1_000_000);
  const snapToleranceUs = Math.ceil((8 * 1_000_000) / pixelsPerSecond) + 1;
  await page.waitForFunction(
    ({ clips, deltaUs, toleranceUs }) =>
      clips.every(({ clipId, startUs, trackId }) => {
        const clip = document.querySelector(
          `.timeline-clip[data-clip-id=${JSON.stringify(clipId)}]`,
        );
        const actualStartUs = Number(clip?.getAttribute('data-start-us'));
        const actualTrackId = clip?.closest('.timeline-track')?.getAttribute('data-track-id');
        return (
          Number.isFinite(actualStartUs) &&
          Math.abs(actualStartUs - Math.max(0, startUs + deltaUs)) <= toleranceUs &&
          actualTrackId === trackId
        );
      }),
    { clips: before, deltaUs: expectedDeltaUs, toleranceUs: snapToleranceUs },
  );
  const primaryBefore = before.find(({ clipId }) => clipId === primaryClipId);
  if (primaryBefore === undefined) throw new Error(`primary clip ${primaryClipId} is not in group`);
  const primaryAfter = await clipPosition(page, primaryClipId);
  const committedDeltaUs = primaryAfter.startUs - primaryBefore.startUs;
  for (const expected of before) {
    const actual = await clipPosition(page, expected.clipId);
    if (actual.startUs !== expected.startUs + committedDeltaUs)
      throw new Error(`group member ${expected.clipId} did not move by the primary clip delta`);
    if (actual.trackId !== expected.trackId)
      throw new Error(
        `group member ${expected.clipId} moved to unexpected track ${actual.trackId}`,
      );
  }
  for (const clipId of clipIds) {
    const isSelected = await page.locator(timelineClip(clipId)).getAttribute('aria-pressed');
    if (isSelected !== 'true') throw new Error(`group member ${clipId} lost its selection`);
  }
  return `moved ${clipIds.length} selected clips as a group`;
}

async function timelineTrackForClip(page, clipId) {
  return page.locator(timelineClip(clipId)).evaluate((clip) => {
    const trackId = clip.closest('.timeline-track')?.getAttribute('data-track-id');
    if (trackId === null || trackId === undefined) throw new Error('clip has no track');
    return `.timeline-lane[data-track-id=${JSON.stringify(trackId)}]`;
  });
}

/** D-H03-6: Media card -> Monitor adds the asset at the current playhead. */
export async function mediaToMonitor(page, { assetId }) {
  await dragTo(page, assetCard(assetId), '.monitor-canvas-wrap');
  const inserted = `.timeline-clip[data-asset-id=${quoted(assetId)}]`;
  await page.locator(inserted).waitFor({ state: 'visible' });
  return `media ${assetId} added from the Monitor`;
}

/** D-H03-7: Effect card -> timeline clip. */
export async function effectToClip(page, { effectId, clipId }) {
  const source = `.effect-card[data-effect-id=${quoted(effectId)}]`;
  await dragTo(page, source, timelineClip(clipId));
  await openInspectorEffects(page);
  await page.locator(`.inspector-effect-item[data-effect-id=${quoted(effectId)}]`).waitFor({
    state: 'visible',
  });
  return `effect ${effectId} applied to ${clipId}`;
}

/** D-H03-8: Effect card -> Monitor, using the selected timeline clip. */
export async function effectToMonitor(page, { effectId }) {
  const source = `.effect-card[data-effect-id=${quoted(effectId)}]`;
  await dragTo(page, source, '.monitor-canvas-wrap');
  await openInspectorEffects(page);
  await page.locator(`.inspector-effect-item[data-effect-id=${quoted(effectId)}]`).waitFor({
    state: 'visible',
  });
  return `effect ${effectId} applied from the Monitor`;
}

/** D-H03-9: Transition card -> the cut between the given clips. */
export async function transitionToCut(page, { transitionId, leftClipId, rightClipId }) {
  const target = `.timeline-transition-junction[data-editor-pointer-dnd-target="timeline-cut"][data-left-clip-id=${quoted(leftClipId)}][data-right-clip-id=${quoted(rightClipId)}]`;
  await dragTo(page, `.transition-card[data-transition-type=${quoted(transitionId)}]`, target);
  await page.locator(`${target}[data-transition-type=${quoted(transitionId)}]`).waitFor({
    state: 'visible',
  });
  return `transition ${transitionId} applied at ${leftClipId}/${rightClipId}`;
}

/** D-H03-10: Escape cancels a clip drag and restores the previous selection. */
export async function escapeCancelsClipMove(page, { clipId, targetTrackId }) {
  const beforeStart = await clipStart(page, clipId);
  const beforeSelection = await selectedClipIds(page);
  const source = pointIn(await box(page, timelineClip(clipId)));
  const target = pointIn(await box(page, timelineTrack(targetTrackId)));
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await waitForAttribute(page, timelineClip(clipId), 'data-start-us', beforeStart);
  const afterSelection = await selectedClipIds(page);
  if (JSON.stringify(afterSelection) !== JSON.stringify(beforeSelection))
    throw new Error(`Escape changed selection from ${beforeSelection} to ${afterSelection}`);
  return `Escape restored ${clipId} and the prior selection`;
}

/** D-H03-11: A held drag near the timeline edge keeps auto-scrolling. */
export async function edgeAutoScroll(page, { assetId, edge = 'right', holdMs = 500 }) {
  const scroller = '.timeline-tracks';
  const before = await page.locator(scroller).evaluate((element) => element.scrollLeft);
  const source = pointIn(await box(page, assetCard(assetId)));
  const viewport = await box(page, scroller);
  const x = edge === 'left' ? viewport.x + 2 : viewport.x + viewport.width - 2;
  const y = Math.min(viewport.y + viewport.height - 20, Math.max(viewport.y + 20, source.y));
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  try {
    await page.mouse.move(x, y, { steps: 12 });
    await page.waitForTimeout(holdMs);
    const after = await page.locator(scroller).evaluate((element) => element.scrollLeft);
    if (edge === 'right' ? after <= before : after >= before)
      throw new Error(`timeline did not scroll ${edge} while the pointer was held at its edge`);
  } finally {
    await page.keyboard.press('Escape');
    await page.mouse.up();
  }
  return `timeline auto-scrolled ${edge}`;
}

export const TIMELINE_DND_CASES = {
  'D-H03-1': mediaToTrack,
  'D-H03-2': ctrlInsertMedia,
  'D-H03-3': altReplaceMedia,
  'D-H03-4': moveClipAcrossTrack,
  'D-H03-5': moveClipGroup,
  'D-H03-6': mediaToMonitor,
  'D-H03-7': effectToClip,
  'D-H03-8': effectToMonitor,
  'D-H03-9': transitionToCut,
  'D-H03-10': escapeCancelsClipMove,
  'D-H03-11': edgeAutoScroll,
};
