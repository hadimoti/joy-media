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

/** Exact run + canonical operation identity; it is not model-provided authority. */
export function receiptReplayKey(
  receipt: Pick<ExecutionReceipt, 'executionId' | 'operationDigest'>,
): string {
  return `${receipt.executionId}:${receipt.operationDigest.toLowerCase()}`;
}

function assertId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:=-]{0,255}$/.test(value))
    throw new RangeError(`${label} must be a bounded opaque identifier`);
}
