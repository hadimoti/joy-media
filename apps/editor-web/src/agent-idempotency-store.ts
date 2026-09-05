import type { IdempotencyRecord, IdempotencyTracker, ToolResult } from '@joy-media/agent-tools';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import {
  createExecutionReceipt,
  isExecutionReceipt,
  type ExecutionReceipt,
} from './execution-receipt.js';

const STORAGE_PREFIX = 'joy-media.agent-idempotency.v1';

export interface StagedExecutionReceiptWrite {
  /** Raw key that an EditorSession compound journal can capture and restore. */
  readonly storageKey: string;
  /** Most recent v2 storage payload written by `persist`. */
  readonly serialized: string;
  /** Canonical receipt that becomes visible only after `commit`. */
  readonly receipt: ExecutionReceipt;
  persist(): void;
  commit(): void;
}

/** Raised when durable storage assigns different receipt authority to one execution ID. */
export class ExecutionReceiptConflictError extends Error {
  readonly executionId: string;

  constructor(executionId: string) {
    super(`execution receipt conflict for ${executionId}`);
    this.name = 'ExecutionReceiptConflictError';
    this.executionId = executionId;
  }
}

interface StoredAgentIdempotencyState {
  readonly records: readonly IdempotencyRecord[];
  readonly executionReceipts: readonly ExecutionReceipt[];
  readonly executionReceiptConflicts: readonly ExecutionReceiptConflict[];
}

interface ExecutionReceiptConflict {
  readonly executionId: string;
  readonly receipts: readonly ExecutionReceipt[];
}

/** Project-scoped raw storage key used by the compound-journal allowlist. */
export function agentIdempotencyStorageKey(projectId: string): string {
  if (typeof projectId !== 'string' || projectId.length === 0)
    throw new RangeError('projectId must be a non-empty string');
  return `${STORAGE_PREFIX}:${encodeURIComponent(projectId)}`;
}

export function removeAgentIdempotencyRecords(
  storage: BrowserKeyValueStore,
  projectId: string,
): void {
  storage.removeItem?.(agentIdempotencyStorageKey(projectId));
}

/**
 * Project-scoped durable receipts for atomic agent runs.
 *
 * A completed receipt survives reload, making a retry of the same logical plan
 * a no-op. Failed receipts remain inspectable but do not block a retry.
 */
export class BrowserAgentIdempotencyStore implements IdempotencyTracker {
  readonly #records = new Map<string, IdempotencyRecord>();
  readonly #executionReceipts = new Map<string, ExecutionReceipt>();
  readonly #executionReceiptConflicts = new Map<string, readonly ExecutionReceipt[]>();
  readonly #storageKey: string;

