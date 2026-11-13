/**
 * T-M05b driver cases (anchor point, group scale and rotate, keyframe on
 * release). Same shape as `monitor-transform-steps.mjs` (T-M05a): call them
 * with the Playwright `page` of a live session through the T-A02 driver
 * (`driver.mjs`) with a project open in the editor. Not wired into `run.mjs`
 * (that file belongs to T-A02); a runner adds them by id. Written, not run:
 * they need the app launched.
 *
 *   D-M05-3 keyframe on release: with the x stopwatch on, a move on the
 *           Monitor at a new playhead time adds one x key there (y, with its
 *           stopwatch off, changes as a plain value); one Ctrl+Z removes the
 *           key and puts y back
 *   D-M05-4 anchor move: dragging the anchor point to a corner changes the
 *           anchor and the position but not the picture (the box corners stay
 *           put); a rotate then turns about the new anchor; one Ctrl+Z each
 *   D-M05-5 group scale and group rotate: with two elements selected, a group
 *           corner scales both and the group rotate handle turns both, each in
 *           one undo step
 *   D-M05-6 a parent and its child both selected: a move, a group scale and
 *           a group rotate write only the parent; the child's own values stay
 *           as they were and its picture follows the parent exactly once (the
 *           child's box moves by the same amount as the parent's); one Ctrl+Z
 *           each
 *
 * Callbacks given by the runner (the app has no page-side document reader):
 *   readTransform(clipId)  -> { x, y, scaleX, scaleY, rotationDeg, anchorX?, anchorY? }
 *                            the document's static values for the clip's object
 *   readKeyframes(clipId, channel) -> [{ timeUs, value }] or undefined when the
 *                            stopwatch is off
 *   seekTo(timeUs)         -> moves the playhead (for example through the timeline)
 *   select(clipIds)        -> optional: selects several clips; by default the
 *                            first is clicked and the rest Ctrl+clicked on the timeline
 */

const VIEWPORT = '.monitor-canvas-wrap';
const GROUP = 'monitor-group';
const DRAG_PX = 30;

function timelineClip(page, clipId) {
  return page.locator(`.timeline-clip[data-clip-id="${clipId}"]`).first();
}

function handle(page, clipId, name) {
  return page.locator(`[data-monitor-handle="${name}"][data-clip-id="${clipId}"]`).first();
}

function groupHandle(page, name) {
  return page.locator(`[data-monitor-handle="${name}"][data-node-id="${GROUP}"]`).first();
}

function anchor(page, clipId) {
  return page.locator(`[data-monitor-anchor][data-clip-id="${clipId}"]`).first();
}

function box(page, clipId) {
  return page.locator(`.monitor-selection-overlay polygon[data-clip-id="${clipId}"]`).first();
}

