import type { IdempotencyRecord, IdempotencyTracker, ToolResult } from '@joy-media/agent-tools';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';

const STORAGE_PREFIX = 'joy-media.agent-idempotency.v1';

/**
 * Project-scoped durable receipts for atomic agent runs.
 *
 * A completed receipt survives reload, making a retry of the same logical plan
 * a no-op. Failed receipts remain inspectable but do not block a retry.
 */
export class BrowserAgentIdempotencyStore implements IdempotencyTracker {
  readonly #records = new Map<string, IdempotencyRecord>();
  readonly #storageKey: string;

  constructor(
    private readonly storage: BrowserKeyValueStore,
    projectId: string,
  ) {
    this.#storageKey = `${STORAGE_PREFIX}:${encodeURIComponent(projectId)}`;
    for (const record of readRecords(storage.getItem(this.#storageKey))) {
      this.#records.set(record.key, record);
    }
  }

  hasExecuted(key: string): boolean {
    return this.#records.get(key)?.status === 'completed';
  }

  getRecord(key: string): IdempotencyRecord | undefined {
    return this.#records.get(key);
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
    this.#records.set(record.key, record);
    this.storage.setItem(this.#storageKey, JSON.stringify([...this.#records.values()]));
  }
}

function readRecords(serialized: string | null): readonly IdempotencyRecord[] {
  if (serialized === null) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isIdempotencyRecord);
  } catch {
    return [];
  }
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
