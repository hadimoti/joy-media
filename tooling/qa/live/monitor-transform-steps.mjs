/**
 * T-M05a driver cases (the transform box on the Monitor). They need a running
 * app through the T-A02 driver (`driver.mjs`): call them with the Playwright
 * `page` of a live session that has a project open in the editor. Not wired
 * into `run.mjs` (that file belongs to T-A02); a runner adds them by id.
 * Not run yet: they need the app launched.
 *
 *   D-M05-1 for a picture, a video, a text and a shape, at 50% and 200% zoom,
 *           drag every handle (move, 8 scale handles, rotate): the element
 *           changes, one Ctrl+Z puts it back, and the Inspector numbers equal
 *           the document after each drag
 *   D-M05-2 arrows nudge 1 px and Shift+arrow 10 px while the pointer is over
 *           the Monitor; each press is one undo step
 *
 * `clips` names one timeline clip per kind, e.g.
 *   { picture: 'clip-a', video: 'clip-b', text: 'clip-c', shape: 'clip-d' }
 * Each element must be free of keyframes and expressions on its transform,
 * no camera may be active, and the centre of its box must not be covered by
 * another element.
 *
 * `readTransform(clipId)` is given by the runner and returns the document's
 * transform for that clip's object, `{ x, y, scaleX, scaleY, rotationDeg }`
 * (for example from the saved project file, or a test hook). The app has no
 * page-side document reader, so the case cannot read it by itself.
 */

const VIEWPORT = '.monitor-canvas-wrap';
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const INSPECTOR_FIELDS = {
  x: '#insp-x',
  y: '#insp-y',
  scaleX: '#insp-scaleX',
  scaleY: '#insp-scaleY',
  rotationDeg: '#insp-rotationDeg',
};
const ZOOMS = [
  { label: '50%', value: 0.5 },
  { label: '200%', value: 2 },
];
const DRAG_PX = 30;

function timelineClip(page, clipId) {
  return page.locator(`.timeline-clip[data-clip-id="${clipId}"]`).first();
}

function handle(page, clipId, name) {
  return page.locator(`[data-monitor-handle="${name}"][data-clip-id="${clipId}"]`).first();
}

async function setZoom(page, zoom) {
  await page.getByRole('button', { name: /^Preview scale/u }).click();
  await page.getByRole('button', { name: `Zoom ${zoom.label}`, exact: true }).click();
  const value = await page
    .locator(VIEWPORT)
    .evaluate((element) => Number(element.getAttribute('data-monitor-zoom')));
  if (Math.abs(value - zoom.value) > 1e-6)
    throw new Error(`the Monitor zoom is ${value}, not ${zoom.value}`);
}

