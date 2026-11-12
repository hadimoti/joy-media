/* global document */
/**
 * T-M03 driver cases (hand tool and Space). They need a running app through
 * the T-A02 driver (`driver.mjs`): call them with the Playwright `page` of a
 * live session that has a project open in the editor. Not wired into
 * `run.mjs` (that file belongs to T-A02); a runner adds them by id:
 *   D-M03-1 hold Space and drag pans, and does not start playback
 *   D-M03-2 a tap of Space plays
 *   D-M03-3 typing "a b" in a title keeps the space
 */

const VIEWPORT = '.monitor-canvas-wrap';

async function viewportState(page) {
  return page.locator(VIEWPORT).evaluate((element) => ({
    zoom: Number(element.getAttribute('data-monitor-zoom')),
    panX: Number(element.getAttribute('data-monitor-pan-x')),
    panY: Number(element.getAttribute('data-monitor-pan-y')),
    tool: element.getAttribute('data-monitor-tool'),
  }));
}

async function isPlaying(page) {
  return page.getByRole('button', { name: 'Pause', exact: true }).isVisible();
}

async function centreOfViewport(page) {
  const box = await page.locator(VIEWPORT).boundingBox();
  if (box === null) throw new Error('the Monitor viewport is not on screen');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** D-M03-1: zoom to 200 per cent, hold Space, drag; the view pans and nothing plays. */
export async function holdSpaceDragPans(page) {
  if (await isPlaying(page)) await page.keyboard.press(' ');
  const centre = await centreOfViewport(page);
  await page.mouse.move(centre.x, centre.y);
  await page.keyboard.press('Control+=');
  await page.keyboard.press('Control+=');
  const before = await viewportState(page);
  await page.keyboard.down(' ');
  await page.waitForTimeout(400);
  const held = await viewportState(page);
  if (held.tool !== 'hand') throw new Error(`Space hold did not lend the Hand (tool ${held.tool})`);
  await page.mouse.down();
  await page.mouse.move(centre.x + 120, centre.y + 60, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up(' ');
  const after = await viewportState(page);
  if (after.panX === before.panX && after.panY === before.panY)
    throw new Error('the view did not pan');
  if (after.tool !== 'select') throw new Error('releasing Space did not give the tool back');
  if (await isPlaying(page)) throw new Error('holding Space started playback');
  return `panned from (${before.panX}, ${before.panY}) to (${after.panX}, ${after.panY}); not playing`;
}

/** D-M03-2: a quick tap of Space plays (and a second tap pauses). */
export async function tapSpacePlays(page) {
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const wasPlaying = await isPlaying(page);
  await page.keyboard.down(' ');
  await page.waitForTimeout(60);
  await page.keyboard.up(' ');
  await page.waitForTimeout(200);
  const nowPlaying = await isPlaying(page);
  if (nowPlaying === wasPlaying) throw new Error('a tap of Space did not toggle playback');
  if (nowPlaying) await page.keyboard.press(' ');
  return 'a tap toggled playback on key-up';
}

/** D-M03-3: in a text field Space types a space; playback does not start. */
export async function spaceInTitleKeepsSpace(page, titleLocator) {
  const field = titleLocator ?? page.getByRole('textbox').first();
  await field.click();
  await field.fill('');
  await page.keyboard.type('a b');
  const value = await field.inputValue();
  if (value !== 'a b') throw new Error(`the title reads "${value}", not "a b"`);
  if (await isPlaying(page)) throw new Error('Space in a text field started playback');
  const active = await page.evaluate(() => document.activeElement?.tagName ?? '');
  return `title kept the space ("${value}"); focus on ${active}`;
}

export const MONITOR_HAND_CASES = {
  'D-M03-1': holdSpaceDragPans,
  'D-M03-2': tapSpacePlays,
  'D-M03-3': spaceInTitleKeepsSpace,
};
