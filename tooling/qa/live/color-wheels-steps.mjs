/**
 * T-K02 driver cases (the colour wheels). They need a running app through the
 * T-A02 driver (`driver.mjs`): call them with the Playwright `page` of a live
 * session that has a project open in the editor. Not wired into `run.mjs`
 * (that file belongs to T-A02); a runner adds them by id.
 * Not run yet: they need the app launched.
 *
 *   D-K02-1 drag a wheel: the grade changes, the panel's numbers follow the
 *           document, and one Ctrl+Z puts the wheel back
 *   D-K02-2 the arrow keys move the puck: each press is one undo step
 *
 * The case opens the Color panel (Enhance → Color) and its Wheels tab itself.
 *
 * `readGrade(wheelId)` is given by the runner and returns the document's wheel
 * as `{ r, g, b, master }` (for example from the saved project file, or a test
 * hook). The app has no page-side document reader, so the case cannot read it
 * by itself.
 */

const FACE = '[data-color-wheel="lift"]';
const NUMBERS = '[data-color-wheel-numbers="lift"] output';

/** The Enhance hub's Color tool, then the panel's Wheels tab. */
async function openWheels(page) {
  await page.locator('[data-feature-tool="color"]').first().click();
  await page.locator('[data-panel-tab-id="wheels"]').first().click();
  await page.locator(FACE).first().waitFor();
}

/** The wheel's numbers as the panel shows them. */
async function shownNumbers(page) {
  const texts = await page.locator(NUMBERS).allTextContents();
  if (texts.length !== 4) throw new Error(`the panel shows ${texts.length} numbers, not 4`);
  return texts.map((text) => Number(text.replace('+', '')));
}

/** The same numbers, rounded the way the panel rounds them. */
function rounded(grade) {
  return [grade.r, grade.g, grade.b].map((value) => Number(value.toFixed(2)));
}

function sameNumbers(a, b) {
  return a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) <= 0.005);
}

/** The point a little above the wheel's centre, where the puck can be grabbed. */
async function grabPoint(page) {
  const box = await page.locator(FACE).first().boundingBox();
  if (box === null) throw new Error('the Lift wheel is not on screen');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 - box.height * 0.3 };
}

/** D-K02-1: drag the puck, check the document and the panel, undo once. */
export async function dragWheelChangesGrade(page, readGrade) {
  if (typeof readGrade !== 'function')
    throw new Error('give readGrade(wheelId) so the case can read the document');
  await openWheels(page);

  const before = await readGrade('lift');
  const point = await grabPoint(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y - 20, { steps: 6 });
  await page.mouse.up();

  const after = await readGrade('lift');
  if (sameNumbers(rounded(before), rounded(after)))
    throw new Error(
      `the drag changed nothing: the Lift wheel is still ${JSON.stringify(rounded(after))}`,
    );
  const shown = await shownNumbers(page);
  if (!sameNumbers(shown, rounded(after)))
    throw new Error(
      `the panel shows ${JSON.stringify(shown)}, the document has ${JSON.stringify(rounded(after))}`,
    );

  await page.keyboard.press('Control+z');
  const undone = await readGrade('lift');
  if (!sameNumbers(rounded(before), rounded(undone)))
    throw new Error(
      `one undo left ${JSON.stringify(rounded(undone))}, not ${JSON.stringify(rounded(before))}`,
    );
  return `dragged the Lift wheel to ${JSON.stringify(rounded(after))}, one undo put it back`;
}

/** D-K02-2: the arrow keys move the puck; each press is one undo step. */
export async function arrowKeysMoveThePuck(page, readGrade) {
  if (typeof readGrade !== 'function')
    throw new Error('give readGrade(wheelId) so the case can read the document');
  await openWheels(page);

  const before = await readGrade('lift');
  await page.locator(FACE).first().focus();
  await page.keyboard.press('ArrowRight');
  const afterOne = await readGrade('lift');
  if (sameNumbers(rounded(before), rounded(afterOne)))
    throw new Error('ArrowRight changed nothing');

  await page.keyboard.press('Control+z');
  const undone = await readGrade('lift');
  if (!sameNumbers(rounded(before), rounded(undone)))
    throw new Error('one undo did not put the wheel back');

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  const undoneTwice = await readGrade('lift');
  if (!sameNumbers(rounded(before), rounded(undoneTwice)))
    throw new Error('two undos did not undo two nudges');
  return 'ArrowRight moves the puck, one undo step each';
}

export const COLOR_WHEELS_CASES = {
  'D-K02-1': dragWheelChangesGrade,
  'D-K02-2': arrowKeysMoveThePuck,
};
