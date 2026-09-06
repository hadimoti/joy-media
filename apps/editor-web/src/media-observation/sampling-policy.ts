export interface OverviewFrameCandidate {
  readonly id: string;
  readonly sourceTimeUs: number;
  /** Optional local scene/event signal; it must not alter source identity. */
  readonly eventScore?: number;
}

export interface OverviewSamplingOptions {
  readonly maxFrames: number;
}

export interface OverviewSamplingResult {
  readonly mode: 'overview';
  readonly selectedFrameIds: readonly string[];
  readonly omittedFrameCount: number;
  /** True only when this overview returned every intended source identity. */
  readonly completeSourceCoverage: boolean;
}

/**
 * Canonical frame metadata is cheap enough to index without materializing a
 * thumbnail. Presentation index keeps duplicate PTS values deterministic.
 */
export interface CanonicalSamplingCandidate {
  readonly id: string;
  readonly sourceTimeUs: number;
  readonly durationUs: number;
  readonly presentationIndex: number;
}

export interface CanonicalSamplingRange {
  readonly startUs: number;
  readonly endUs: number;
}

export interface CanonicalFrameSamplingResult {
  readonly selectedFrameIds: readonly string[];
  readonly sourceFrameCount: number;
  /** False means this is an explicitly sampled subset, never exhaustive input. */
  readonly completeSourceCoverage: boolean;
}

export interface CanonicalFrameSampler {
  /** Candidates must arrive in canonical presentation chronology. */
  add(candidate: CanonicalSamplingCandidate): void;
  finish(): CanonicalFrameSamplingResult;
}

/**
 * Chronological endpoint sampling with bounded local event promotion. This is
 * intentionally an overview policy, never a semantic-frame-drop policy for an
 * exhaustive request.
 */
