import type { ColorCurveChannel, ColorCurvePoint } from '@joy-media/project-schema';
import { ColorCurveSpline, sampleColorCurve } from '@joy-media/renderer-pixi';

/**
 * The maths of the curves editor (T-K03).
 *
 * A curve is a list of points in the unit square, ordered by input (x). The
 * first and the last point are the end points: they stay on the left and the
 * right edge (x = 0 and x = 1) and only their output (y) moves. Points between
 * them never pass each other: each keeps at least one input level away from
 * its neighbours.
 *
 * The line is drawn with `sampleColorCurve`, the monotone spline the colour
 * engine builds its curve tables from (`packages/renderer-pixi`), so what the
 * graph shows is what the preview and the export do.
 */

export type CurvePoint = ColorCurvePoint;
export type CurvePoints = readonly CurvePoint[];

/** The channels in the order of the tabs. */
export const CURVE_CHANNELS: readonly ColorCurveChannel[] = ['rgb', 'red', 'green', 'blue'];

/** The tab names. */
export const CURVE_CHANNEL_LABELS: Readonly<Record<ColorCurveChannel, string>> = {
  rgb: 'RGB',
  red: 'Red',
  green: 'Green',
  blue: 'Blue',
};

/** One input or output level of an 8-bit picture. */
export const CURVE_LEVEL = 1 / 255;
/** Two points keep at least this much input between them. */
export const CURVE_MIN_GAP = CURVE_LEVEL;
/** An arrow key moves a point one level; with Shift, ten. */
export const CURVE_KEYBOARD_STEP = CURVE_LEVEL;
export const CURVE_KEYBOARD_STEP_LARGE = 10 * CURVE_LEVEL;
/** Most points a curve can hold, the ends included. */
export const CURVE_MAX_POINTS = 16;
/** How far outside the graph a point has to be dragged to be removed (unit square). */
export const CURVE_DRAG_OUT_MARGIN = 0.12;

/** The straight line: output equals input. */
export const IDENTITY_CURVE: CurvePoints = Object.freeze([
  { x: 0, y: 0 },
  { x: 1, y: 1 },
]);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * A curve the editor can work on: inside the square, ordered, no two points
 * on the same input, and end points on the edges. A broken stored curve
 * becomes the straight line.
 */
export function editableCurve(points: CurvePoints | undefined): CurvePoints {
  if (points === undefined || points.length < 2) return IDENTITY_CURVE;
  const sorted = points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: clamp01(point.x), y: clamp01(point.y) }))
    .sort((left, right) => left.x - right.x)
    .filter((point, index, all) => index === 0 || point.x > all[index - 1]!.x);
  if (sorted.length < 2) return IDENTITY_CURVE;
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  // An end point that sits inside the square is kept as the edge value: the
  // spline holds it flat to the edge, so the picture does not change.
  const head = first.x === 0 ? [] : [{ x: 0, y: first.y }];
  const tail = last.x === 1 ? [] : [{ x: 1, y: last.y }];
  return [...head, ...sorted, ...tail];
}

/** The output the curve gives for an input, with the colour engine's spline. */
export function curveValueAt(points: CurvePoints, x: number): number {
  return sampleColorCurve(points, clamp01(x));
}

/** True for the end points, which can move up and down only. */
export function isCurveEndPoint(points: CurvePoints, index: number): boolean {
  return index === 0 || index === points.length - 1;
}

/** True when the curve leaves the picture unchanged. */
export function isIdentityCurve(points: CurvePoints): boolean {
  const curve = editableCurve(points);
  return curve.every((point) => Math.abs(point.x - point.y) < 1e-9);
}

/**
 * Adds a point at input `x`, on the line (output = the curve's value there)
 * unless `y` is given. Returns the new curve and the new point's index, or
 * `undefined` when the point cannot be added: too close to another point, on
 * an edge, or the curve is full.
 */
export function addCurvePoint(
  points: CurvePoints,
  x: number,
  y?: number,
): { readonly points: CurvePoints; readonly index: number } | undefined {
  const curve = editableCurve(points);
  if (curve.length >= CURVE_MAX_POINTS) return undefined;
  const input = clamp01(x);
  if (input < CURVE_MIN_GAP || input > 1 - CURVE_MIN_GAP) return undefined;
  if (curve.some((point) => Math.abs(point.x - input) < CURVE_MIN_GAP)) return undefined;
  const output = clamp01(y ?? curveValueAt(curve, input));
  const index = curve.findIndex((point) => point.x > input);
  const next = [...curve.slice(0, index), { x: input, y: output }, ...curve.slice(index)];
  return { points: next, index };
}

/**
 * Moves one point. The end points slide along their edge; a middle point
 * stays between its neighbours, at least one level away from each.
 */
