/* global document */
/**
 * T-M12 driver case (keyboard only on the Monitor). It needs a running app through
 * the T-A02 driver: call it with the Playwright `page` of a live session that has a
 * project open with one visual element on the timeline. Not wired into `run.mjs`
 * (that file belongs to T-A02); a runner adds it by id. Not run yet: the app is not
 * launched for this card.
 *
 *   D-M12-1 Tab reaches the picture, Tab selects the element, arrows move it (1 px,
 *           Shift 10 px), Alt+arrows scale it, [ and ] rotate it, and Esc leaves.
 *           No mouse is used. The timeline and the Monitor outline must agree.
 *
 * `clipId` is the timeline clip of the element (the only visible element).
 */

const STAGE = '[data-monitor-stage]';
const OUTLINE = '.monitor-selection-overlay polygon';

async function focusStage(page) {
  for (let presses = 0; presses < 60; presses += 1) {
    const onStage = await page.evaluate(
      (selector) => document.activeElement?.matches(selector) === true,
      STAGE,
    );
    if (onStage) return presses;
    await page.keyboard.press('Tab');
  }
  throw new Error('Tab never reached the Monitor picture in 60 presses');
}

async function selectedOnTimeline(page) {
  return page
    .locator('.timeline-clip[data-clip-id][aria-pressed="true"]')
    .evaluateAll((clips) => clips.map((clip) => clip.getAttribute('data-clip-id')));
}

async function outline(page, clipId) {
  const handle = page.locator(`${OUTLINE}[data-clip-id="${clipId}"]`).first();
  const box = await handle.boundingBox();
  if (box === null) throw new Error(`no outline on the Monitor for ${clipId}`);
  return {
    box,
    points: await handle.getAttribute('points'),
  };
}

/** Presses one key and returns the outline before and after it. */
async function press(page, clipId, keys) {
  const before = await outline(page, clipId);
  await page.keyboard.press(keys);
  const after = await outline(page, clipId);
  return { before, after };
}

export async function keyboardOnly(page, { clipId }) {
  if (typeof clipId !== 'string') throw new Error('give the timeline clip id of the element');

  const presses = await focusStage(page);

  await page.keyboard.press('Tab');
  const selected = await selectedOnTimeline(page);
  if (selected.length !== 1 || selected[0] !== clipId)
    throw new Error(`Tab selected ${selected} on the timeline, not ${clipId}`);

  const moved = await press(page, clipId, 'ArrowRight');
  if (!(moved.after.box.x > moved.before.box.x))
    throw new Error('ArrowRight did not move the element right');
  const movedFar = await press(page, clipId, 'Shift+ArrowRight');
  if (!(movedFar.after.box.x - movedFar.before.box.x > moved.after.box.x - moved.before.box.x))
    throw new Error('Shift+ArrowRight did not move further than one arrow press');

  const grown = await press(page, clipId, 'Alt+ArrowUp');
  if (!(grown.after.box.width > grown.before.box.width))
    throw new Error('Alt+ArrowUp did not scale the element up');

  const turned = await press(page, clipId, ']');
  if (turned.after.points === turned.before.points) throw new Error('] did not rotate the element');

  await page.keyboard.press('Escape');
  const stillOnStage = await page.evaluate(
    (selector) => document.activeElement?.matches(selector) === true,
    STAGE,
  );
  if (stillOnStage) throw new Error('Esc did not leave the Monitor picture');

  return `Tab reached the picture after ${presses} presses; arrow, Shift, Alt scale, ] rotate and Esc all worked without the mouse`;
}

export const MONITOR_KEYBOARD_CASES = {
  'D-M12-1': keyboardOnly,
};
