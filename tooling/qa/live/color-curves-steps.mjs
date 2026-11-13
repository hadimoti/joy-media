/**
 * T-K03 driver cases (the curves editor). They need a running app through the
 * T-A02 driver (`driver.mjs`): call them with the Playwright `page` of a live
 * session that has a project open in the editor. Not wired into `run.mjs`
 * (that file belongs to T-A02); a runner adds them by id.
 * Not run yet: they need the app launched.
 *
 *   D-K03-1 click the RGB line to add a point and drag it up: the drawn line
 *           and the document change, and one Ctrl+Z puts the curve back
 *   D-K03-2 Tab to the new point, nudge it with the arrow keys, delete it
 *           with Delete: each step is one undo step
 *
 * The case opens the Color panel (Enhance → Color) and its Curves tab itself.
 *
 * `readCurve(channel)` is given by the runner and returns the document's curve
 * points for 'rgb', 'red', 'green' or 'blue' as `[{ x, y }, ...]` (for example
 * from the saved project file, or a test hook). The app has no page-side
 * document reader, so the case cannot read it by itself.
 */

const GRAPH = '[data-curve-graph="rgb"]';
const LINE = '[data-curve-line="rgb"]';
const POINTS = '[data-curve-point]';
const READOUT = '[data-curve-readout]';

/** The Enhance hub's Color tool, then the panel's Curves tab and its RGB curve. */
async function openCurves(page) {
  await page.locator('[data-feature-tool="color"]').first().click();
  await page.locator('[data-panel-tab-id="curves"]').first().click();
  await page.locator('[data-curve-channel="rgb"]').first().click();
  await page.locator(GRAPH).first().waitFor();
}

function sameCurve(a, b) {
  return (
    a.length === b.length &&
    a.every(
      (point, index) =>
        Math.abs(point.x - b[index].x) <= 1e-6 && Math.abs(point.y - b[index].y) <= 1e-6,
    )
  );
}

/** A point of the graph on screen, from a level pair (0..255, y up). */
async function graphPoint(page, input, output) {
  const box = await page.locator(GRAPH).first().boundingBox();
  if (box === null) throw new Error('the curve graph is not on screen');
  return {
    x: box.x + (input / 255) * box.width,
    y: box.y + box.height - (output / 255) * box.height,
  };
}

/** D-K03-1: add a point on the line, drag it up, check line and document, undo once. */
export async function addPointAndDrag(page, readCurve) {
  if (typeof readCurve !== 'function')
    throw new Error('give readCurve(channel) so the case can read the document');
  await openCurves(page);

  const before = await readCurve('rgb');
  const lineBefore = await page.locator(LINE).first().getAttribute('d');
  const pointsBefore = await page.locator(POINTS).count();

  // On the straight line, level 128 has output 128.
  const start = await graphPoint(page, 128, 128);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const end = await graphPoint(page, 128, 176);
  await page.mouse.move(end.x, end.y, { steps: 8 });
  const readout = await page.locator(READOUT).first().textContent();
  if (!/^In \d+, Out \d+$/.test(readout ?? ''))
    throw new Error(`the readout while dragging is ${JSON.stringify(readout)}`);
  await page.mouse.up();

  const after = await readCurve('rgb');
  if (after.length !== before.length + 1)
    throw new Error(`the document has ${after.length} points, expected ${before.length + 1}`);
  const added = after.find((point) => Math.abs(point.x - 128 / 255) < 0.02);
  if (added === undefined || added.y < 160 / 255)
    throw new Error(`no point near input 128 was dragged up: ${JSON.stringify(after)}`);
  if ((await page.locator(POINTS).count()) !== pointsBefore + 1)
    throw new Error('the graph does not show the new point');
  if ((await page.locator(LINE).first().getAttribute('d')) === lineBefore)
    throw new Error('the drawn line did not change');

  await page.keyboard.press('Control+z');
  const undone = await readCurve('rgb');
  if (!sameCurve(before, undone))
    throw new Error(`one undo left ${JSON.stringify(undone)}, not ${JSON.stringify(before)}`);
  return `added a point at input 128, dragged it to output ${Math.round(added.y * 255)}, one undo put the curve back`;
}

/** D-K03-2: keyboard: Tab to a point, arrows nudge, Delete removes; one undo step each. */
export async function keyboardEditsAPoint(page, readCurve) {
  if (typeof readCurve !== 'function')
    throw new Error('give readCurve(channel) so the case can read the document');
  await openCurves(page);

  const before = await readCurve('rgb');
  const start = await graphPoint(page, 64, 64);
  await page.mouse.click(start.x, start.y);
  const withPoint = await readCurve('rgb');
  if (withPoint.length !== before.length + 1) throw new Error('the click added no point');

  await page.keyboard.press('ArrowUp');
  const nudged = await readCurve('rgb');
  if (sameCurve(nudged, withPoint)) throw new Error('ArrowUp changed nothing');
  await page.keyboard.press('Control+z');
  if (!sameCurve(await readCurve('rgb'), withPoint))
    throw new Error('one undo did not undo one nudge');

  await page.locator(GRAPH).first().focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Delete');
  const deleted = await readCurve('rgb');
  if (deleted.length !== before.length) throw new Error('Delete did not remove the point');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  if (!sameCurve(await readCurve('rgb'), before))
    throw new Error('two undos did not put the curve back');
  return 'the arrow keys nudge a point and Delete removes it, one undo step each';
}

export const COLOR_CURVES_CASES = {
  'D-K03-1': addPointAndDrag,
  'D-K03-2': keyboardEditsAPoint,
};