export function moveCurvePoint(
  points: CurvePoints,
  index: number,
  x: number,
  y: number,
): CurvePoints {
  const curve = editableCurve(points);
  if (index < 0 || index >= curve.length) return curve;
  const output = clamp01(y);
  let input: number;
  if (index === 0) input = 0;
  else if (index === curve.length - 1) input = 1;
  else {
    const low = curve[index - 1]!.x + CURVE_MIN_GAP;
    const high = curve[index + 1]!.x - CURVE_MIN_GAP;
    input = Math.max(low, Math.min(high, clamp01(x)));
  }
  return curve.map((point, i) => (i === index ? { x: input, y: output } : point));
}

/** Removes a middle point. The end points cannot be removed. */
export function removeCurvePoint(points: CurvePoints, index: number): CurvePoints {
  const curve = editableCurve(points);
  if (index <= 0 || index >= curve.length - 1) return curve;
  return curve.filter((_, i) => i !== index);
}

/** A middle point dragged this far out of the square is removed on release. */
export function isDraggedOut(points: CurvePoints, index: number, x: number, y: number): boolean {
  if (isCurveEndPoint(points, index)) return false;
  const margin = CURVE_DRAG_OUT_MARGIN;
  return x < -margin || x > 1 + margin || y < -margin || y > 1 + margin;
}

export type CurveNudgeKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

export function isCurveNudgeKey(key: string): key is CurveNudgeKey {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight';
}

/** An arrow key moves a point one level (Shift: ten), with the same limits as a drag. */
export function nudgeCurvePoint(
  points: CurvePoints,
  index: number,
  key: CurveNudgeKey,
  large = false,
): CurvePoints {
  const curve = editableCurve(points);
  const point = curve[index];
  if (point === undefined) return curve;
  const step = large ? CURVE_KEYBOARD_STEP_LARGE : CURVE_KEYBOARD_STEP;
  const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
  const dy = key === 'ArrowDown' ? -step : key === 'ArrowUp' ? step : 0;
  return moveCurvePoint(curve, index, point.x + dx, point.y + dy);
}

/** The point Tab (or Shift+Tab) moves to; `undefined` past either end. */
export function nextCurvePointIndex(
  points: CurvePoints,
  index: number,
  backwards = false,
): number | undefined {
  const next = backwards ? index - 1 : index + 1;
  return next < 0 || next >= points.length ? undefined : next;
}

/** The point under the pointer (unit square), the nearest one within `radius`. */
export function hitCurvePoint(
  points: CurvePoints,
  x: number,
  y: number,
  radius: number,
): number | undefined {
  let best: number | undefined;
  let bestDistance = radius;
  points.forEach((point, index) => {
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** True when the pointer (unit square) is on the drawn line, within `tolerance`. */
export function isOnCurveLine(
  points: CurvePoints,
  x: number,
  y: number,
  tolerance: number,
): boolean {
  if (x < 0 || x > 1) return false;
  return Math.abs(curveValueAt(points, x) - y) <= tolerance;
}

/** Input and output as 8-bit levels, the way the readout shows them. */
export function curveLevels(point: CurvePoint): {
  readonly input: number;
  readonly output: number;
} {
  return { input: Math.round(clamp01(point.x) * 255), output: Math.round(clamp01(point.y) * 255) };
}

/** "In 128, Out 150". */
export function curveReadout(point: CurvePoint): string {
  const { input, output } = curveLevels(point);
  return `In ${input}, Out ${output}`;
}

/**
 * The spline the graph line is drawn with. It is prepared once per drawn
 * curve and keeps its buffers, so drawing the line during a drag allocates
 * nothing per sample.
 */
export const curveLineSpline = new ColorCurveSpline();

/**
 * The SVG path of the line in a `size` × `size` box (y up), one segment per
 * input level, sampled with the colour engine's spline. The spline is
 * prepared once for the whole line, not once per sample.
 */
export function curvePath(
  points: CurvePoints,
  size: number,
  samples = 256,
  spline: ColorCurveSpline = curveLineSpline,
): string {
  spline.prepare(editableCurve(points));
  let path = '';
  for (let index = 0; index < samples; index += 1) {
    const x = index / (samples - 1);
    const y = spline.valueAt(clamp01(x));
    path += `${index === 0 ? 'M' : ' L'}${(x * size).toFixed(2)} ${((1 - y) * size).toFixed(2)}`;
  }
  return path;
}

/** True when two curves have the same points (a pointer move that changed nothing). */
export function sameCurve(left: CurvePoints, right: CurvePoints): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a.x !== b.x || a.y !== b.y) return false;
  }
  return true;
}