async function centreOf(locator, what) {
  const rect = await locator.boundingBox();
  if (rect === null) throw new Error(`${what} is not on screen`);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function drag(page, from, dx, dy, modifiers = []) {
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await page.mouse.up();
  for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
}

/** The screen corners of an element's box, read from the overlay polygon. */
async function corners(page, clipId) {
  return box(page, clipId).evaluate((polygon) => {
    const svg = polygon.ownerSVGElement;
    const matrix = polygon.getScreenCTM();
    return [...polygon.points].map((point) => {
      const p = svg.createSVGPoint();
      p.x = point.x;
      p.y = point.y;
      const s = p.matrixTransform(matrix);
      return { x: s.x, y: s.y };
    });
  });
}

function near(a, b, tolerance) {
  return Math.abs(Number(a ?? 0) - Number(b ?? 0)) <= tolerance;
}

const KEYS = ['x', 'y', 'scaleX', 'scaleY', 'rotationDeg', 'anchorX', 'anchorY'];

function sameTransform(a, b, tolerance = 1e-6) {
  return KEYS.every((key) =>
    key.startsWith('anchor')
      ? near(a[key] ?? 0.5, b[key] ?? 0.5, tolerance)
      : near(a[key], b[key], tolerance),
  );
}

function sameKeys(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function needs(callbacks, ...names) {
  for (const name of names)
    if (typeof callbacks?.[name] !== 'function') throw new Error(`give ${name}(...) to the case`);
}

async function selectClips(page, clipIds, callbacks) {
  if (typeof callbacks.select === 'function') return callbacks.select(clipIds);
  await timelineClip(page, clipIds[0]).click();
  for (const clipId of clipIds.slice(1))
    await timelineClip(page, clipId).click({ modifiers: ['Control'] });
}

/**
 * D-M05-3: keyframe on release. `clipId`'s object must have the x stopwatch
 * on with at least one key, the y stopwatch off, and no key at `timeUs`.
 */
export async function keyframeOnRelease(page, clipId, timeUs, callbacks) {
  needs(callbacks, 'readTransform', 'readKeyframes', 'seekTo');
  const { readTransform, readKeyframes, seekTo } = callbacks;
  const keysBefore = await readKeyframes(clipId, 'x');
  if (!Array.isArray(keysBefore) || keysBefore.length === 0)
    throw new Error('the x stopwatch must be on with at least one key');
  if (keysBefore.some((key) => key.timeUs === timeUs))
    throw new Error(`there is already an x key at ${timeUs}`);
  if ((await readKeyframes(clipId, 'y')) !== undefined)
    throw new Error('the y stopwatch must be off');
  await seekTo(timeUs);
  await timelineClip(page, clipId).click();
  const staticBefore = await readTransform(clipId);
  await drag(page, await centreOf(box(page, clipId), 'the box'), DRAG_PX, DRAG_PX);
  const keysAfter = await readKeyframes(clipId, 'x');
  const added = keysAfter.filter((key) => !keysBefore.some((old) => old.timeUs === key.timeUs));
  if (
    keysAfter.length !== keysBefore.length + 1 ||
    added.length !== 1 ||
    added[0].timeUs !== timeUs
  )
    throw new Error(`release did not add one x key at ${timeUs}: ${JSON.stringify(keysAfter)}`);
  const staticAfter = await readTransform(clipId);
  if (near(staticAfter.y, staticBefore.y, 1e-6))
    throw new Error('y (stopwatch off) did not change');
  if ((await readKeyframes(clipId, 'y')) !== undefined)
    throw new Error('the drag turned the y stopwatch on');
  await page.keyboard.press('Control+z');
  if (!sameKeys(await readKeyframes(clipId, 'x'), keysBefore))
    throw new Error('one undo did not remove the new x key');
  if (!sameTransform(await readTransform(clipId), staticBefore))
    throw new Error('one undo did not put y back');
  return `x key added at ${timeUs} us on release, y written as a value, one undo`;
}

/**
 * D-M05-4: anchor move. `clipId`'s object must be turned (rotation not 0),
 * with no keyframes or expressions on its transform.
 */
export async function anchorMove(page, clipId, callbacks) {
  needs(callbacks, 'readTransform');
  const { readTransform } = callbacks;
  await timelineClip(page, clipId).click();
  const before = await readTransform(clipId);
  const cornersBefore = await corners(page, clipId);
  const point = await centreOf(anchor(page, clipId), 'the anchor point');
  const target = cornersBefore[0];
  await drag(page, point, target.x - point.x, target.y - point.y);
  const after = await readTransform(clipId);
  if (near(after.anchorX ?? 0.5, 0.5, 0.01) && near(after.anchorY ?? 0.5, 0.5, 0.01))
    throw new Error('the anchor did not move');
  if (
    !near(after.rotationDeg, before.rotationDeg, 1e-6) ||
    !near(after.scaleX, before.scaleX, 1e-6)
  )
    throw new Error('moving the anchor changed the rotation or scale');
  const cornersAfter = await corners(page, clipId);
  cornersAfter.forEach((corner, index) => {
    const was = cornersBefore[index];
    if (!near(corner.x, was.x, 1) || !near(corner.y, was.y, 1))
      throw new Error(`moving the anchor moved corner ${index} of the picture`);
  });
  const anchorNow = await centreOf(anchor(page, clipId), 'the moved anchor point');
  if (!near(anchorNow.x, target.x, 2) || !near(anchorNow.y, target.y, 2))
    throw new Error('the anchor point is not where it was dropped');
  // A rotate now turns about the new anchor: the anchor stays put on screen.
  const rotate = await centreOf(handle(page, clipId, 'rotate'), 'the rotate handle');
  await drag(page, rotate, DRAG_PX * 2, 0);
  const pivot = await centreOf(anchor(page, clipId), 'the anchor point after rotate');
  if (!near(pivot.x, anchorNow.x, 2) || !near(pivot.y, anchorNow.y, 2))
    throw new Error('the rotate did not turn about the anchor point');
  await page.keyboard.press('Control+z');
  if (!sameTransform(await readTransform(clipId), after))
    throw new Error('one undo did not undo the rotate');
  await page.keyboard.press('Control+z');
  if (!sameTransform(await readTransform(clipId), before))
    throw new Error('one undo did not undo the anchor move');
  return 'anchor moved to a corner with the picture still, rotate about it, one undo each';
}

/**
 * D-M05-5: group scale and rotate. `clipIds` names two or more clips whose
 * objects have no expressions on their transform and no parent/child link
 * between them.
 */
export async function groupScaleAndRotate(page, clipIds, callbacks) {
  needs(callbacks, 'readTransform');
  const { readTransform } = callbacks;
  if (!Array.isArray(clipIds) || clipIds.length < 2) throw new Error('give two or more clips');
  await selectClips(page, clipIds, callbacks);
  if ((await page.locator(`[data-node-id="${GROUP}"][data-monitor-handle]`).count()) !== 9)
    throw new Error('the group box does not show 8 scale handles and a rotate handle');
  const read = async () => Promise.all(clipIds.map((clipId) => readTransform(clipId)));
  const before = await read();

  const corner = await centreOf(groupHandle(page, 'se'), 'the group se handle');
  await drag(page, corner, DRAG_PX, DRAG_PX, ['Shift']);
  const scaled = await read();
  scaled.forEach((value, index) => {
    if (near(value.scaleX, before[index].scaleX, 1e-6))
      throw new Error(`group scale did not scale ${clipIds[index]}`);
  });
  const ratio = scaled[0].scaleX / before[0].scaleX;
  scaled.forEach((value, index) => {
    if (!near(value.scaleX / before[index].scaleX, ratio, 1e-3))
      throw new Error('group scale did not scale every element by the same factor');
  });
  await page.keyboard.press('Control+z');
  if (!(await read()).every((value, index) => sameTransform(value, before[index])))
    throw new Error('one undo did not undo the group scale');

  const rotate = await centreOf(groupHandle(page, 'rotate'), 'the group rotate handle');
  await drag(page, rotate, DRAG_PX * 3, DRAG_PX, ['Shift']);
  const turned = await read();
  const turn = turned[0].rotationDeg - before[0].rotationDeg;
  if (near(turn, 0, 1e-6) || !near(turn % 15, 0, 1e-6))
    throw new Error(`group rotate with Shift turned ${turn} degrees, not a multiple of 15`);
  turned.forEach((value, index) => {
    if (!near(value.rotationDeg - before[index].rotationDeg, turn, 1e-6))
      throw new Error('group rotate did not turn every element by the same angle');
  });
  await page.keyboard.press('Control+z');
  if (!(await read()).every((value, index) => sameTransform(value, before[index])))
    throw new Error('one undo did not undo the group rotate');
  const viewport = await centreOf(page.locator(VIEWPORT), 'the Monitor viewport');
  await page.mouse.move(viewport.x, viewport.y);
  return `group of ${clipIds.length}: scale x${ratio.toFixed(3)} and rotate ${turn} deg, one undo each`;
}

function centroid(points) {
  const sum = points.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), {
    x: 0,
    y: 0,
  });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

/**
 * D-M05-6: a parent and its child both selected (review fix). `parentClipId`'s
 * object must be the parent of `childClipId`'s object, neither with
 * keyframes or expressions on its transform, and the parent not turned.
 */
export async function parentAndChildSelected(page, parentClipId, childClipId, callbacks) {
  needs(callbacks, 'readTransform');
  const { readTransform } = callbacks;
  const clipIds = [parentClipId, childClipId];
  await selectClips(page, clipIds, callbacks);
  const parentBefore = await readTransform(parentClipId);
  const childBefore = await readTransform(childClipId);
  const parentCorners = centroid(await corners(page, parentClipId));
  const childCorners = centroid(await corners(page, childClipId));
  const childUnchanged = async (what) => {
    if (!sameTransform(await readTransform(childClipId), childBefore))
      throw new Error(`${what} wrote the child's own values (it must follow its parent)`);
  };
  const undoBoth = async (what) => {
    await page.keyboard.press('Control+z');
    if (
      !sameTransform(await readTransform(parentClipId), parentBefore) ||
      !sameTransform(await readTransform(childClipId), childBefore)
    )
      throw new Error(`one undo did not undo the ${what}`);
  };

  // Move: both boxes move by the same amount, the child only once.
  await drag(page, await centreOf(box(page, parentClipId), 'the parent box'), DRAG_PX, DRAG_PX);
  await childUnchanged('the move');
  const parentMoved = centroid(await corners(page, parentClipId));
  const childMoved = centroid(await corners(page, childClipId));
  const shift = { x: parentMoved.x - parentCorners.x, y: parentMoved.y - parentCorners.y };
  if (near(shift.x, 0, 1) && near(shift.y, 0, 1))
    throw new Error('the move did not move the parent');
  if (
    !near(childMoved.x - childCorners.x, shift.x, 1) ||
    !near(childMoved.y - childCorners.y, shift.y, 1)
  )
    throw new Error('the child did not move by the same amount as its parent');
  await undoBoth('move');

  // Group scale: the parent is scaled, the child follows.
  const corner = await centreOf(groupHandle(page, 'se'), 'the group se handle');
  await drag(page, corner, DRAG_PX, DRAG_PX, ['Shift']);
  const parentScaled = await readTransform(parentClipId);
  if (near(parentScaled.scaleX, parentBefore.scaleX, 1e-6))
    throw new Error('group scale did not scale the parent');
  await childUnchanged('the group scale');
  await undoBoth('group scale');

  // Group rotate: the parent turns, the child follows (turned once, not twice).
  const rotate = await centreOf(groupHandle(page, 'rotate'), 'the group rotate handle');
  await drag(page, rotate, DRAG_PX * 3, DRAG_PX, ['Shift']);
  const parentTurned = await readTransform(parentClipId);
  const turn = parentTurned.rotationDeg - parentBefore.rotationDeg;
  if (near(turn, 0, 1e-6)) throw new Error('group rotate did not turn the parent');
  await childUnchanged('the group rotate');
  await undoBoth('group rotate');
  return `parent and child selected: move, scale and rotate (${turn} deg) wrote only the parent, one undo each`;
}

export const MONITOR_TRANSFORM_B_CASES = {
  'D-M05-3': keyframeOnRelease,
  'D-M05-4': anchorMove,
  'D-M05-5': groupScaleAndRotate,
  'D-M05-6': parentAndChildSelected,
};