export function selectOverviewFrames(
  candidates: readonly OverviewFrameCandidate[],
  options: OverviewSamplingOptions,
): OverviewSamplingResult {
  if (!Number.isSafeInteger(options.maxFrames) || options.maxFrames < 1)
    throw new RangeError('maxFrames must be a positive safe integer');
  const sorted = [...candidates].sort((left, right) => left.sourceTimeUs - right.sourceTimeUs);
  assertCandidates(sorted);
  if (sorted.length <= options.maxFrames)
    return {
      mode: 'overview',
      selectedFrameIds: sorted.map((candidate) => candidate.id),
      omittedFrameCount: 0,
      completeSourceCoverage: true,
    };

  const selectedIndexes = new Set<number>();
  if (options.maxFrames === 1) selectedIndexes.add(0);
  else {
    for (let slot = 0; slot < options.maxFrames; slot += 1)
      selectedIndexes.add(Math.floor((slot * (sorted.length - 1)) / (options.maxFrames - 1)));
  }

  const events = sorted
    .map((candidate, index) => ({ candidate, index, score: candidate.eventScore ?? 0 }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  for (const event of events) {
    if (selectedIndexes.has(event.index)) continue;
    const replaceable = [...selectedIndexes]
      .filter((index) => index !== 0 && index !== sorted.length - 1)
      .sort((left, right) => {
        const leftScore = sorted[left]!.eventScore ?? 0;
        const rightScore = sorted[right]!.eventScore ?? 0;
        return leftScore - rightScore || right - left;
      })[0];
    if (replaceable === undefined) break;
    if (event.score <= (sorted[replaceable]!.eventScore ?? 0)) continue;
    selectedIndexes.delete(replaceable);
    selectedIndexes.add(event.index);
  }
  const selectedFrameIds = [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => sorted[index]!.id);
  return {
    mode: 'overview',
    selectedFrameIds,
    omittedFrameCount: sorted.length - selectedFrameIds.length,
    completeSourceCoverage: false,
  };
}

/**
 * Streams a bounded, deterministic temporal sample without retaining an
 * entire frame manifest. The known source range supplies fixed target times;
 * as canonical metadata arrives, each target chooses the containing frame or
 * the closest neighbouring presentation frame. No pixel, thumbnail, or event
 * score is needed before this selection completes.
 */
export function createCanonicalFrameSampler(
  range: CanonicalSamplingRange,
  options: OverviewSamplingOptions,
): CanonicalFrameSampler {
  assertRange(range);
  assertMaxFrames(options);
  const targetTimes = sampleTargetTimes(range, options.maxFrames);
  const selectedByTarget: Array<CanonicalSamplingCandidate | undefined> = new Array(
    targetTimes.length,
  );
  let nextTargetIndex = 0;
  let previous: CanonicalSamplingCandidate | undefined;
  let previousPresentationIndex = -1;
  let previousSourceTimeUs = -1;
  let sourceFrameCount = 0;
  let finished = false;

  return Object.freeze({
    add(candidate: CanonicalSamplingCandidate) {
      if (finished) throw new RangeError('canonical frame sampler is already finished');
      assertCanonicalCandidate(candidate);
      if (
        candidate.presentationIndex <= previousPresentationIndex ||
        candidate.sourceTimeUs < previousSourceTimeUs
      )
        throw new RangeError('canonical frame candidates must be in presentation chronology');
      previousPresentationIndex = candidate.presentationIndex;
      previousSourceTimeUs = candidate.sourceTimeUs;
      sourceFrameCount = safeIncrement(sourceFrameCount, 'canonical source frame count');

      while (nextTargetIndex < targetTimes.length) {
        const targetTimeUs = targetTimes[nextTargetIndex]!;
        if (previous !== undefined && containsTime(previous, targetTimeUs)) {
          selectedByTarget[nextTargetIndex] = previous;
          nextTargetIndex += 1;
          continue;
        }
        if (containsTime(candidate, targetTimeUs)) {
          selectedByTarget[nextTargetIndex] = candidate;
          nextTargetIndex += 1;
          continue;
        }
        if (targetTimeUs < normalizedStart(candidate, range)) {
          selectedByTarget[nextTargetIndex] = chooseClosest(
            previous,
            candidate,
            targetTimeUs,
            range,
          );
          nextTargetIndex += 1;
          continue;
        }
        break;
      }
      previous = candidate;
    },

    finish() {
      if (finished) throw new RangeError('canonical frame sampler is already finished');
      finished = true;
      while (nextTargetIndex < targetTimes.length) {
        if (previous === undefined) break;
        selectedByTarget[nextTargetIndex] = previous;
        nextTargetIndex += 1;
      }
      const selectedFrameIds = Object.freeze([
        ...new Set(
          selectedByTarget.flatMap((candidate) => (candidate === undefined ? [] : [candidate.id])),
        ),
      ]);
      return Object.freeze({
        selectedFrameIds,
        sourceFrameCount,
        // Honest only when the distinct selected identities actually account
        // for every source frame; a small source count does not guarantee the
        // time-target sampler visited each frame.
        completeSourceCoverage: selectedFrameIds.length === sourceFrameCount,
      });
    },
  });
}

function sampleTargetTimes(range: CanonicalSamplingRange, maxFrames: number): readonly number[] {
  if (maxFrames === 1) return Object.freeze([range.startUs]);
  const span = BigInt(range.endUs - range.startUs - 1);
  const denominator = BigInt(maxFrames - 1);
  const start = BigInt(range.startUs);
  return Object.freeze(
    Array.from({ length: maxFrames }, (_, slot) =>
      Number(start + (BigInt(slot) * span) / denominator),
    ),
  );
}

function containsTime(candidate: CanonicalSamplingCandidate, timeUs: number): boolean {
  if (candidate.durationUs === 0) return candidate.sourceTimeUs === timeUs;
  return timeUs >= candidate.sourceTimeUs && timeUs < candidate.sourceTimeUs + candidate.durationUs;
}

function chooseClosest(
  previous: CanonicalSamplingCandidate | undefined,
  candidate: CanonicalSamplingCandidate,
  targetTimeUs: number,
  range: CanonicalSamplingRange,
): CanonicalSamplingCandidate {
  if (previous === undefined) return candidate;
  const previousDistance = Math.abs(normalizedStart(previous, range) - targetTimeUs);
  const candidateDistance = Math.abs(normalizedStart(candidate, range) - targetTimeUs);
  if (previousDistance < candidateDistance) return previous;
  if (candidateDistance < previousDistance) return candidate;
  return previous.presentationIndex < candidate.presentationIndex ? previous : candidate;
}

function normalizedStart(
  candidate: CanonicalSamplingCandidate,
  range: CanonicalSamplingRange,
): number {
  return Math.max(range.startUs, Math.min(range.endUs - 1, candidate.sourceTimeUs));
}

function assertRange(range: CanonicalSamplingRange): void {
  if (
    range === null ||
    typeof range !== 'object' ||
    !Number.isSafeInteger(range.startUs) ||
    !Number.isSafeInteger(range.endUs) ||
    range.startUs < 0 ||
    range.endUs <= range.startUs
  )
    throw new RangeError('canonical sampling range must be a non-empty safe interval');
}

function assertMaxFrames(options: OverviewSamplingOptions): void {
  if (options === null || typeof options !== 'object')
    throw new RangeError('sampling options must be an object');
  if (!Number.isSafeInteger(options.maxFrames) || options.maxFrames < 1)
    throw new RangeError('maxFrames must be a positive safe integer');
}

function assertCanonicalCandidate(candidate: CanonicalSamplingCandidate): void {
  if (candidate === null || typeof candidate !== 'object')
    throw new RangeError('canonical frame candidate must be an object');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(candidate.id))
    throw new RangeError('candidate id must be a bounded opaque identifier');
  if (
    !Number.isSafeInteger(candidate.sourceTimeUs) ||
    !Number.isSafeInteger(candidate.durationUs) ||
    !Number.isSafeInteger(candidate.presentationIndex) ||
    candidate.sourceTimeUs < 0 ||
    candidate.durationUs < 0 ||
    candidate.presentationIndex < 0 ||
    candidate.sourceTimeUs > Number.MAX_SAFE_INTEGER - candidate.durationUs
  )
    throw new RangeError('canonical frame candidate timing must be bounded safe integers');
}

function safeIncrement(value: number, label: string): number {
  if (value >= Number.MAX_SAFE_INTEGER) throw new RangeError(`${label} exceeds the safe limit`);
  return value + 1;
}

function assertCandidates(candidates: readonly OverviewFrameCandidate[]): void {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(candidate.id))
      throw new RangeError('candidate id must be a bounded opaque identifier');
    if (!Number.isSafeInteger(candidate.sourceTimeUs) || candidate.sourceTimeUs < 0)
      throw new RangeError('candidate sourceTimeUs must be a non-negative safe integer');
    if (
      candidate.eventScore !== undefined &&
      (!Number.isFinite(candidate.eventScore) || candidate.eventScore < 0)
    )
      throw new RangeError('candidate eventScore must be a non-negative finite number');
    if (ids.has(candidate.id)) throw new RangeError(`duplicate candidate id: ${candidate.id}`);
    ids.add(candidate.id);
  }
}
