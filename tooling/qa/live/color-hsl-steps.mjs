/**
 * T-K04 driver cases (the HSL bands and the eyedropper). They need a running
 * app through the T-A02 driver (`driver.mjs`): call them with the Playwright
 * `page` of a live session that has a project open in the editor whose
 * picture shows a pure green patch (#00ff00). Not wired into `run.mjs` (that
 * file belongs to T-A02); a runner adds them by id.
 * Not run yet: they need the app launched.
 *
 *   D-K04-1 pick the pure green patch with the eyedropper: the Green band
 *           opens and is highlighted; its saturation to the minimum makes the
 *           patch grey in the preview; one Ctrl+Z puts the colour back
 *   D-K04-2 Esc cancels a pick: nothing changes in the document
 *   D-K04-3 Hold to compare shows the patch green again while it is held
 *
 * The case opens the Color panel (Enhance → Color) and its HSL tab itself.
 *
 * The runner gives:
 * - `patch`: the centre of the green patch as a screen point `{ x, y }`
 *   (page pixels inside the Monitor);
 * - `readPreviewPixel(point)`: the colour the Monitor shows at that screen
 *   point, `{ r, g, b }` 0..255 (for example from a screenshot of the page);
 * - `readGrade()`: the document's grade being edited (output or clip), for
 *   example from the saved project file or a test hook.
 */

const EYEDROPPER = '[data-hsl-eyedropper]';
const OVERLAY = '[data-monitor-eyedropper]';
const GREEN = '[data-hsl-band="green"]';
const GREEN_SATURATION = '[data-hsl-band="green"] input[data-hsl-control="saturation"]';
const COMPARE = '[data-color-compare]';

async function openHsl(page) {
  await page.locator('[data-feature-tool="color"]').first().click();
  await page.locator('[data-panel-tab-id="hsl"]').first().click();
  await page.locator(EYEDROPPER).first().waitFor();
}

function isGrey(colour, tolerance = 6) {
  return (
    Math.abs(colour.r - colour.g) <= tolerance &&
    Math.abs(colour.g - colour.b) <= tolerance &&
    Math.abs(colour.r - colour.b) <= tolerance
  );
}

function isGreen(colour) {
  return colour.g > 200 && colour.r < 60 && colour.b < 60;
}

function needs(name, value) {
  if (value === undefined || value === null) throw new Error(`give ${name} to run this case`);
}

/** D-K04-1: pick the green patch, the Green band opens, saturation down turns it grey, undo. */
export async function pickGreenAndDesaturate(page, { patch, readPreviewPixel, readGrade } = {}) {
  needs('patch', patch);
  needs('readPreviewPixel', readPreviewPixel);
  needs('readGrade', readGrade);
  await openHsl(page);
  if (!isGreen(await readPreviewPixel(patch)))
    throw new Error('the patch is not pure green before the case');

  await page.locator(EYEDROPPER).first().click();
  await page.locator(OVERLAY).first().waitFor();
  await page.mouse.move(patch.x, patch.y);
  const readout = await page.locator('[data-eyedropper-readout]').first().textContent();
  if (!/Hue 120°/.test(readout ?? ''))
    throw new Error(`the magnifier reads ${JSON.stringify(readout)}, expected hue 120°`);
  await page.mouse.click(patch.x, patch.y);

  const green = page.locator(GREEN).first();
  if ((await green.getAttribute('open')) === null) throw new Error('the Green band did not open');
  if (!/is-picked/.test((await green.getAttribute('class')) ?? ''))
    throw new Error('the Green band is not highlighted');
  const picked = await readGrade();
  if (Math.round(picked.hsl[3].hue) !== 120)
    throw new Error(`the Green band centre is ${picked.hsl[3].hue}°, expected 120°`);

  const slider = page.locator(GREEN_SATURATION).first();
  await slider.focus();
  await page.keyboard.press('Home');
  const grade = await readGrade();
  if (grade.hsl[3].saturation !== -1)
    throw new Error(`the Green saturation is ${grade.hsl[3].saturation}, expected -1`);
  const shown = await readPreviewPixel(patch);
  if (!isGrey(shown)) throw new Error(`the patch shows ${JSON.stringify(shown)}, not grey`);

  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  const undone = await readPreviewPixel(patch);
  if (!isGreen(undone)) throw new Error(`two undos left the patch ${JSON.stringify(undone)}`);
  return `picked hue 120°, the Green band opened; saturation -1 made the patch ${JSON.stringify(shown)}`;
}

/** D-K04-2: Esc cancels a pick; the document does not change. */
export async function escCancelsThePick(page, { patch, readGrade } = {}) {
  needs('patch', patch);
  needs('readGrade', readGrade);
  await openHsl(page);
  const before = JSON.stringify(await readGrade());
  await page.locator(EYEDROPPER).first().click();
  await page.locator(OVERLAY).first().waitFor();
  await page.mouse.move(patch.x, patch.y);
  await page.keyboard.press('Escape');
  if ((await page.locator(OVERLAY).count()) !== 0) throw new Error('Esc did not end the pick');
  if (JSON.stringify(await readGrade()) !== before)
    throw new Error('a cancelled pick changed the grade');
  return 'Esc ended the pick, the grade did not change';
}

/** D-K04-3: hold to compare: the ungraded patch while held, the graded one after. */
export async function holdToCompare(page, { patch, readPreviewPixel } = {}) {
  needs('patch', patch);
  needs('readPreviewPixel', readPreviewPixel);
  await openHsl(page);
  const graded = await readPreviewPixel(patch);
  const box = await page.locator(COMPARE).first().boundingBox();
  if (box === null) throw new Error('no Hold to compare button');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const held = await readPreviewPixel(patch);
  await page.mouse.up();
  const after = await readPreviewPixel(patch);
  if (!isGreen(held)) throw new Error(`while held the patch shows ${JSON.stringify(held)}`);
  if (JSON.stringify(after) !== JSON.stringify(graded))
    throw new Error('the graded picture did not come back after letting go');
  return `held: ${JSON.stringify(held)}, let go: ${JSON.stringify(after)}`;
}

export const COLOR_HSL_CASES = {
  'D-K04-1': pickGreenAndDesaturate,
  'D-K04-2': escCancelsThePick,
  'D-K04-3': holdToCompare,
};
