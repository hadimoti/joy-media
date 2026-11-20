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
  const match = /X (-?\d+)\s+Y (-?\d+)\s+W (\d+)\s+H (\d+)\s+A (-?\d+(?:\.\d+)?)°/u.exec(
    text ?? '',
  );
  if (match === null) return null;
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4]),
    angle: Number(match[5]),
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

async function readElement(page, expectedClipId = null) {
  const visual = await readLiveVisualProject(page);
  if (!visual || typeof visual.visualObjects !== 'object' || !visual.compositions)
    throw new Error(`${ROW_ID}: could not read the live visual project (no editor session found)`);
  const elements = Object.values(visual.visualObjects).filter(
    (object) => object && object.transform,
  );
  const clipId =
    expectedClipId ??
    (await page
      .locator('.monitor-selection-overlay polygon[data-clip-id]')
      .first()
      .getAttribute('data-clip-id')
      .catch(() => null));
  const bindings = visual.pluginData?.['joy.clipObjects'];
  const selectedId = clipId && bindings && typeof bindings === 'object' ? bindings[clipId] : null;
  const selected = selectedId ? visual.visualObjects[selectedId] : undefined;
  if (selectedId && !selected)
    throw new Error(`${ROW_ID}: selected clip ${clipId} has no bound visual object`);
  if (!selected && elements.length !== 1)
    throw new Error(`${ROW_ID}: expected one selected visual element, found ${elements.length}`);
  const element = selected ?? elements[0];
  const composition =
    visual.compositions[visual.rootCompositionId] ?? Object.values(visual.compositions)[0];
  if (!Number.isFinite(composition?.width) || !Number.isFinite(composition?.height))
    throw new Error(`${ROW_ID}: the root composition has no width and height in the live project`);
  const t = element.transform;
  return {
    id: element.id,
    transform: {
      x: t.x,
      y: t.y,
      scaleX: t.scaleX,
      scaleY: t.scaleY,
      rotationDeg: t.rotationDeg ?? 0,
    },
    frame: { width: composition.width, height: composition.height },
  };
}

async function monitorGeometry(page, frameWidth = 1920) {
  const border = await page
    .locator('svg[data-monitor-overlay="canvas-border"]')
    .boundingBox()
    .catch(() => null);
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
  if (border !== null)
    return {
      ...geometry,
      frameLeft: border.x,
      frameTop: border.y,
      zoom: border.width / frameWidth,
    };
  return geometry;
}

