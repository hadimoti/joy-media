import type { ToolResult } from './types.js';

export interface IdempotencyRecord {
  readonly key: string;
  readonly planId: string;
  readonly stepId: string;
  readonly executedAt: string;
  readonly result?: ToolResult;
  readonly status: 'pending' | 'completed' | 'failed';
}

export class IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();

  generateKey(planId: string, stepId: string, attempt: number): string {
    return `${planId}:${stepId}:${attempt}`;
  }

  hasExecuted(key: string): boolean {
    const record = this.records.get(key);
    return record !== undefined && record.status === 'completed';
  }

  getRecord(key: string): IdempotencyRecord | undefined {
    return this.records.get(key);
  }

  recordExecution(key: string, planId: string, stepId: string, result: ToolResult): void {
    this.records.set(key, {
      key,
      planId,
      stepId,
      executedAt: new Date().toISOString(),
      result,
      status: 'completed',
    });
  }

  recordFailure(key: string, planId: string, stepId: string, error: string): void {
    this.records.set(key, {
      key,
      planId,
      stepId,
      executedAt: new Date().toISOString(),
      result: { success: false, error },
      status: 'failed',
    });
  }

  clear(): void {
    this.records.clear();
  }

  getRecordsForPlan(planId: string): readonly IdempotencyRecord[] {
    return Array.from(this.records.values()).filter((r) => r.planId === planId);
  }
}

export function createIdempotencyStore(): IdempotencyStore {
  return new IdempotencyStore();
}
