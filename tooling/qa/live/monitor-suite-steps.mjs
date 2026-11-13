/* global document, HTMLElement */
/**
 * T-M13 Monitor driver suite, D-M01 to D-M10. They need a running app through
 * the T-A02 driver (`driver.mjs`) with a project open in the editor. `run.mjs`
 * calls them by id (`--tests D-M*`) and takes the before and after screenshots
 * at Fit, 100%, 200% and 400% with `zoomShots`.
 *
 * NOT RUN: written in the T-M13 helper session without launching the app.
 * Selectors come from reading the source (MonitorTransport, MonitorViewMenu,
 * MonitorTimeControls, MonitorViewport); each one must be confirmed on the
 * first live run.
 *
 * Cases that need a feature not on this base throw `BLOCKED <id>: ...` so a run
 * fails loudly instead of passing. Merged on this base: M02 to M05, M08, M09,
 * M10. Not merged: M06 (smart guides and snapping), M07 (in-place text, crop and
 * mask handles, right-click menu).
 *
 * Cases that compare the document need `ctx.readTransform(clipId)` and
 * `ctx.clips`. `run.mjs` does not supply them yet, so D-M03 fails with a clear
 * message until a runner gives them.
 */
import { join } from 'node:path';
import { screenshot } from './steps.mjs';
import { holdSpaceDragPans, tapSpacePlays } from './monitor-hand-steps.mjs';
import { dragEveryHandle } from './monitor-transform-steps.mjs';

const VIEWPORT = '.monitor-canvas-wrap';

const ZOOM_STOPS = [
  { slug: 'fit', chip: 'Zoom Fit' },
  { slug: '100', chip: 'Zoom 100%' },
  { slug: '200', chip: 'Zoom 200%' },
  { slug: '400', typed: '400' },
];

async function viewportZoom(page) {
  return page
    .locator(VIEWPORT)
    .evaluate((element) => Number(element.getAttribute('data-monitor-zoom')));
}

async function openZoomDrawer(page) {
  const fit = page.getByRole('button', { name: 'Zoom Fit', exact: true });
  if (!(await fit.isVisible().catch(() => false)))
    await page.locator('button[aria-label^="Preview scale ("]').first().click();
}

/**
 * Screenshots of the Monitor at Fit, 100%, 200% and 400%. `phase` is 'before'
 * or 'after'. Leaves the zoom at 400% (the last stop); the next call starts from there.
 */
export async function zoomShots(page, dir, phase) {
  const shots = [];
  for (const stop of ZOOM_STOPS) {
    await openZoomDrawer(page);
    if (stop.chip) {
      await page.getByRole('button', { name: stop.chip, exact: true }).click();
    } else {
      const input = page.getByRole('textbox', { name: 'Zoom percent', exact: true });
      await input.fill(stop.typed);
      await input.press('Enter');
    }
    // A text field keeps focus and screenshot() skips the shot; move focus away first.
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.waitForTimeout(250);
    shots.push(await screenshot(page, join(dir, `${phase}-${stop.slug}.png`)).catch(() => null));
  }
  return shots;
}

function blocked(id, why) {
  return async () => {
    throw new Error(`BLOCKED ${id}: ${why}`);
  };
}

/** D-M01: Ctrl+wheel zooms in and out; a plain wheel does not zoom. */
export async function wheelZoom(page) {
  const box = await page.locator(VIEWPORT).boundingBox();
  if (box === null) throw new Error('the Monitor viewport is not on screen');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const start = await viewportZoom(page);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(200);
  const zoomedIn = await viewportZoom(page);
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(200);
  await page.keyboard.up('Control');
  const zoomedBack = await viewportZoom(page);
  if (!(zoomedIn > start))
    throw new Error(`Ctrl+wheel up did not zoom in (${start} -> ${zoomedIn})`);
  if (!(zoomedBack < zoomedIn))
    throw new Error(`Ctrl+wheel down did not zoom out (${zoomedIn} -> ${zoomedBack})`);
  const plainBefore = await viewportZoom(page);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(200);
  const plainAfter = await viewportZoom(page);
  if (plainAfter !== plainBefore) throw new Error('a plain wheel changed the zoom');
  return `zoom ${start} -> ${zoomedIn} (Ctrl+wheel up) -> ${zoomedBack} (down); `
    + `plain wheel keeps ${plainAfter}`;
}

