/**
 * The colour engine's curve spline, prepared once and sampled many times
 * (T-K03 review fix).
 *
 * `sampleColorCurve` used to sort the points and build the slope and tangent
 * arrays again for every single sample, so a 256-entry table or a 256-sample
 * graph line did that work 256 times. A `ColorCurveSpline` does it once per
 * curve, into buffers it keeps, and then answers any number of samples
 * without allocating. The numbers are exactly the ones the old code gave:
 * the same order of points, the same arithmetic in the same order.
 */

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Points a fresh spline has room for before it has to grow its buffers. */
const INITIAL_CAPACITY = 16;

export class ColorCurveSpline {
  private xs: Float64Array;
  private ys: Float64Array;
  private slopes: Float64Array;
  private tangents: Float64Array;
  private count = 0;
  /** Fewer than two usable points: the spline is the straight line. */
  private straight = true;
  /** How many times the buffers were made (once, unless a curve outgrew them). */
  allocations = 0;
  /** How many curves were prepared. */
  prepares = 0;

  constructor(capacity = INITIAL_CAPACITY) {
    const size = Math.max(2, capacity);
    this.xs = new Float64Array(size);
    this.ys = new Float64Array(size);
    this.slopes = new Float64Array(size);
    this.tangents = new Float64Array(size);
    this.allocations = 1;
  }

  /** Room for at least `size` points; grows (and counts) only when needed. */
  private reserve(size: number): void {
    if (size <= this.xs.length) return;
    let next = this.xs.length;
    while (next < size) next *= 2;
    this.xs = new Float64Array(next);
    this.ys = new Float64Array(next);
    this.slopes = new Float64Array(next);
    this.tangents = new Float64Array(next);
    this.allocations += 1;
  }

  /**
   * Prepares the spline through `points`: drops points that are not finite,
   * clamps them into the unit square, orders them by input (ties keep their
   * order), keeps the first of points on the same input, then computes the
   * slopes and the monotone tangents once.
   */
  prepare(points: readonly { readonly x: number; readonly y: number }[]): this {
    this.prepares += 1;
    this.count = 0;
    this.straight = true;
    if (points.length < 2) return this;
    this.reserve(points.length);
    const xs = this.xs;
    const ys = this.ys;
    let count = 0;
    for (let source = 0; source < points.length; source += 1) {
      const point = points[source]!;
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      const x = clamp01(point.x);
      const y = clamp01(point.y);
      // Insertion sort, stable: a point goes after every point with the same input.
      let at = count;
      while (at > 0 && xs[at - 1]! > x) {
        xs[at] = xs[at - 1]!;
        ys[at] = ys[at - 1]!;
        at -= 1;
      }
      xs[at] = x;
      ys[at] = y;
      count += 1;
    }
    // Keep the first point on each input.
    let kept = 0;
    for (let index = 0; index < count; index += 1) {
      if (index > 0 && !(xs[index]! > xs[kept - 1]!)) continue;
      xs[kept] = xs[index]!;
      ys[kept] = ys[index]!;
      kept += 1;
    }
    if (kept < 2) return this;
    this.count = kept;
    this.straight = false;
    const lastIndex = kept - 1;
    const slopes = this.slopes;
    const tangents = this.tangents;
    for (let index = 0; index < lastIndex; index += 1)
      slopes[index] = (ys[index + 1]! - ys[index]!) / (xs[index + 1]! - xs[index]!);
    for (let index = 0; index <= lastIndex; index += 1) {
      if (index === 0) {
        tangents[index] = slopes[0]!;
        continue;
      }
      if (index === lastIndex) {
        tangents[index] = slopes[lastIndex - 1]!;
        continue;
      }
      const before = slopes[index - 1]!;
      const after = slopes[index]!;
      if (before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)) {
        tangents[index] = 0;
        continue;
      }
      const h0 = xs[index]! - xs[index - 1]!;
      const h1 = xs[index + 1]! - xs[index]!;
      const w1 = 2 * h1 + h0;
      const w2 = h1 + 2 * h0;
      tangents[index] = (w1 + w2) / (w1 / before + w2 / after);
    }
    return this;
  }

  /** The output for an input, with no allocation. */
  valueAt(input: number): number {
    if (this.straight) return clamp01(input);
    const xs = this.xs;
    const ys = this.ys;
    const tangents = this.tangents;
    const lastIndex = this.count - 1;
    const x = clamp01(input);
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[lastIndex]!) return ys[lastIndex]!;
    for (let index = 0; index < lastIndex; index += 1) {
      const rightX = xs[index + 1]!;
      if (x > rightX) continue;
      const leftX = xs[index]!;
      const width = rightX - leftX;
      const t = (x - leftX) / width;
      const t2 = t * t;
      const t3 = t2 * t;
      return clamp01(
        (2 * t3 - 3 * t2 + 1) * ys[index]! +
          (t3 - 2 * t2 + t) * width * tangents[index]! +
          (-2 * t3 + 3 * t2) * ys[index + 1]! +
          (t3 - t2) * width * tangents[index + 1]!,
      );
    }
    return ys[lastIndex]!;
  }
}
