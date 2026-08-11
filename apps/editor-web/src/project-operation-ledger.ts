/** Durable, project-scoped logical operation records.
 *
 * The ledger is intentionally metadata-only: media bytes and export results
 * remain in OPFS/private storage. Reusing a logical ID with a different
 * fingerprint is rejected so reload/retry cannot silently create duplicates.
 */
export type ProjectOperationType = 'import' | 'audio' | 'cloud-audio' | 'worker-job' | 'export';
export type ProjectOperationStatus =
  'running' | 'review' | 'applied' | 'completed' | 'failed' | 'cancelled' | 'interrupted-retryable';

export interface ProjectOperationRecord {
  readonly id: string;
  readonly projectId: string;
  readonly type: ProjectOperationType;
  readonly fingerprint: string;
  readonly revision: number;
  readonly status: ProjectOperationStatus;
  readonly attempt: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly resultRef?: string;
  readonly error?: string;
}

export interface OperationLedgerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PROJECT_OPERATION_LEDGER_KEY = 'joy-media.project-operation-ledger.v1';
const MAX_RECORDS = 200;

export class ProjectOperationLedger {
  constructor(
    private readonly storage: OperationLedgerStorage,
    private readonly projectId: string,
  ) {}

  get(id: string): ProjectOperationRecord | undefined {
    return this.records().find((record) => record.id === id);
  }

  begin(input: {
    readonly id: string;
    readonly type: ProjectOperationType;
    readonly fingerprint: string;
    readonly revision: number;
    readonly now?: string;
  }): ProjectOperationRecord {
    const existing = this.get(input.id);
    if (existing !== undefined) {
      if (existing.fingerprint !== input.fingerprint || existing.type !== input.type)
        throw new OperationConflictError(input.id);
      if (existing.status === 'completed') return existing;
      const resumed = {
        ...existing,
        status: 'running' as const,
        attempt: existing.attempt + 1,
        updatedAt: input.now ?? new Date().toISOString(),
      };
      this.write(upsert(this.allRecords(), resumed));
      return resumed;
    }
    const now = input.now ?? new Date().toISOString();
    const created: ProjectOperationRecord = {
      id: input.id,
      projectId: this.projectId,
      type: input.type,
      fingerprint: input.fingerprint,
      revision: input.revision,
      status: 'running',
      attempt: 1,
      startedAt: now,
      updatedAt: now,
    };
    this.write(upsert(this.allRecords(), created));
    return created;
  }

  finish(
    id: string,
    status: Exclude<ProjectOperationStatus, 'running'>,
    result?: { readonly resultRef?: string; readonly error?: string; readonly now?: string },
  ): ProjectOperationRecord {
    const existing = this.get(id);
    if (existing === undefined) throw new Error(`operation ${id} does not exist`);
    const next: ProjectOperationRecord = {
      ...existing,
      status,
      updatedAt: result?.now ?? new Date().toISOString(),
      ...(result?.resultRef === undefined ? {} : { resultRef: result.resultRef }),
      ...(result?.error === undefined ? {} : { error: result.error.slice(0, 500) }),
    };
    this.write(upsert(this.allRecords(), next));
    return next;
  }

  list(): readonly ProjectOperationRecord[] {
    return this.records().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * Browser encodes cannot resume after a page teardown. Reconcile only this
   * project's matching running operations; Worker jobs may still be remotely
   * attachable and therefore are not changed unless explicitly requested.
   */
  recoverInterrupted(
    type: ProjectOperationType = 'export',
    now = new Date().toISOString(),
  ): readonly ProjectOperationRecord[] {
    let changed = false;
    const recovered = this.allRecords().map((record) => {
      if (
        record.projectId !== this.projectId ||
        record.type !== type ||
        record.status !== 'running'
      )
        return record;
      changed = true;
      return {
        ...record,
        status: 'interrupted-retryable' as const,
        updatedAt: now,
        error: 'interrupted by page reload',
      };
    });
    if (changed) this.write(recovered);
    return recovered
      .filter((record) => record.projectId === this.projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * A paid provider request cannot be assumed safe to replay after the page
   * disappears. Mark its outcome unknown and terminal instead of presenting a
   * retry that could duplicate work or billing.
   */
  recoverUncertain(
    type: ProjectOperationType,
    now = new Date().toISOString(),
  ): readonly ProjectOperationRecord[] {
    let changed = false;
    const recovered = this.allRecords().map((record) => {
      if (
        record.projectId !== this.projectId ||
        record.type !== type ||
        record.status !== 'running'
      )
        return record;
      changed = true;
      return {
        ...record,
        status: 'failed' as const,
        updatedAt: now,
        error: 'provider outcome unknown after page reload; automatic retry disabled',
      };
    });
    if (changed) this.write(recovered);
    return recovered
      .filter((record) => record.projectId === this.projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  removeAll(): void {
    this.write(this.allRecords().filter((record) => record.projectId !== this.projectId));
  }

  private records(): ProjectOperationRecord[] {
    return this.allRecords().filter((record) => record.projectId === this.projectId);
  }

  private allRecords(): ProjectOperationRecord[] {
    const raw = this.storage.getItem(PROJECT_OPERATION_LEDGER_KEY);
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isRecord);
    } catch {
      return [];
    }
  }

  private write(records: readonly ProjectOperationRecord[]): void {
    this.storage.setItem(
      PROJECT_OPERATION_LEDGER_KEY,
      JSON.stringify(records.slice(0, MAX_RECORDS)),
    );
  }
}

export class OperationConflictError extends Error {
  constructor(readonly operationId: string) {
    super(`operation ${operationId} was reused with a different fingerprint`);
    this.name = 'OperationConflictError';
  }
}

function upsert(
  records: readonly ProjectOperationRecord[],
  next: ProjectOperationRecord,
): ProjectOperationRecord[] {
  return [
    next,
    ...records.filter((record) => record.id !== next.id || record.projectId !== next.projectId),
  ];
}

function isRecord(value: unknown): value is ProjectOperationRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<ProjectOperationRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.projectId === 'string' &&
    (record.type === 'import' ||
      record.type === 'audio' ||
      record.type === 'cloud-audio' ||
      record.type === 'worker-job' ||
      record.type === 'export') &&
    typeof record.fingerprint === 'string' &&
    Number.isSafeInteger(record.revision) &&
    (record.status === 'running' ||
      record.status === 'review' ||
      record.status === 'applied' ||
      record.status === 'completed' ||
      record.status === 'failed' ||
      record.status === 'cancelled' ||
      record.status === 'interrupted-retryable') &&
    Number.isSafeInteger(record.attempt) &&
    typeof record.startedAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
}
