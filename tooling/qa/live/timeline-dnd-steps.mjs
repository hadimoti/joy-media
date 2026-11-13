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

const SNAP_TOLERANCE_PX = 8;
/** A requested drag must be at least this many snap tolerances long before it is sent. */
const MIN_REQUEST_TOLERANCES = 4;
/** Group drags request this distance, which is well beyond the snap tolerance. */
const GROUP_DRAG_PX = 40;

/** Snap tolerance in microseconds: 8 px at the current zoom, plus one microsecond of rounding. */
export function snapToleranceUs(pixelsPerSecond) {
  return Math.ceil((SNAP_TOLERANCE_PX * 1_000_000) / pixelsPerSecond) + 1;
}

/** Throws before a drag is sent unless its pixel distance is well beyond the snap tolerance. */
export function assertDragClearsTolerance(requestedPx, toleranceUs, pixelsPerSecond) {
  const tolerancePx = (toleranceUs / 1_000_000) * pixelsPerSecond;
  if (Math.abs(requestedPx) < MIN_REQUEST_TOLERANCES * tolerancePx)
    throw new Error(
      `drag request of ${Math.abs(requestedPx).toFixed(1)} px is under ${MIN_REQUEST_TOLERANCES} × the ${tolerancePx.toFixed(1)} px snap tolerance; a committed move could be zero`,
    );
}

function isPlaced(clip) {
  return clip !== undefined && Number.isFinite(clip.startUs) && typeof clip.trackId === 'string';
}

/**
 * Returns the committed group delta in microseconds. Throws unless the primary clip moved by more
 * than the snap tolerance, every member moved by that same delta, and every member kept its track.
 * `before` and `after` are arrays of { clipId, startUs, trackId }; an unplaced clip has null fields.
 */
export function groupMoveDelta({ before, after, primaryClipId, toleranceUs }) {
  const primaryBefore = before.find(({ clipId }) => clipId === primaryClipId);
  if (primaryBefore === undefined) throw new Error(`primary clip ${primaryClipId} is not in group`);
  const primaryAfter = after.find(({ clipId }) => clipId === primaryClipId);
  if (!isPlaced(primaryAfter))
    throw new Error(`primary clip ${primaryClipId} has no position after the drag`);
  const deltaUs = primaryAfter.startUs - primaryBefore.startUs;
  if (Math.abs(deltaUs) <= toleranceUs)
    throw new Error(
      `group move did not commit: primary clip ${primaryClipId} moved ${deltaUs} us, within the ${toleranceUs} us snap tolerance`,
    );
  for (const expected of before) {
    const actual = after.find(({ clipId }) => clipId === expected.clipId);
    if (!isPlaced(actual))
      throw new Error(`group member ${expected.clipId} has no position after the drag`);
    const memberDeltaUs = actual.startUs - expected.startUs;
    if (memberDeltaUs !== deltaUs)
      throw new Error(
        `group member ${expected.clipId} moved ${memberDeltaUs} us, not the primary delta of ${deltaUs} us`,
      );
    if (actual.trackId !== expected.trackId)
      throw new Error(
        `group member ${expected.clipId} moved to unexpected track ${actual.trackId}`,
      );
  }
  return deltaUs;
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
  const { trackId: beforeTrackId } = await clipPosition(page, clipId);
  if (beforeTrackId === targetTrackId)
    throw new Error(`clip ${clipId} is already on ${targetTrackId}; a drag there proves no move`);
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

/** Reads { clipId, startUs, trackId } for each id in one evaluation; an unplaced clip has null fields. */
async function readClips(page, clipIds) {
  return page.evaluate(
    (ids) =>
      ids.map((clipId) => {
        const clip = document.querySelector(
          `.timeline-clip[data-clip-id=${JSON.stringify(clipId)}]`,
        );
        const startAttribute = clip?.getAttribute('data-start-us') ?? null;
        const startUs = startAttribute === null ? null : Number(startAttribute);
        const trackId = clip?.closest('.timeline-track')?.getAttribute('data-track-id') ?? null;
        return { clipId, startUs: Number.isFinite(startUs) ? startUs : null, trackId };
      }),
    clipIds,
  );
}

/** Polls until the group's committed move passes the checks, then returns its delta. On timeout the last check's error is thrown. */
async function waitForGroupMove(page, before, primaryClipId, toleranceUs, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const after = await readClips(
      page,
      before.map(({ clipId }) => clipId),
    );
    try {
      return groupMoveDelta({ before, after, primaryClipId, toleranceUs });
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await page.waitForTimeout(100);
  }
}

/** Drag distance in px: GROUP_DRAG_PX to the right, or to the left when the lane has no room on the right. */
function groupDragRequestPx(sourceX, lane) {
  if (lane.x + lane.width - sourceX > GROUP_DRAG_PX + 2) return GROUP_DRAG_PX;
  if (sourceX - lane.x > GROUP_DRAG_PX + 2) return -GROUP_DRAG_PX;
  throw new Error(`no room in the lane for a ${GROUP_DRAG_PX} px group drag`);
}

/** D-H03-5: Ctrl-select a group, then drag its primary clip far enough to commit a measurable move. */
export async function moveClipGroup(page, { clipIds, primaryClipId }) {
  if (!clipIds.includes(primaryClipId))
    throw new Error(`primary clip ${primaryClipId} is not in group`);
  await page.keyboard.down('Control');
  try {
    for (const clipId of clipIds) await page.locator(timelineClip(clipId)).click();
  } finally {
    await page.keyboard.up('Control');
  }
  const pixelsPerSecond = Number(await page.getByLabel('Timeline zoom').inputValue());
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0)
    throw new Error('Timeline zoom has an invalid pixels-per-second value');
  const toleranceUs = snapToleranceUs(pixelsPerSecond);
  const before = await Promise.all(
    clipIds.map(async (clipId) => ({
      clipId,
      ...(await clipPosition(page, clipId)),
    })),
  );
  const source = pointIn(await box(page, timelineClip(primaryClipId)));
  const lane = await box(page, await timelineTrackForClip(page, primaryClipId));
  const requestedPx = groupDragRequestPx(source.x, lane);
  assertDragClearsTolerance(requestedPx, toleranceUs, pixelsPerSecond);
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(source.x + requestedPx, source.y, { steps: 10 });
  await page.mouse.up();
  const deltaUs = await waitForGroupMove(page, before, primaryClipId, toleranceUs);
  for (const clipId of clipIds) {
    const isSelected = await page.locator(timelineClip(clipId)).getAttribute('aria-pressed');
    if (isSelected !== 'true') throw new Error(`group member ${clipId} lost its selection`);
  }
  return `moved ${clipIds.length} selected clips by ${deltaUs} us as a group`;
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
