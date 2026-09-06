export interface EvidenceBatch {
  readonly id: string;
  readonly frameIds: readonly string[];
}

export interface EvidenceBatchProgress {
  readonly intendedFrameIds: readonly string[];
  readonly submittedFrameIds: readonly string[];
  readonly reviewedFrameIds: readonly string[];
}

export interface EvidenceBatchOptions {
  readonly maxFramesPerBatch: number;
  readonly reviewedFrameIds: readonly string[];
}

const UNSAFE_LOCATION =
  /(?:\b(?:https?|file|data|blob):|\b[A-Za-z]:|(?:^|\s|=|:|\(|\[)(?:~?\/|\\\\)|(?:^|\/)\.{1,2}(?:\/|$)|\\)/i;

/**
 * Return each not-yet-reviewed temporal identity once. Content-addressed image
 * bytes may deduplicate in storage, but identical stills at different times
 * have different frame IDs and remain independently reviewable.
 */
export function missingEvidenceFrameIds(
  intendedFrameIds: readonly string[],
  reviewedFrameIds: readonly string[],
): readonly string[] {
  assertIntendedFrameIds(intendedFrameIds);
  const reviewed = new Set(reviewedFrameIds);
  return intendedFrameIds.filter((id) => !reviewed.has(id));
}

export function createEvidenceBatches(
  intendedFrameIds: readonly string[],
  options: EvidenceBatchOptions,
): readonly EvidenceBatch[] {
  if (!Number.isSafeInteger(options.maxFramesPerBatch) || options.maxFramesPerBatch < 1)
    throw new RangeError('maxFramesPerBatch must be a positive safe integer');
  const missing = missingEvidenceFrameIds(intendedFrameIds, options.reviewedFrameIds);
  const batches: EvidenceBatch[] = [];
  for (let start = 0; start < missing.length; start += options.maxFramesPerBatch)
    batches.push({
      id: `evidence-batch-${batches.length}`,
      frameIds: missing.slice(start, start + options.maxFramesPerBatch),
    });
  return batches;
}

function assertIntendedFrameIds(frameIds: readonly string[]): void {
  const ids = new Set<string>();
  for (const id of frameIds) {
    // O1 source-frame keys can exceed 256 characters when they carry an exact
    // stream/PTS identity. Keep the same 512-character opaque identifier
    // boundary as observation coverage instead of truncating semantic input.
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@=-]{0,511}$/.test(id) || UNSAFE_LOCATION.test(id))
      throw new RangeError('frame id must be a bounded opaque identifier');
    if (ids.has(id)) throw new RangeError(`duplicate intended frame id: ${id}`);
    ids.add(id);
  }
}
