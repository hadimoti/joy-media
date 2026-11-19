/* global document */
/**
 * D-M06-01 Monitor snapping (T-M06): a picture dragged near the canvas centre lands exactly on it, the guide
 * shows while it is snapped, and Ctrl turns snapping off.
 *
 * The row needs `--media <picture in the fixtures folder>`; it imports and places it the way the monitor rows do.
 * It reads the element's transform from the editor's live visual project (the same session reader the colour
 * rows use) and the Monitor's own view (`data-monitor-zoom`, `data-monitor-pan-x/y`) for the screen mapping.
 *
 * The element's centre is `transform.x + readout W / 2` (the snap box is the unrotated element's box in frame
 * pixels, so its left edge is `transform.x`). The readout is read while the mouse is still down, because the
 * guide and readout are removed on release.
 */
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { readLiveVisualProject } from './matrix-core.mjs';
import {
  addToTimelineThroughLeftPanel,
  importThroughLeftPanel,
  newProject,
  openMenu,
} from './steps.mjs';

const ROW_ID = 'D-M06-01';
/** The element is scaled to this many per cent so it does not cover the whole frame. */
const SCALE_PERCENT = 25;
/** The first drag moves the element off the centre by this much (screen px), so the snap drag has a real distance. */
const SETUP_OFFSET_PX = { x: 120, y: 70 };
/** The snap drag's pointer ends this far to the right of the canvas centre (screen px), inside the 6 px snap range. */
export const SNAP_OFFSET_PX = 4;
/** A centre within this many project units of the frame centre counts as on it. */
export const CENTRE_TOLERANCE_UNITS = 0.5;
/** The Ctrl drag's centre must be at least this far off the frame centre (project units). */
export const UNSNAPPED_MIN_UNITS = 1;
const OVERLAY_TIMEOUT_MS = 3_000;
const SETTLE_TIMEOUT_MS = 4_000;

/** Parses the snap readout text, `X 540  Y 960  W 270  H 480  A 0°`, into the box in frame pixels (rounded). */
export function parseReadout(text) {
  const match = /X (-?\d+)\s+Y (-?\d+)\s+W (\d+)\s+H (\d+)/u.exec(text ?? '');
  if (match === null) return null;
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4]),
  };
}

/** The screen point of the frame centre, from the Monitor's pan and zoom (the same mapping as canvasToScreenPoint). */
export function canvasCentreOnScreen(geometry, frame) {
  return {
    x: geometry.left + geometry.panX + (geometry.zoom * frame.width) / 2,
    y: geometry.top + geometry.panY + (geometry.zoom * frame.height) / 2,
  };
}

/** The element's centre in frame units, from its transform (left, top) and the readout's box size. */
export function centreFromTransform(transform, box) {
  return { x: transform.x + box.width / 2, y: transform.y + box.height / 2 };
}

/** Distance of a centre from the frame centre, per axis, in project units. */
export function offsetFromFrameCentre(centre, frame) {
  return { x: centre.x - frame.width / 2, y: centre.y - frame.height / 2 };
}

async function readElement(page) {
  const visual = await readLiveVisualProject(page);
  if (!visual || typeof visual.visualObjects !== 'object' || !visual.compositions)
    throw new Error(`${ROW_ID}: could not read the live visual project (no editor session found)`);
  const elements = Object.values(visual.visualObjects).filter(
    (object) => object && object.assetId !== undefined && object.transform,
  );
  if (elements.length !== 1)
    throw new Error(
      `${ROW_ID}: expected one picture element in the project, found ${elements.length}`,
    );
  const composition =
    visual.compositions[visual.rootCompositionId] ?? Object.values(visual.compositions)[0];
  if (!Number.isFinite(composition?.width) || !Number.isFinite(composition?.height))
    throw new Error(`${ROW_ID}: the root composition has no width and height in the live project`);
  const t = elements[0].transform;
  return {
    id: elements[0].id,
    transform: { x: t.x, y: t.y, scaleX: t.scaleX, scaleY: t.scaleY, rotationDeg: t.rotationDeg },
    frame: { width: composition.width, height: composition.height },
  };
}

async function monitorGeometry(page) {
  const geometry = await page.evaluate(() => {
    const wrap = document.querySelector('.monitor-canvas-wrap');
    if (!wrap) return null;
    const box = wrap.getBoundingClientRect();
    return {
      left: box.left,
      top: box.top,
      zoom: Number(wrap.getAttribute('data-monitor-zoom')),
      panX: Number(wrap.getAttribute('data-monitor-pan-x')),
      panY: Number(wrap.getAttribute('data-monitor-pan-y')),
    };
  });
  if (!geometry || !(geometry.zoom > 0))
    throw new Error(`${ROW_ID}: the Monitor viewport (.monitor-canvas-wrap) has no zoom to read`);
  return geometry;
}

