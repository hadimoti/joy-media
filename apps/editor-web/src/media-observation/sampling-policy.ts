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
