/**
 * Durable time primitives (master plan §10.5, ADR-0002).
 *
 * - All durable media time is integer microseconds (`TimeUs`), never float seconds.
 * - Frame rates are rationals such as { num: 30000, den: 1001 }.
 * - Frame mapping rule: frame `i` starts at `ceil(i * 1e6 * den / num)` µs and
 *   time `t` belongs to frame `floor(t * num / (1e6 * den))`. With this pair,
 *   `frameIndexAtUs(frameStartUs(i, r), r) === i` holds exactly for every rate
 *   with num < 1e6 * den (i.e. below one million fps).
 * - Ranges are end-exclusive: [startUs, startUs + durationUs).
 */

/** Integer microseconds. Alias (not branded) for the spike; see ADR-0002. */
export type TimeUs = number;

export interface Rational {
  readonly num: number;
  readonly den: number;
}

export interface TimeRange {
  readonly startUs: TimeUs;
  readonly durationUs: number;
}

const US_PER_SECOND = 1_000_000n;

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, got ${value}`);
  }
}

function toSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds the safe integer range: ${value}`);
  }
  return Number(value);
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** Floor division for non-negative BigInts. */
function floorDiv(a: bigint, b: bigint): bigint {
  return a / b;
}

/** Ceiling division for non-negative BigInts. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Validates and constructs a positive rational (frame rates, aspect ratios). */
export function rational(num: number, den: number): Rational {
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new RangeError(`rational num must be a positive safe integer, got ${num}`);
  }
  if (!Number.isSafeInteger(den) || den <= 0) {
    throw new RangeError(`rational den must be a positive safe integer, got ${den}`);
  }
  return { num, den };
}

/** Reduces a rational to lowest terms. */
export function normalizeRational(r: Rational): Rational {
  const g = gcd(BigInt(r.num), BigInt(r.den));
  return { num: Number(BigInt(r.num) / g), den: Number(BigInt(r.den) / g) };
}

/** Exact equality via cross-multiplication — no floats, no normalization required. */
export function rationalsEqual(a: Rational, b: Rational): boolean {
  return BigInt(a.num) * BigInt(b.den) === BigInt(b.num) * BigInt(a.den);
}

export function compareRationals(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = BigInt(a.num) * BigInt(b.den);
  const right = BigInt(b.num) * BigInt(a.den);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * First integer microsecond belonging to `frameIndex` at `rate`:
 * `ceil(frameIndex * 1e6 * den / num)`.
 */
export function frameStartUs(frameIndex: number, rate: Rational): TimeUs {
  assertSafeNonNegativeInteger(frameIndex, 'frameIndex');
  const start = ceilDiv(BigInt(frameIndex) * US_PER_SECOND * BigInt(rate.den), BigInt(rate.num));
  return toSafeNumber(start, 'frameStartUs');
}

/**
 * Frame whose interval [frameStartUs(i), frameStartUs(i+1)) contains `timeUs`:
 * `floor(timeUs * num / (1e6 * den))`.
 */
export function frameIndexAtUs(timeUs: TimeUs, rate: Rational): number {
  assertSafeNonNegativeInteger(timeUs, 'timeUs');
  const index = floorDiv(BigInt(timeUs) * BigInt(rate.num), US_PER_SECOND * BigInt(rate.den));
  return toSafeNumber(index, 'frameIndexAtUs');
}

/** Snaps a time to the start of the frame that contains it. Idempotent. */
export function snapUsToFrame(timeUs: TimeUs, rate: Rational): TimeUs {
  return frameStartUs(frameIndexAtUs(timeUs, rate), rate);
}

/** Validates and constructs a general time range (`durationUs >= 0`, e.g. markers). */
export function timeRange(startUs: TimeUs, durationUs: number): TimeRange {
  assertSafeNonNegativeInteger(startUs, 'startUs');
  assertSafeNonNegativeInteger(durationUs, 'durationUs');
  assertSafeNonNegativeInteger(startUs + durationUs, 'startUs + durationUs');
  return { startUs, durationUs };
}

/**
 * Validates and constructs a clip time range. Clips require `durationUs > 0`
 * (§10.5 as corrected in v1.1); zero-duration entities are markers, never clips.
 */
export function clipTimeRange(startUs: TimeUs, durationUs: number): TimeRange {
  const range = timeRange(startUs, durationUs);
  if (durationUs === 0) {
    throw new RangeError('clip durationUs must be > 0; zero-duration entities are markers');
  }
  return range;
}

/** Exclusive end of a range. */
export function rangeEndUs(range: TimeRange): TimeUs {
  return range.startUs + range.durationUs;
}

/** End-exclusive containment: startUs <= timeUs < startUs + durationUs. */
export function rangeContainsUs(range: TimeRange, timeUs: TimeUs): boolean {
  return timeUs >= range.startUs && timeUs < rangeEndUs(range);
}

/** Intersection of two ranges, or null when they do not overlap. */
export function intersectRanges(a: TimeRange, b: TimeRange): TimeRange | null {
  const startUs = Math.max(a.startUs, b.startUs);
  const endUs = Math.min(rangeEndUs(a), rangeEndUs(b));
  if (endUs <= startUs) return null;
  return { startUs, durationUs: endUs - startUs };
}