/** The screen box of the selected element's outline (its bounding box on the Monitor). */
async function elementOutline(page) {
  const box = await page
    .locator('.monitor-selection-overlay polygon[data-clip-id]')
    .first()
    .boundingBox()
    .catch(() => null);
  if (box === null)
    throw new Error(`${ROW_ID}: the element has no selection outline on the Monitor`);
  return box;
}

const centreOf = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/**
 * Where a drag presses: a quarter of the box height below the centre. The transform anchor is drawn at the
 * centre by default, so pressing there would move the anchor instead of the element.
 */
const grabOf = (box) => ({ x: box.x + box.width / 2, y: box.y + (box.height * 3) / 4 });

async function waitForSelection(page) {
  const outline = page.locator('.monitor-selection-overlay polygon[data-clip-id]');
  const seen = await outline
    .first()
    .waitFor({ state: 'attached', timeout: OVERLAY_TIMEOUT_MS })
    .then(() => 'selected')
    .catch(async () => `no selection outline (${await outline.count()} polygons)`);
  if (seen !== 'selected')
    throw new Error(
      `${ROW_ID}: clicking the element on the Monitor did not select it (timeline click); saw ${seen}`,
    );
}

async function _scaleDown(page) {
  const field = (axis) => page.locator(`#insp-scale${axis}`).first();
  if (
    !(await field('X')
      .isVisible()
      .catch(() => false))
  ) {
    await openMenu(page, 'View');
    await page.getByRole('menuitem', { name: 'Inspector', exact: true }).click();
  }
  for (const axis of ['X', 'Y']) {
    const input = field(axis);
    await input.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
      throw new Error(
        `${ROW_ID}: the Inspector Scale ${axis} field (#insp-scale${axis}) is not shown`,
      );
    });
    await input.fill(String(SCALE_PERCENT / 100));
    await input.press('Enter');
  }
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let element = await readElement(page);
  while (
    Date.now() < deadline &&
    (Math.abs(element.transform.scaleX - SCALE_PERCENT / 100) > 1e-3 ||
      Math.abs(element.transform.scaleY - SCALE_PERCENT / 100) > 1e-3)
  ) {
    await page.waitForTimeout(150);
    element = await readElement(page);
  }
  const { scaleX, scaleY } = element.transform;
  if (
    Math.abs(scaleX - SCALE_PERCENT / 100) > 1e-3 ||
    Math.abs(scaleY - SCALE_PERCENT / 100) > 1e-3
  )
    throw new Error(
      `${ROW_ID}: typing ${SCALE_PERCENT / 100} in the Inspector Scale fields did not give 0.25; the document has scaleX ${scaleX}, scaleY ${scaleY}`,
    );
}

/** What the Monitor shows while the mouse is down: the overlay, the readout and every guide line. */
async function readSnapState(page) {
  return page.evaluate(() => {
    const overlay = document.querySelector('[data-monitor-snap-overlay]');
    const readout = document.querySelector('[data-monitor-snap-readout]');
    const guides = [...document.querySelectorAll('[data-monitor-snap-guide]')].map((guide) => {
      const box = guide.getBoundingClientRect();
      return {
        axis: guide.getAttribute('data-monitor-snap-guide'),
        kind: guide.getAttribute('data-monitor-snap-kind'),
        left: box.left,
        top: box.top,
      };
    });
    return { overlay: overlay !== null, readout: readout?.textContent ?? null, guides };
  });
}

/**
 * Presses at `from`, moves to `to` in steps, waits for the snap overlay while the mouse is still down, reads the
 * overlay state, then releases. Control is held for the whole gesture when `ctrl` is set.
 */
export async function dragAndObserve(page, from, to, { ctrl, onHeld, observe = true }) {
  let observed;
  let mousePressed = false;
  let controlPressed = false;
  let gestureError;
  const releaseErrors = [];
  try {
    if (ctrl) {
      controlPressed = true;
      await page.keyboard.down('Control');
    }
    await page.mouse.move(from.x, from.y);
    mousePressed = true;
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    if (observe) {
      const deadline = Date.now() + OVERLAY_TIMEOUT_MS;
      observed = await readSnapState(page);
      while (!observed.overlay && Date.now() < deadline) {
        await page.waitForTimeout(100);
        observed = await readSnapState(page);
      }
    }
    if (onHeld) observed.shot = await onHeld();
  } catch (error) {
    gestureError = error;
  } finally {
    if (mousePressed) await page.mouse.up().catch((error) => releaseErrors.push(error));
    if (controlPressed)
      await page.keyboard.up('Control').catch((error) => releaseErrors.push(error));
  }
  if (releaseErrors.length) {
    const all = gestureError ? [gestureError, ...releaseErrors] : releaseErrors;
    throw new AggregateError(all, `input release failed: ${all.map(String).join('; ')}`);
  }
  if (gestureError) throw gestureError;
  return observed;
}

