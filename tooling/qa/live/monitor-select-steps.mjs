/* global document */
/**
 * T-M04 driver cases (click to select on the Monitor). They need a running
 * app through the T-A02 driver (`driver.mjs`): call them with the Playwright
 * `page` of a live session that has a project open in the editor. Not wired
 * into `run.mjs` (that file belongs to T-A02); a runner adds them by id.
 * Not run yet: they need the app launched.
 *
 *   D-M04-1 for each element kind, a timeline click outlines it on the Monitor
 *           and a Monitor click selects the same clip on the timeline
 *
 * `clips` names one timeline clip per kind, e.g.
 *   { video: 'clip-a', picture: 'clip-b', text: 'clip-c', shape: 'clip-d', caption: 'clip-e' }
 * (the 3D element may be given as `three-d`). The project must place each
 * element so the centre of its box is not covered by another element, or the
 * Monitor click would rightly select the one on top.
 */

const VIEWPORT = '.monitor-canvas-wrap';
const OUTLINE = '.monitor-selection-overlay polygon';

function timelineClip(page, clipId) {
  return page.locator(`.timeline-clip[data-clip-id="${clipId}"]`).first();
}

async function selectedOnTimeline(page) {
  return page
    .locator('.timeline-clip[data-clip-id][aria-pressed="true"]')
    .evaluateAll((clips) => clips.map((clip) => clip.getAttribute('data-clip-id')));
}

async function outlinedOnMonitor(page) {
  return page
    .locator(OUTLINE)
    .evaluateAll((outlines) => outlines.map((outline) => outline.getAttribute('data-clip-id')));
}

/** Screen centre of the outline drawn for `clipId` (the element's box). */
async function outlineCentre(page, clipId) {
  const box = await page.locator(`${OUTLINE}[data-clip-id="${clipId}"]`).first().boundingBox();
  if (box === null) throw new Error(`no outline on the Monitor for ${clipId}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A point in the viewport outside the frame (empty canvas), when the frame does not fill it. */
async function emptyPoint(page) {
  const box = await page.locator(VIEWPORT).boundingBox();
  if (box === null) throw new Error('the Monitor viewport is not on screen');
  return { x: box.x + 4, y: box.y + 4 };
}

/** One kind: timeline -> Monitor, then Monitor -> timeline. */
async function roundTrip(page, kind, clipId) {
  await timelineClip(page, clipId).click();
  const outlined = await outlinedOnMonitor(page);
  if (!outlined.includes(clipId))
    throw new Error(
      `${kind}: the timeline selected ${clipId} but the Monitor outlines ${outlined}`,
    );
  const centre = await outlineCentre(page, clipId);

  // A click on empty canvas deselects (Fit zoom leaves a margin around the frame).
  await page.keyboard.press('Control+0');
  const empty = await emptyPoint(page);
  await page.mouse.click(empty.x, empty.y);
  const afterEmpty = await selectedOnTimeline(page);
  if (afterEmpty.length !== 0)
    throw new Error(`${kind}: a click on empty canvas left ${afterEmpty} selected`);

  await page.mouse.click(centre.x, centre.y);
  const onTimeline = await selectedOnTimeline(page);
  const onMonitor = await outlinedOnMonitor(page);
  if (onTimeline.length !== 1 || onTimeline[0] !== clipId)
    throw new Error(
      `${kind}: the Monitor click selected ${onTimeline} on the timeline, not ${clipId}`,
    );
  if (!onMonitor.includes(clipId))
    throw new Error(`${kind}: the Monitor click did not outline ${clipId}`);
  return `${kind} ${clipId}: same id in both places`;
}

/** D-M04-1: five (or six) element kinds, the same selected id on the timeline and the Monitor. */
export async function selectBothWays(page, clips) {
  const kinds = Object.entries(clips ?? {});
  if (kinds.length < 5) throw new Error('give at least five element kinds with their clip ids');
  const results = [];
  for (const [kind, clipId] of kinds) results.push(await roundTrip(page, kind, clipId));
  const focus = await page.evaluate(() => document.activeElement?.tagName ?? '');
  return `${results.join('; ')} (focus on ${focus})`;
}

export const MONITOR_SELECT_CASES = {
  'D-M04-1': selectBothWays,
};
