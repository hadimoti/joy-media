import type { MonitorUserGuide } from './monitor-view-options.js';
import type { MonitorSize } from './monitor-view-state.js';

/** A rectangle in authored frame pixels. */
export interface SnapBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type SnapAxis = 'x' | 'y';

/** The reason a snap line exists, used by tests and the editor overlay. */
export type SnapTargetKind =
  | 'frame-edge'
  | 'frame-centre'
  | 'title-safe'
  | 'action-safe'
  | 'user-guide'
  | 'element-edge'
  | 'element-centre';

export interface SnapTarget {
  readonly axis: SnapAxis;
  readonly position: number;
  readonly kind: SnapTargetKind;
}

export interface SnapResult {
  readonly box: SnapBox;
  readonly guides: readonly SnapTarget[];
}

/** Maximum distance in CSS pixels from a target line. */
export const SNAP_DISTANCE_SCREEN_PX = 6;

type ScaleHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

function finiteBox(box: SnapBox): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width >= 0 &&
    box.height >= 0
  );
}

function finiteSize(size: MonitorSize): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  );
}

/**
 * The alignment lines available to an element: canvas edges and centre,
 * title-safe (90%), action-safe (93%), saved user guides and other boxes.
 */
export function collectSnapTargets(
  frame: MonitorSize,
  otherBoxes: readonly SnapBox[],
  userGuides: readonly MonitorUserGuide[] = [],
): readonly SnapTarget[] {
  if (!finiteSize(frame)) return [];
  const targets: SnapTarget[] = [];
  const add = (axis: SnapAxis, position: number, kind: SnapTargetKind) => {
    if (Number.isFinite(position)) targets.push({ axis, position, kind });
  };

  add('x', 0, 'frame-edge');
  add('x', frame.width / 2, 'frame-centre');
  add('x', frame.width, 'frame-edge');
  add('y', 0, 'frame-edge');
  add('y', frame.height / 2, 'frame-centre');
  add('y', frame.height, 'frame-edge');

  // The inset is half the amount removed from the whole frame.
  for (const [kind, inset] of [
    ['title-safe', (1 - 0.9) / 2],
    ['action-safe', (1 - 0.93) / 2],
  ] as const) {
    add('x', frame.width * inset, kind);
    add('x', frame.width * (1 - inset), kind);
    add('y', frame.height * inset, kind);
    add('y', frame.height * (1 - inset), kind);
  }

  for (const guide of userGuides)
    if (Number.isFinite(guide.position)) add(guide.axis, guide.position, 'user-guide');

  for (const box of otherBoxes) {
    if (!finiteBox(box)) continue;
    add('x', box.x, 'element-edge');
    add('x', box.x + box.width / 2, 'element-centre');
    add('x', box.x + box.width, 'element-edge');
    add('y', box.y, 'element-edge');
    add('y', box.y + box.height / 2, 'element-centre');
    add('y', box.y + box.height, 'element-edge');
  }
  return targets;
}

interface AxisMatch {
  readonly target: SnapTarget;
  readonly sourcePosition: number;
  readonly distance: number;
}

/** Treat sub-pixel floating-point noise at the inclusive six-pixel edge as on the boundary. */
function withinSnapDistance(distance: number): boolean {
  return distance <= SNAP_DISTANCE_SCREEN_PX + 1e-9;
}

function nearestMatch(
  positions: readonly number[],
  targets: readonly SnapTarget[],
  axis: SnapAxis,
  zoom: number,
): AxisMatch | undefined {
  let best: AxisMatch | undefined;
  for (const position of positions) {
    for (const target of targets) {
      if (target.axis !== axis || !Number.isFinite(target.position)) continue;
      const distance = Math.abs(position - target.position) * zoom;
      if (withinSnapDistance(distance) && (best === undefined || distance < best.distance))
        best = { target, sourcePosition: position, distance };
    }
  }
  return best;
}