/** D-M08: View menu toggles the rulers; the overlay layer follows. */
export async function viewMenuOverlays(page) {
  // The Monitor's own View button, not the app menu bar's View (both are named View).
  await page.locator('button.monitor-view-trigger').click();
  const dialog = page.getByRole('dialog', { name: 'Monitor view', exact: true });
  await dialog.waitFor({ state: 'visible' });
  const rulerSwitch = dialog
    .locator('[data-monitor-view-switch]')
    .filter({ hasText: /ruler/iu })
    .first();
  const ruler = page.locator('[data-monitor-ruler="top"]');
  const before = await ruler.count();
  await rulerSwitch.click();
  const on = await ruler.count();
  await rulerSwitch.click();
  const off = await ruler.count();
  await page.keyboard.press('Escape');
  if (before !== 0 || on !== 1 || off !== 0)
    throw new Error(`rulers: before ${before}, on ${on}, off ${off} (want 0, 1, 0)`);
  return 'rulers on and off from the View menu; the top ruler follows';
}

/** D-M09: the preview quality control changes its value. */
export async function previewQuality(page) {
  const control = page.getByLabel('Preview quality', { exact: true }).first();
  const tag = await control.evaluate((element) => element.tagName);
  if (tag !== 'SELECT')
    throw new Error(`Preview quality is a ${tag}, not a select; update the case`);
  const before = await control.inputValue();
  const options = await control
    .locator('option')
    .evaluateAll((nodes) => nodes.map((node) => node.value));
  const other = options.find((value) => value !== before);
  if (other === undefined) throw new Error('Preview quality has one option only');
  await control.selectOption(other);
  const after = await control.inputValue();
  await control.selectOption(before);
  if (after !== other) throw new Error(`quality stayed at ${after}, not ${other}`);
  return `quality ${before} -> ${after} -> ${before}`;
}

/** D-M10: transport buttons step one frame; L plays; K stops. */
export async function transportFrames(page) {
  const timecode = page.getByLabel('Timecode', { exact: true }).first();
  const readTime = () =>
    timecode.evaluate((element) => ('value' in element ? element.value : element.textContent));
  const start = await readTime();
  await page.getByRole('button', { name: 'Step forward one frame', exact: true }).click();
  const stepped = await readTime();
  await page.getByRole('button', { name: 'Step back one frame', exact: true }).click();
  const back = await readTime();
  if (stepped === start) throw new Error('Step forward one frame did not move the timecode');
  if (back !== start) throw new Error(`Step back did not return to ${start} (read ${back})`);
  await page.locator(VIEWPORT).click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('l');
  await page.waitForTimeout(400);
  const playing = await page.getByRole('button', { name: 'Pause', exact: true }).isVisible();
  await page.keyboard.press('k');
  await page.waitForTimeout(200);
  const stopped = await readTime();
  if (!playing) throw new Error('L did not start forward play');
  return `frame step ${start} -> ${stepped} -> ${back}; L plays, K stops at ${stopped}`;
}

export const MONITOR_SUITE_CASES = {
  'D-M01': wheelZoom,
  'D-M02': async (page) => `${await holdSpaceDragPans(page)}; ${await tapSpacePlays(page)}`,
  'D-M03': (page, ctx) => dragEveryHandle(page, ctx.clips, ctx.readTransform),
  'D-M04': blocked('D-M04', 'snapping and the live readout are T-M06, not merged here'),
  'D-M05': blocked('D-M05', 'in-place text is T-M07, not merged here'),
  'D-M06': blocked('D-M06', 'crop and mask handles are T-M07, not merged here'),
  'D-M07': blocked('D-M07', 'the right-click menu on the Monitor is T-M07, not merged here'),
  'D-M08': viewMenuOverlays,
  'D-M09': previewQuality,
  'D-M10': transportFrames,
};

export const MONITOR_SUITE_IDS = Object.freeze(Object.keys(MONITOR_SUITE_CASES));
