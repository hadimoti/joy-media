/** Durable metadata for one approved local agent change set. */
export interface ExecutionReceipt {
  readonly version: 1;
  readonly executionId: string;
  readonly projectId: string;
  readonly operationDigest: string;
  readonly baseRevision: string;
  readonly resultRevision: string;
  readonly writerFence: number;
  readonly status: 'committed';
  readonly changedEntityIds: readonly string[];
  readonly undoEntryId: string;
}

export function createExecutionReceipt(
  input: Omit<ExecutionReceipt, 'version' | 'status' | 'changedEntityIds'> & {
    readonly changedEntityIds: readonly string[];
  },
): ExecutionReceipt {
  assertId(input.executionId, 'executionId');
  assertId(input.projectId, 'projectId');
  assertId(input.baseRevision, 'baseRevision');
  assertId(input.resultRevision, 'resultRevision');
  assertId(input.undoEntryId, 'undoEntryId');
  if (!/^[a-f0-9]{64}$/i.test(input.operationDigest))
    throw new RangeError('operationDigest must be a SHA-256 hex digest');
  if (!Number.isSafeInteger(input.writerFence) || input.writerFence <= 0)
    throw new RangeError('writerFence must be a positive safe integer');
  const changedEntityIds = [...new Set(input.changedEntityIds)];
  for (const id of changedEntityIds) assertId(id, 'changedEntityIds entry');
  return {
    version: 1,
    executionId: input.executionId,
    projectId: input.projectId,
    operationDigest: input.operationDigest.toLowerCase(),
    baseRevision: input.baseRevision,
    resultRevision: input.resultRevision,
    writerFence: input.writerFence,
    status: 'committed',
    changedEntityIds: changedEntityIds.sort(),
    undoEntryId: input.undoEntryId,
  };
}

/**
 * Accept only canonical receipt bytes when reopening browser-local storage.
 * In particular, a receipt with a merely equivalent uppercase digest or an
 * unsorted changed-entity list is not a durable authority record.
 */
export function isExecutionReceipt(value: unknown): value is ExecutionReceipt {
  if (!isRecord(value)) return false;
  const changedEntityIds = value.changedEntityIds;
  if (
    value.version !== 1 ||
    value.status !== 'committed' ||
    typeof value.executionId !== 'string' ||
    typeof value.projectId !== 'string' ||
    typeof value.operationDigest !== 'string' ||
    typeof value.baseRevision !== 'string' ||
    typeof value.resultRevision !== 'string' ||
    typeof value.writerFence !== 'number' ||
    typeof value.undoEntryId !== 'string' ||
    !isStringArray(changedEntityIds)
  )
    return false;
  try {
    const canonical = createExecutionReceipt({
      executionId: value.executionId,
      projectId: value.projectId,
      operationDigest: value.operationDigest,
      baseRevision: value.baseRevision,
      resultRevision: value.resultRevision,
      writerFence: value.writerFence,
      changedEntityIds,
      undoEntryId: value.undoEntryId,
    });
    return (
      canonical.executionId === value.executionId &&
      canonical.projectId === value.projectId &&
      canonical.operationDigest === value.operationDigest &&
      canonical.baseRevision === value.baseRevision &&
      canonical.resultRevision === value.resultRevision &&
      canonical.writerFence === value.writerFence &&
      canonical.undoEntryId === value.undoEntryId &&
      canonical.changedEntityIds.length === changedEntityIds.length &&
      canonical.changedEntityIds.every((id, index) => id === changedEntityIds[index])
    );
  } catch {
    return false;
  }
}

/** Exact run + canonical operation identity; it is not model-provided authority. */
export function receiptReplayKey(
  receipt: Pick<ExecutionReceipt, 'executionId' | 'operationDigest'>,
): string {
  return `${receipt.executionId}:${receipt.operationDigest.toLowerCase()}`;
}

function assertId(value: string, label: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:=-]{0,255}$/.test(value))
    throw new RangeError(`${label} must be a bounded opaque identifier`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