  constructor(
    private readonly storage: BrowserKeyValueStore,
    private readonly projectId: string,
  ) {
    this.#storageKey = agentIdempotencyStorageKey(projectId);
    const state = readState(storage.getItem(this.#storageKey), projectId);
    for (const record of state.records) {
      this.#records.set(record.key, record);
    }
    for (const receipt of state.executionReceipts) {
      this.#executionReceipts.set(receipt.executionId, receipt);
    }
    for (const conflict of state.executionReceiptConflicts) {
      this.#executionReceiptConflicts.set(conflict.executionId, conflict.receipts);
    }
  }

  /** Exposes the complete project-scoped value for a compound-journal sidecar. */
  get storageKey(): string {
    return this.#storageKey;
  }

  /** Alias for callers that need to distinguish this from logical record keys. */
  get rawStorageKey(): string {
    return this.#storageKey;
  }

  hasExecuted(key: string): boolean {
    return this.#records.get(key)?.status === 'completed';
  }

  getRecord(key: string): IdempotencyRecord | undefined {
    return this.#records.get(key);
  }

  /** A defensive copy prevents a caller from mutating in-memory receipt authority. */
  getExecutionReceipt(executionId: string): ExecutionReceipt | undefined {
    const receipt = this.#executionReceipts.get(executionId);
    return receipt === undefined ? undefined : cloneExecutionReceipt(receipt);
  }

  /**
   * Returns every canonical persisted candidate for an ambiguous execution ID.
   * `undefined` means the ID is not conflicted; an empty array is never returned.
   */
  getExecutionReceiptConflict(executionId: string): readonly ExecutionReceipt[] | undefined {
    const conflict = this.#executionReceiptConflicts.get(executionId);
    return conflict === undefined ? undefined : conflict.map(cloneExecutionReceipt);
  }

  /**
   * Build a raw-storage sidecar for EditorSession's existing prepare/persist/
   * commit journal. Persisting it cannot make the receipt visible in this
   * session; only the journal's successful in-memory commit may call `commit`.
   */
  stageExecutionReceipt(receipt: ExecutionReceipt): StagedExecutionReceiptWrite {
    if (!isExecutionReceipt(receipt)) throw new TypeError('execution receipt is invalid');
    if (receipt.projectId !== this.projectId)
      throw new Error(
        `execution receipt project mismatch: expected ${this.projectId}, got ${receipt.projectId}`,
      );
    if (this.#executionReceiptConflicts.has(receipt.executionId))
      throw new ExecutionReceiptConflictError(receipt.executionId);
    const existing = this.#executionReceipts.get(receipt.executionId);
    if (existing !== undefined && !executionReceiptsEqual(existing, receipt))
      throw new ExecutionReceiptConflictError(receipt.executionId);
    if (existing !== undefined)
      throw new Error(`execution receipt already exists: ${receipt.executionId}`);

    const canonicalReceipt = cloneExecutionReceipt(receipt);
    const stagedReceipts = new Map(this.#executionReceipts);
    stagedReceipts.set(canonicalReceipt.executionId, canonicalReceipt);
    let serialized = serializeState(this.#records, stagedReceipts, this.#executionReceiptConflicts);
    let persisted = false;
    let committed = false;
    return {
      storageKey: this.#storageKey,
      get serialized() {
        return serialized;
      },
      receipt: cloneExecutionReceipt(canonicalReceipt),
      persist: () => {
        const persistedState = readState(this.storage.getItem(this.#storageKey), this.projectId);
        const mergedReceipts = collectExecutionReceipts([
          ...executionReceiptCandidates(persistedState),
          ...executionReceiptCandidates({
            executionReceipts: [...this.#executionReceipts.values()],
            executionReceiptConflicts: conflictsFromMap(this.#executionReceiptConflicts),
          }),
        ]);
        if (mergedReceipts.conflicts.has(canonicalReceipt.executionId))
          throw new ExecutionReceiptConflictError(canonicalReceipt.executionId);
        const persistedReceipt = mergedReceipts.receipts.get(canonicalReceipt.executionId);
        if (
          persistedReceipt !== undefined &&
          !executionReceiptsEqual(persistedReceipt, canonicalReceipt)
        )
          throw new ExecutionReceiptConflictError(canonicalReceipt.executionId);
        if (persistedReceipt === undefined)
          mergedReceipts.receipts.set(canonicalReceipt.executionId, canonicalReceipt);
        serialized = serializeState(
          mergeIdempotencyRecords(persistedState.records, this.#records),
          mergedReceipts.receipts,
          mergedReceipts.conflicts,
        );
        this.storage.setItem(this.#storageKey, serialized);
        persisted = true;
      },
      commit: () => {
        if (!persisted)
          throw new Error('execution receipt sidecar must be persisted before commit');
        if (committed) return;
        this.#executionReceipts.set(canonicalReceipt.executionId, canonicalReceipt);
        committed = true;
      },
    };
  }

  recordExecution(key: string, planId: string, stepId: string, result: ToolResult): void {
    this.#write({
      key,
      planId,
      stepId,
      executedAt: new Date().toISOString(),
      result,
      status: 'completed',
    });
  }

  recordFailure(key: string, planId: string, stepId: string, error: string): void {
    this.#write({
      key,
      planId,
      stepId,
      executedAt: new Date().toISOString(),
      result: { success: false, error },
      status: 'failed',
    });
  }

  recordsForPlan(planId: string): readonly IdempotencyRecord[] {
    return [...this.#records.values()].filter((record) => record.planId === planId);
  }

  #write(record: IdempotencyRecord): void {
    const next = new Map(this.#records);
    next.set(record.key, record);
    this.storage.setItem(
      this.#storageKey,
      serializeState(next, this.#executionReceipts, this.#executionReceiptConflicts),
    );
    this.#records.set(record.key, record);
  }
}

function readState(serialized: string | null, projectId: string): StoredAgentIdempotencyState {
  if (serialized === null) return emptyStoredState();
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (Array.isArray(parsed))
      return {
        records: parsed.filter(isIdempotencyRecord),
        executionReceipts: [],
        executionReceiptConflicts: [],
      };
    if (!isRecord(parsed) || parsed.version !== 2) return emptyStoredState();
    return {
      records: Array.isArray(parsed.records) ? parsed.records.filter(isIdempotencyRecord) : [],
      ...readExecutionReceipts(parsed.executionReceipts, projectId),
    };
  } catch {
    return emptyStoredState();
  }
}

function emptyStoredState(): StoredAgentIdempotencyState {
  return { records: [], executionReceipts: [], executionReceiptConflicts: [] };
}

function readExecutionReceipts(
  value: unknown,
  projectId: string,
): Pick<StoredAgentIdempotencyState, 'executionReceipts' | 'executionReceiptConflicts'> {
  if (!Array.isArray(value)) return { executionReceipts: [], executionReceiptConflicts: [] };
  const candidates: ExecutionReceipt[] = [];
  for (const candidate of value) {
    if (!isExecutionReceipt(candidate) || candidate.projectId !== projectId) continue;
    candidates.push(candidate);
  }
  const collected = collectExecutionReceipts(candidates);
  return {
    executionReceipts: [...collected.receipts.values()],
    executionReceiptConflicts: conflictsFromMap(collected.conflicts),
  };
}

function serializeState(
  records: ReadonlyMap<string, IdempotencyRecord>,
  executionReceipts: ReadonlyMap<string, ExecutionReceipt>,
  executionReceiptConflicts: ReadonlyMap<string, readonly ExecutionReceipt[]>,
): string {
  const receipts = executionReceiptCandidates({
    executionReceipts: [...executionReceipts.values()],
    executionReceiptConflicts: conflictsFromMap(executionReceiptConflicts),
  }).sort(compareExecutionReceipts);
  return JSON.stringify({
    version: 2,
    records: [...records.values()],
    executionReceipts: receipts,
  });
}

function mergeIdempotencyRecords(
  persistedRecords: readonly IdempotencyRecord[],
  inMemoryRecords: ReadonlyMap<string, IdempotencyRecord>,
): ReadonlyMap<string, IdempotencyRecord> {
  const records = new Map<string, IdempotencyRecord>();
  for (const record of persistedRecords) records.set(record.key, record);
  for (const [key, record] of inMemoryRecords) {
    if (!records.has(key)) records.set(key, record);
  }
  return records;
}

function collectExecutionReceipts(candidates: Iterable<ExecutionReceipt>): {
  readonly receipts: Map<string, ExecutionReceipt>;
  readonly conflicts: Map<string, readonly ExecutionReceipt[]>;
} {
  const grouped = new Map<string, ExecutionReceipt[]>();
  for (const candidate of candidates) {
    const canonical = cloneExecutionReceipt(candidate);
    const group = grouped.get(canonical.executionId) ?? [];
    if (!group.some((existing) => executionReceiptsEqual(existing, canonical))) {
      group.push(canonical);
      grouped.set(canonical.executionId, group);
    }
  }

  const receipts = new Map<string, ExecutionReceipt>();
  const conflicts = new Map<string, readonly ExecutionReceipt[]>();
  for (const [executionId, group] of grouped) {
    if (group.length === 1) receipts.set(executionId, group[0]!);
    else conflicts.set(executionId, group.sort(compareExecutionReceipts));
  }
  return { receipts, conflicts };
}

function executionReceiptCandidates(
  state: Pick<StoredAgentIdempotencyState, 'executionReceipts' | 'executionReceiptConflicts'>,
): ExecutionReceipt[] {
  const candidates = [...state.executionReceipts];
  for (const conflict of state.executionReceiptConflicts) candidates.push(...conflict.receipts);
  return candidates;
}

function conflictsFromMap(
  conflicts: ReadonlyMap<string, readonly ExecutionReceipt[]>,
): readonly ExecutionReceiptConflict[] {
  return [...conflicts.entries()].map(([executionId, receipts]) => ({ executionId, receipts }));
}

function executionReceiptsEqual(left: ExecutionReceipt, right: ExecutionReceipt): boolean {
  return (
    left.version === right.version &&
    left.executionId === right.executionId &&
    left.projectId === right.projectId &&
    left.operationDigest === right.operationDigest &&
    left.baseRevision === right.baseRevision &&
    left.resultRevision === right.resultRevision &&
    left.writerFence === right.writerFence &&
    left.status === right.status &&
    left.undoEntryId === right.undoEntryId &&
    left.changedEntityIds.length === right.changedEntityIds.length &&
    left.changedEntityIds.every((id, index) => id === right.changedEntityIds[index])
  );
}

function compareExecutionReceipts(left: ExecutionReceipt, right: ExecutionReceipt): number {
  return (
    left.executionId.localeCompare(right.executionId) ||
    left.operationDigest.localeCompare(right.operationDigest) ||
    left.baseRevision.localeCompare(right.baseRevision) ||
    left.resultRevision.localeCompare(right.resultRevision) ||
    left.writerFence - right.writerFence ||
    left.undoEntryId.localeCompare(right.undoEntryId) ||
    left.changedEntityIds.join('\0').localeCompare(right.changedEntityIds.join('\0'))
  );
}

function cloneExecutionReceipt(receipt: ExecutionReceipt): ExecutionReceipt {
  return createExecutionReceipt({
    executionId: receipt.executionId,
    projectId: receipt.projectId,
    operationDigest: receipt.operationDigest,
    baseRevision: receipt.baseRevision,
    resultRevision: receipt.resultRevision,
    writerFence: receipt.writerFence,
    changedEntityIds: receipt.changedEntityIds,
    undoEntryId: receipt.undoEntryId,
  });
}

function isIdempotencyRecord(value: unknown): value is IdempotencyRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<IdempotencyRecord>;
  return (
    typeof record.key === 'string' &&
    record.key.length > 0 &&
    typeof record.planId === 'string' &&
    typeof record.stepId === 'string' &&
    typeof record.executedAt === 'string' &&
    (record.status === 'pending' || record.status === 'completed' || record.status === 'failed')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