async function waitForMoved(page, before) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let element = await readElement(page);
  while (
    Date.now() < deadline &&
    Math.abs(element.transform.x - before.x) < 1e-6 &&
    Math.abs(element.transform.y - before.y) < 1e-6
  ) {
    await page.waitForTimeout(150);
    element = await readElement(page);
  }
  return element;
}

const round = (value) => Math.round(value * 100) / 100;

export async function prepareSnapPicture(
  page,
  ctx,
  steps = {
    newProject,
    importPicture: importThroughLeftPanel,
    placePicture: addToTimelineThroughLeftPanel,
  },
) {
  await steps.newProject(page, `Monitor snap ${ctx.runTag ?? 'run'}`);
  await steps.importPicture(page, ctx.media);
  await steps.placePicture(page, ctx.media);
}

const rows = [
  {
    id: ROW_ID,
    area: 'Monitor snapping',
    title:
      'Monitor snapping: a clip dragged near the canvas centre lands exactly on it, the guide shows while snapped, Ctrl turns snapping off',
    severity: 'major',
    expected:
      'the snapped centre equals the frame centre within 0.5 unit with a frame-centre guide and readout shown; a Ctrl drag ends at least 1 unit off the centre with no guide',
    async run(page, ctx) {
      if (!ctx.media)
        throw new Error(
          `BLOCKED-on-fixture ${ROW_ID}: needs --media <picture file in the fixtures folder>; the row imports it and places it on the timeline`,
        );
      // A fresh still picture avoids the sample's animated, oversized object and its clipped drag target.
      await prepareSnapPicture(page, ctx);
      await page.locator('.timeline-clip').first().waitFor({ state: 'visible', timeout: 15_000 });
      // Select the clip on the timeline: the Monitor then draws its outline (the same route the other Monitor rows use).
      await page.locator('.timeline-clip').first().click();
      await waitForSelection(page);

      await _scaleDown(page);

      // Setup (not asserted): move the element off the centre by a clear distance, so the snap drag has a real move.
      const setupOutline = await elementOutline(page);
      const setupFrom = grabOf(setupOutline);
      const beforeSetup = (await readElement(page)).transform;
      await dragAndObserve(
        page,
        setupFrom,
        {
          x: setupFrom.x + SETUP_OFFSET_PX.x,
          y: setupFrom.y + SETUP_OFFSET_PX.y,
        },
        { ctrl: false, observe: false },
      );
      const afterSetup = await waitForMoved(page, beforeSetup);
      if (
        Math.abs(afterSetup.transform.x - beforeSetup.x) < 1e-6 &&
        Math.abs(afterSetup.transform.y - beforeSetup.y) < 1e-6
      )
        throw new Error(`${ROW_ID}: the setup drag did not move the picture`);

      // Snap drag: the element's unsnapped centre ends SNAP_OFFSET_PX right of the canvas centre, inside the snap range.
      const geometry = await monitorGeometry(page);
      const element = await readElement(page);
      const frame = element.frame;
      const canvasCentre = canvasCentreOnScreen(geometry, frame);
      const snapOutline = await elementOutline(page);
      const snapFrom = grabOf(snapOutline);
      const snapTo = {
        x: snapFrom.x + (canvasCentre.x + SNAP_OFFSET_PX - centreOf(snapOutline).x),
        y: snapFrom.y + (canvasCentre.y - centreOf(snapOutline).y),
      };
      const held = await dragAndObserve(page, snapFrom, snapTo, {
        ctrl: false,
        onHeld: () => ctx.shot(ROW_ID, 'snapped-held'),
      });
      const heldReadout = parseReadout(held.readout);
      const lines = [];
      if (!held.overlay)
        throw new Error(
          `${ROW_ID}: no snap overlay while the mouse was down; saw overlay ${held.overlay}, readout ${held.readout ?? 'none'}, guides ${held.guides.length}`,
        );
      if (heldReadout === null)
        throw new Error(
          `${ROW_ID}: the snap readout text is not the X/Y/W/H form; saw ${JSON.stringify(held.readout)}`,
        );
      const frameGuide = held.guides.find(
        (guide) => guide.axis === 'x' && guide.kind === 'frame-centre',
      );
      if (!frameGuide)
        throw new Error(
          `${ROW_ID}: no frame-centre guide while snapped; saw guides ${JSON.stringify(held.guides)}`,
        );
      // The guide sits on the frame centre on screen: this checks the screen mapping the snap offset depends on.
      const guideOffsetPx = frameGuide.left - canvasCentre.x;
      if (Math.abs(guideOffsetPx) > 2)
        throw new Error(
          `${ROW_ID}: the frame-centre guide is ${round(guideOffsetPx)} px from the canvas centre the row computed; the screen mapping is wrong`,
        );
      const heldShot = held.shot;

      await page.waitForTimeout(150);
      const snappedElement = await waitForMoved(page, element.transform);
      const snappedCentre = centreFromTransform(snappedElement.transform, heldReadout);
      const snappedOff = offsetFromFrameCentre(snappedCentre, frame);
      if (
        Math.abs(snappedOff.x) > CENTRE_TOLERANCE_UNITS ||
        Math.abs(snappedOff.y) > CENTRE_TOLERANCE_UNITS
      )
        throw new Error(
          `${ROW_ID}: the snapped centre is (${round(snappedCentre.x)}, ${round(snappedCentre.y)}), ${round(snappedOff.x)} and ${round(snappedOff.y)} units from the frame centre (${frame.width / 2}, ${frame.height / 2}); want within ${CENTRE_TOLERANCE_UNITS}`,
        );
      const readoutAgrees = Math.abs(heldReadout.x - snappedElement.transform.x) <= 1;
      if (!readoutAgrees)
        throw new Error(
          `${ROW_ID}: the readout X ${heldReadout.x} does not match the document x ${round(snappedElement.transform.x)}`,
        );

      // Ctrl drag: from the snapped centre, 4 px right with Control held. Snapping must be off: no guide, and the centre lands off the frame centre.
      const ctrlFrom = grabOf(await elementOutline(page));
      const ctrlTo = { x: ctrlFrom.x + SNAP_OFFSET_PX, y: ctrlFrom.y };
      const ctrlHeld = await dragAndObserve(page, ctrlFrom, ctrlTo, { ctrl: true });
      if (ctrlHeld.guides.length !== 0)
        throw new Error(
          `${ROW_ID}: a guide was shown with Ctrl held: ${JSON.stringify(ctrlHeld.guides)}`,
        );
      const ctrlReadout = parseReadout(ctrlHeld.readout);
      await page.waitForTimeout(150);
      const ctrlElement = await waitForMoved(page, snappedElement.transform);
      const ctrlBox = ctrlReadout ?? heldReadout;
      const ctrlCentre = centreFromTransform(ctrlElement.transform, ctrlBox);
      const ctrlOff = offsetFromFrameCentre(ctrlCentre, frame);
      const ctrlUnits = Math.hypot(ctrlOff.x, ctrlOff.y);
      if (ctrlUnits < UNSNAPPED_MIN_UNITS)
        throw new Error(
          `${ROW_ID}: with Ctrl held the centre is still on the frame centre (${round(ctrlOff.x)}, ${round(ctrlOff.y)} units off); want at least ${UNSNAPPED_MIN_UNITS} unit`,
        );

      const numbers = {
        frame,
        zoom: geometry.zoom,
        snapOffsetPx: SNAP_OFFSET_PX,
        frameCentreScreenPx: canvasCentre,
        guideOffsetPx: round(guideOffsetPx),
        heldReadout,
        snappedCentre: { x: round(snappedCentre.x), y: round(snappedCentre.y) },
        snappedOffsetUnits: { x: round(snappedOff.x), y: round(snappedOff.y) },
        guidesWhileSnapped: held.guides,
        ctrlReadout,
        ctrlCentre: { x: round(ctrlCentre.x), y: round(ctrlCentre.y) },
        ctrlOffsetUnits: { x: round(ctrlOff.x), y: round(ctrlOff.y) },
        ctrlGuides: ctrlHeld.guides.length,
      };
      const dir = join(ctx.outDir, ROW_ID);
      await mkdir(dir, { recursive: true });
      const numbersPath = join(dir, 'snap-numbers.json');
      await writeFile(numbersPath, `${JSON.stringify(numbers, null, 2)}\n`, 'utf8');

      lines.push(
        `snapped: centre (${round(snappedCentre.x)}, ${round(snappedCentre.y)}) is ${round(snappedOff.x)}, ${round(snappedOff.y)} units from the frame centre (${frame.width / 2}, ${frame.height / 2}); frame-centre guide shown ${round(guideOffsetPx)} px from the row's canvas centre; readout ${held.readout}`,
        `Ctrl held: centre (${round(ctrlCentre.x)}, ${round(ctrlCentre.y)}) is ${round(ctrlOff.x)}, ${round(ctrlOff.y)} units off the frame centre, ${ctrlHeld.guides.length} guides`,
        `zoom ${geometry.zoom}`,
      );
      return {
        message: lines.join('; '),
        evidence: [numbersPath, heldShot].filter((path) => typeof path === 'string'),
      };
    },
  },
];

export const MONITOR_SNAP_ROWS = Object.freeze(rows);
export const MONITOR_SNAP_ROWS_BY_ID = Object.freeze(
  Object.fromEntries(rows.map((row) => [row.id, row])),
);