/** Align the nearest box edge or centre to a target, independently per axis. */
export function snapMove(
  box: SnapBox,
  targets: readonly SnapTarget[],
  zoom: number,
  ctrlHeld = false,
): SnapResult {
  if (!finiteBox(box) || !Number.isFinite(zoom) || zoom <= 0 || ctrlHeld)
    return { box, guides: [] };

  const xMatch = nearestMatch(
    [box.x, box.x + box.width / 2, box.x + box.width],
    targets,
    'x',
    zoom,
  );
  const yMatch = nearestMatch(
    [box.y, box.y + box.height / 2, box.y + box.height],
    targets,
    'y',
    zoom,
  );
  const guides = [xMatch?.target, yMatch?.target].filter(
    (target): target is SnapTarget => target !== undefined,
  );
  return {
    box: {
      ...box,
      ...(xMatch === undefined
        ? {}
        : { x: box.x + xMatch.target.position - xMatch.sourcePosition }),
      ...(yMatch === undefined
        ? {}
        : { y: box.y + yMatch.target.position - yMatch.sourcePosition }),
    },
    guides,
  };
}

function scaleAxis(
  candidate: SnapBox,
  initial: SnapBox,
  targets: readonly SnapTarget[],
  axis: SnapAxis,
  zoom: number,
  movesStart: boolean,
): { readonly start: number; readonly end: number; readonly guide?: SnapTarget } {
  const start = axis === 'x' ? candidate.x : candidate.y;
  const size = axis === 'x' ? candidate.width : candidate.height;
  const fixed =
    axis === 'x'
      ? movesStart
        ? initial.x + initial.width
        : initial.x
      : movesStart
        ? initial.y + initial.height
        : initial.y;
  const edge = movesStart ? start : start + size;
  const centre = start + size / 2;
  let best:
    { readonly target: SnapTarget; readonly distance: number; readonly edge: number } | undefined;

  for (const target of targets) {
    if (target.axis !== axis || !Number.isFinite(target.position)) continue;
    for (const match of [
      { source: edge, result: target.position },
      { source: centre, result: target.position * 2 - fixed },
    ]) {
      const distance = Math.abs(match.source - target.position) * zoom;
      const nextSize = movesStart ? fixed - match.result : match.result - fixed;
      if (
        withinSnapDistance(distance) &&
        nextSize > 0 &&
        (best === undefined || distance < best.distance)
      )
        best = { target, distance, edge: match.result };
    }
  }

  if (best === undefined)
    return {
      start,
      end: start + size,
    };
  return movesStart
    ? { start: best.edge, end: fixed, guide: best.target }
    : { start: fixed, end: best.edge, guide: best.target };
}

/**
 * Snap a resize's moving edge or centre while keeping the opposite edge fixed.
 * `candidate` is the box before snapping; `initial` is the box at pointer-down.
 */
export function snapScale(
  candidate: SnapBox,
  initial: SnapBox,
  handle: ScaleHandle,
  targets: readonly SnapTarget[],
  zoom: number,
  ctrlHeld = false,
): SnapResult {
  if (
    !finiteBox(candidate) ||
    !finiteBox(initial) ||
    !Number.isFinite(zoom) ||
    zoom <= 0 ||
    ctrlHeld
  )
    return { box: candidate, guides: [] };

  const x =
    handle.includes('e') || handle.includes('w')
      ? scaleAxis(candidate, initial, targets, 'x', zoom, handle.includes('w'))
      : undefined;
  const y =
    handle.includes('n') || handle.includes('s')
      ? scaleAxis(candidate, initial, targets, 'y', zoom, handle.includes('n'))
      : undefined;
  const guides = [x?.guide, y?.guide].filter(
    (target): target is SnapTarget => target !== undefined,
  );
  return {
    box: {
      x: x?.start ?? candidate.x,
      y: y?.start ?? candidate.y,
      width: x === undefined ? candidate.width : x.end - x.start,
      height: y === undefined ? candidate.height : y.end - y.start,
    },
    guides,
  };
}