async function centreOf(locator, what) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${what} is not on screen`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(page, from, dx, dy) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
  await page.mouse.up();
}

async function inspectorNumbers(page) {
  const out = {};
  for (const [key, selector] of Object.entries(INSPECTOR_FIELDS)) {
    const value = await page.locator(selector).first().inputValue();
    out[key] = Number(value.replace('%', ''));
  }
  return out;
}

function sameTransform(a, b, tolerance = 0.01) {
  return Object.keys(INSPECTOR_FIELDS).every(
    (key) => Math.abs(Number(a[key] ?? 0) - Number(b[key] ?? 0)) <= tolerance,
  );
}

/** The Inspector shows rounded numbers; compare them to the document at that precision. */
async function inspectorMatchesDocument(page, readTransform, clipId, what) {
  const document = await readTransform(clipId);
  const shown = await inspectorNumbers(page);
  if (!sameTransform(document, shown, 0.51))
    throw new Error(
      `${what}: Inspector ${JSON.stringify(shown)} differs from the document ${JSON.stringify(document)}`,
    );
}

/** One gesture: drag, check it changed and the Inspector, undo once, check it is back. */
async function oneGesture(page, readTransform, clipId, what, start, dx, dy) {
  const before = await readTransform(clipId);
  await drag(page, start, dx, dy);
  const after = await readTransform(clipId);
  if (sameTransform(before, after, 1e-6)) throw new Error(`${what}: the drag changed nothing`);
  await inspectorMatchesDocument(page, readTransform, clipId, what);
  await page.keyboard.press('Control+z');
  const undone = await readTransform(clipId);
  if (!sameTransform(before, undone, 1e-6))
    throw new Error(
      `${what}: one undo left ${JSON.stringify(undone)}, not ${JSON.stringify(before)}`,
    );
}

async function allHandles(page, readTransform, kind, clipId, zoom) {
  await timelineClip(page, clipId).click();
  await setZoom(page, zoom);
  const prefix = `${kind} at ${zoom.label}`;
  const box = page.locator(`.monitor-selection-overlay polygon[data-clip-id="${clipId}"]`).first();
  await oneGesture(
    page,
    readTransform,
    clipId,
    `${prefix} move`,
    await centreOf(box, `${prefix}: the box`),
    DRAG_PX,
    DRAG_PX / 2,
  );
  for (const name of HANDLES) {
    const point = await centreOf(handle(page, clipId, name), `${prefix}: handle ${name}`);
    const dx = name.includes('w') ? -DRAG_PX : name.includes('e') ? DRAG_PX : 0;
    const dy = name.includes('n') ? -DRAG_PX : name.includes('s') ? DRAG_PX : 0;
    await oneGesture(page, readTransform, clipId, `${prefix} ${name}`, point, dx, dy);
  }
  const rotate = await centreOf(handle(page, clipId, 'rotate'), `${prefix}: the rotate handle`);
  await oneGesture(page, readTransform, clipId, `${prefix} rotate`, rotate, DRAG_PX * 2, 0);
  return `${prefix}: move, 8 handles and rotate each undo in one step`;
}

/** D-M05-1: every handle on four element kinds at two zooms. */
export async function dragEveryHandle(page, clips, readTransform) {
  if (typeof readTransform !== 'function')
    throw new Error('give readTransform(clipId) so the case can read the document');
  const kinds = Object.entries(clips ?? {});
  for (const needed of ['picture', 'video', 'text', 'shape'])
    if (!kinds.some(([kind]) => kind === needed)) throw new Error(`give a ${needed} clip`);
  const results = [];
  for (const [kind, clipId] of kinds)
    for (const zoom of ZOOMS)
      results.push(await allHandles(page, readTransform, kind, clipId, zoom));
  return results.join('; ');
}

/** D-M05-2: nudges with the pointer over the Monitor; one undo step each. */
export async function nudgeOnMonitor(page, clipId, readTransform) {
  if (typeof readTransform !== 'function')
    throw new Error('give readTransform(clipId) so the case can read the document');
  await timelineClip(page, clipId).click();
  const viewport = await centreOf(page.locator(VIEWPORT), 'the Monitor viewport');
  await page.mouse.move(viewport.x, viewport.y);
  const before = await readTransform(clipId);
  await page.keyboard.press('ArrowRight');
  const right = await readTransform(clipId);
  if (Math.abs(right.x - before.x - 1) > 1e-6)
    throw new Error(`ArrowRight moved x by ${right.x - before.x}, not 1`);
  await page.keyboard.press('Shift+ArrowDown');
  const down = await readTransform(clipId);
  if (Math.abs(down.y - right.y - 10) > 1e-6)
    throw new Error(`Shift+ArrowDown moved y by ${down.y - right.y}, not 10`);
  await inspectorMatchesDocument(page, readTransform, clipId, 'nudge');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  const undone = await readTransform(clipId);
  if (!sameTransform(before, undone, 1e-6)) throw new Error('two undos did not undo two nudges');
  return 'ArrowRight +1 px, Shift+ArrowDown +10 px, one undo each';
}

export const MONITOR_TRANSFORM_CASES = {
  'D-M05-1': dragEveryHandle,
  'D-M05-2': nudgeOnMonitor,
};