/** The screen box of the selected element's outline (its bounding box on the Monitor). */
async function elementOutline(page) {
  const selection = page.locator('.monitor-selection-overlay polygon[data-clip-id]').first();
  const transform = page
    .locator('.monitor-transform-layer polygon.monitor-transform-outline')
    .first();
  const outline = (await selection.count()) > 0 ? selection : transform;
  const box = await outline
    .evaluate((polygon) => {
      const bounds = polygon.getBBox();
      const matrix = polygon.getScreenCTM();
      if (!matrix) return null;
      const corners = [
        { x: bounds.x, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y },
        { x: bounds.x, y: bounds.y + bounds.height },
        { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
      ].map((point) => ({
        x: matrix.a * point.x + matrix.c * point.y + matrix.e,
        y: matrix.b * point.x + matrix.d * point.y + matrix.f,
      }));
      const left = Math.min(...corners.map((point) => point.x));
      const top = Math.min(...corners.map((point) => point.y));
      const right = Math.max(...corners.map((point) => point.x));
      const bottom = Math.max(...corners.map((point) => point.y));
      return { x: left, y: top, width: right - left, height: bottom - top };
    })
    .catch(() => null);
  if (box === null)
    throw new Error(`${ROW_ID}: the element has no transform outline on the Monitor`);
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

async function waitForClipSelection(page, clipId) {
  const deadline = Date.now() + OVERLAY_TIMEOUT_MS;
  let selected = null;
  while (Date.now() < deadline && selected !== clipId) {
    selected = await page
      .locator('.monitor-selection-overlay polygon[data-clip-id]')
      .first()
      .getAttribute('data-clip-id')
      .catch(() => null);
    if (selected !== clipId) await page.waitForTimeout(50);
  }
  if (selected !== clipId)
    throw new Error(
      `${ROW_ID}: expected selected clip ${clipId}; saw ${selected ?? 'no selection'}`,
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

function anchorOnScreen(box, axis, anchor) {
  const start = axis === 'x' ? box.x : box.y;
  const size = axis === 'x' ? box.width : box.height;
  return anchor === 'start' ? start : anchor === 'end' ? start + size : start + size / 2;
}

function frameLineOnScreen(axis, position, geometry) {
  return axis === 'x'
    ? (geometry.frameLeft ?? geometry.left + geometry.panX) + position * geometry.zoom
    : (geometry.frameTop ?? geometry.top + geometry.panY) + position * geometry.zoom;
}

async function openMonitorView(page) {
  const trigger = page.locator('.monitor-view-trigger');
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
}

async function enableMonitorViewSwitch(page, key) {
  await openMonitorView(page);
  const toggle = page.locator(`[data-monitor-view-switch="${key}"]`);
  if ((await toggle.getAttribute('aria-checked')) !== 'true')
    await toggle.evaluate((element) => element.click());
  if ((await toggle.getAttribute('aria-checked')) !== 'true')
    throw new Error(`${ROW_ID}: enabling the Monitor ${key} view switch did not take effect`);
}

async function clearUserGuides(page) {
  await openMonitorView(page);
  const clearButton = page.locator('.monitor-view-clear');
  if (await clearButton.isEnabled()) await clearButton.evaluate((element) => element.click());
  await page.keyboard.press('Escape');
}

async function addUserGuide(page, axis, position, geometry, frame) {
  await enableMonitorViewSwitch(page, 'rulers');
  await page.keyboard.press('Escape');
  const ruler = page.locator(`[data-monitor-ruler="${axis === 'x' ? 'left' : 'top'}"]`);
  const bounds = await ruler.boundingBox();
  if (bounds === null) throw new Error(`${ROW_ID}: the ${axis}-axis ruler is not visible`);
  const canvasCentre = canvasCentreOnScreen(geometry, frame);
  const from = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const to =
    axis === 'x'
      ? { x: frameLineOnScreen('x', position, geometry), y: canvasCentre.y }
      : { x: canvasCentre.x, y: frameLineOnScreen('y', position, geometry) };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  try {
    await page.mouse.move(to.x, to.y, { steps: 8 });
  } finally {
    await page.mouse.up();
  }
  await page.locator(`[data-monitor-guide="${axis}"]`).waitFor({ state: 'attached' });
}

async function addTextTarget(page) {
  const before = new Set(
    await page
      .locator('.timeline-clip[data-clip-id]')
      .evaluateAll((clips) => clips.map((clip) => clip.getAttribute('data-clip-id'))),
  );
  await openMenu(page, 'View');
  await page.getByRole('menuitem', { name: 'Create', exact: true }).click();
  await page.locator('[role="tab"][data-feature-tool="text"]').click();
  await page
    .locator('section[aria-label="Text templates"] button[aria-label^="Add "]')
    .first()
    .click();
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let clipId = null;
  while (Date.now() < deadline && clipId === null) {
    clipId = await page.locator('.timeline-clip[data-clip-id]').evaluateAll(
      (clips, oldIds) => {
        const next = clips.find((clip) => !oldIds.includes(clip.getAttribute('data-clip-id')));
        return next?.getAttribute('data-clip-id') ?? null;
      },
      [...before],
    );
    if (clipId === null) await page.waitForTimeout(100);
  }
  if (clipId === null)
    throw new Error(`${ROW_ID}: adding a text template did not add a timeline element`);
  await page.locator('.timeline-clip[data-clip-id]').evaluateAll((clips, wanted) => {
    clips.find((clip) => clip.getAttribute('data-clip-id') === wanted)?.click();
  }, clipId);
  await waitForSelection(page);
  for (const [label, value] of [
    ['Position X', '200'],
    ['Position Y', '300'],
  ]) {
    const field = page.locator(`[data-property-row="${label}"] input`).first();
    await field.fill(value);
    await field.press('Enter');
  }
  const targetDeadline = Date.now() + SETTLE_TIMEOUT_MS;
  let target = await readElement(page, clipId);
  while (
    Date.now() < targetDeadline &&
    (Math.abs(target.transform.x - 200) > 1e-3 || Math.abs(target.transform.y - 300) > 1e-3)
  ) {
    await page.waitForTimeout(100);
    target = await readElement(page, clipId);
  }
  if (Math.abs(target.transform.x - 200) > 1e-3 || Math.abs(target.transform.y - 300) > 1e-3)
    throw new Error(
      `${ROW_ID}: peer text position is ${target.transform.x}, ${target.transform.y}; expected 200, 300`,
    );
  return clipId;
}

const TARGET_CASES = [
  {
    id: 'D-M06-02',
    title: 'Monitor snapping to the upper-left canvas edges',
    expected:
      'the picture left and top edges land exactly on the canvas edges with both guides visible',
    x: { kind: 'frame-edge', position: 0, anchor: 'start' },
    y: { kind: 'frame-edge', position: 0, anchor: 'start' },
  },
  {
    id: 'D-M06-03',
    title: 'Monitor snapping to the lower-right canvas edges',
    expected:
      'the picture right and bottom edges land exactly on the canvas edges with both guides visible',
    x: { kind: 'frame-edge', edge: 'far', anchor: 'end' },
    y: { kind: 'frame-edge', edge: 'far', anchor: 'end' },
  },
  {
    id: 'D-M06-04',
    title: 'Monitor snapping to the title-safe margins',
    expected:
      'the picture left and top edges land exactly on the title-safe margins with both guides visible',
    x: { kind: 'title-safe', edge: 'near', anchor: 'start' },
    y: { kind: 'title-safe', edge: 'near', anchor: 'start' },
  },
  {
    id: 'D-M06-05',
    title: 'Monitor snapping to the action-safe margins',
    expected:
      'the picture right and bottom edges land exactly on the action-safe margins with both guides visible',
    x: { kind: 'action-safe', edge: 'far', anchor: 'end' },
    y: { kind: 'action-safe', edge: 'far', anchor: 'end' },
  },
  {
    id: 'D-M06-06',
    title: 'Monitor snapping to user guides',
    expected:
      'the picture left and top edges land exactly on saved user guides with both guides visible',
    x: { kind: 'user-guide', position: 640, anchor: 'start' },
    y: { kind: 'user-guide', position: 320, anchor: 'start' },
  },
  {
    id: 'D-M06-07',
    title: 'Monitor snapping to other element edges',
    expected:
      'the picture left and top edges land exactly on another element’s right and bottom edges',
    other: true,
    x: { kind: 'element-edge', otherEdge: 'far', anchor: 'start' },
    y: { kind: 'element-edge', otherEdge: 'far', anchor: 'start' },
  },
  {
    id: 'D-M06-08',
    title: 'Monitor snapping to other element centres',
    expected: 'the picture centre lands exactly on another element’s centre on both axes',
    other: true,
    x: { kind: 'element-centre', anchor: 'centre' },
    y: { kind: 'element-centre', anchor: 'centre' },
  },
];

function targetPosition(target, axis, frame, otherOutline) {
  if (target.otherEdge !== undefined) {
    const start = axis === 'x' ? otherOutline.x : otherOutline.y;
    const size = axis === 'x' ? otherOutline.width : otherOutline.height;
    return start + (target.otherEdge === 'far' ? size : 0);
  }
  if (target.kind === 'element-centre')
    return axis === 'x'
      ? otherOutline.x + otherOutline.width / 2
      : otherOutline.y + otherOutline.height / 2;
  if (target.position !== undefined) return target.position;
  if (target.kind === 'frame-edge')
    return target.edge === 'far' ? frame[axis === 'x' ? 'width' : 'height'] : 0;
  const inset = target.kind === 'title-safe' ? 0.05 : 0.035;
  const length = frame[axis === 'x' ? 'width' : 'height'];
  return length * (target.edge === 'far' ? 1 - inset : inset);
}

async function runTargetCase(page, ctx, spec) {
  if (!ctx.media)
    throw new Error(
      `BLOCKED-on-fixture ${spec.id}: needs --media <picture file in the fixtures folder>`,
    );
  await prepareSnapPicture(page, ctx);
  await page
    .locator('.timeline-clip[data-clip-id]')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });
  const pictureClipId = await page
    .locator('.timeline-clip[data-clip-id]')
    .first()
    .getAttribute('data-clip-id');
  if (!pictureClipId) throw new Error(`${spec.id}: the picture clip has no id`);
  await page.locator('.timeline-clip[data-clip-id]').first().click();
  await waitForSelection(page);
  await _scaleDown(page);
  await clearUserGuides(page);
  await enableMonitorViewSwitch(page, 'canvasBorder');
  const element = await readElement(page);

  let otherOutline = null;
  if (spec.other) {
    await addTextTarget(page);
    const otherScreenOutline = await elementOutline(page);
    await page.locator('.timeline-clip[data-clip-id]').evaluateAll((clips, wanted) => {
      clips.find((clip) => clip.getAttribute('data-clip-id') === wanted)?.click();
    }, pictureClipId);
    await waitForClipSelection(page, pictureClipId);
    const geometry = await monitorGeometry(page, element.frame.width);
    otherOutline = {
      x: (otherScreenOutline.x - frameLineOnScreen('x', 0, geometry)) / geometry.zoom,
      y: (otherScreenOutline.y - frameLineOnScreen('y', 0, geometry)) / geometry.zoom,
      width: otherScreenOutline.width / geometry.zoom,
      height: otherScreenOutline.height / geometry.zoom,
    };
  }

  const geometry = await monitorGeometry(page, element.frame.width);
  const sourceOutline = await elementOutline(page);
  const xPosition = targetPosition(spec.x, 'x', element.frame, otherOutline);
  const yPosition = targetPosition(spec.y, 'y', element.frame, otherOutline);
  if (spec.x.kind === 'user-guide')
    await addUserGuide(page, 'x', xPosition, geometry, element.frame);
  if (spec.y.kind === 'user-guide')
    await addUserGuide(page, 'y', yPosition, geometry, element.frame);
  const targetScreen = {
    x: frameLineOnScreen('x', xPosition, geometry),
    y: frameLineOnScreen('y', yPosition, geometry),
  };
  const snapTo = {
    x:
      grabOf(sourceOutline).x +
      targetScreen.x +
      SNAP_OFFSET_PX -
      anchorOnScreen(sourceOutline, 'x', spec.x.anchor),
    y:
      grabOf(sourceOutline).y +
      targetScreen.y +
      SNAP_OFFSET_PX -
      anchorOnScreen(sourceOutline, 'y', spec.y.anchor),
  };
  const before = element.transform;
  const held = await dragAndObserve(page, grabOf(sourceOutline), snapTo, {
    ctrl: false,
    onHeld: () => ctx.shot(spec.id, 'snapped-held'),
  });
  const readout = parseReadout(held.readout);
  if (!held.overlay || readout === null || !Number.isFinite(readout.angle))
    throw new Error(
      `${spec.id}: snap overlay/readout with X, Y, W, H and angle was not visible while held`,
    );
  for (const [axis, target] of [
    ['x', spec.x],
    ['y', spec.y],
  ]) {
    const guide = held.guides.find(
      (candidate) => candidate.axis === axis && candidate.kind === target.kind,
    );
    if (!guide)
      throw new Error(
        `${spec.id}: expected ${axis} ${target.kind} guide; saw ${JSON.stringify(held.guides)}`,
      );
    const guidePosition = axis === 'x' ? guide.left : guide.top;
    if (Math.abs(guidePosition - targetScreen[axis]) > 0.5)
      throw new Error(
        `${spec.id}: ${axis} ${target.kind} guide is ${round(guidePosition - targetScreen[axis])} screen px from its target`,
      );
  }
  const after = await waitForMoved(page, before);
  const finalOutline = await elementOutline(page);
  const finalOffset = {
    x: anchorOnScreen(finalOutline, 'x', spec.x.anchor) - targetScreen.x,
    y: anchorOnScreen(finalOutline, 'y', spec.y.anchor) - targetScreen.y,
  };
  if (Math.abs(finalOffset.x) > 0.1 || Math.abs(finalOffset.y) > 0.1)
    throw new Error(
      `${spec.id}: final target offset is ${round(finalOffset.x)}, ${round(finalOffset.y)} screen px; expected 0`,
    );

  const dir = join(ctx.outDir, spec.id);
  await mkdir(dir, { recursive: true });
  const numbersPath = join(dir, 'snap-numbers.json');
  const numbers = {
    frame: element.frame,
    zoom: geometry.zoom,
    targetKinds: { x: spec.x.kind, y: spec.y.kind },
    targetPositions: { x: xPosition, y: yPosition },
    targetScreen,
    finalOffsetScreenPx: finalOffset,
    readout,
    guidesWhileSnapped: held.guides,
    finalTransform: after.transform,
  };
  await writeFile(numbersPath, `${JSON.stringify(numbers, null, 2)}\n`, 'utf8');
  return {
    message: `snapped exactly to ${spec.x.kind} X and ${spec.y.kind} Y; final offsets ${round(finalOffset.x)}, ${round(finalOffset.y)} screen px; held readout ${held.readout}`,
    evidence: [numbersPath, held.shot].filter((path) => typeof path === 'string'),
  };
}

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
  ...TARGET_CASES.map((spec) => ({
    id: spec.id,
    area: 'Monitor snapping',
    title: spec.title,
    severity: 'major',
    expected: spec.expected,
    run: (page, ctx) => runTargetCase(page, ctx, spec),
  })),
];

export const MONITOR_SNAP_ROWS = Object.freeze(rows);
export const MONITOR_SNAP_ROWS_BY_ID = Object.freeze(
  Object.fromEntries(rows.map((row) => [row.id, row])),
);
