import type { JsonValue, ToolResult } from './types.js';

export interface AuditEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly planId: string;
  readonly stepId?: string;
  readonly action: AuditAction;
  readonly tool?: string;
  readonly arguments?: JsonValue;
  readonly result?: ToolResult;
  readonly error?: string;
  readonly userId: string;
  readonly metadata?: Record<string, unknown>;
}

export type AuditAction =
  | 'plan-created'
  | 'plan-validated'
  | 'plan-approved'
  | 'plan-rejected'
  | 'dry-run-started'
  | 'dry-run-completed'
  | 'execution-started'
  | 'step-started'
  | 'step-completed'
  | 'step-failed'
  | 'step-skipped'
  | 'execution-completed'
  | 'execution-failed'
  | 'verification-started'
  | 'verification-completed'
  | 'branch-created'
  | 'branch-accepted'
  | 'branch-rejected'
  | 'revert-started'
  | 'revert-completed'
  | 'revert-failed';

export class AuditTrail {
  private entries: AuditEntry[] = [];
  private entryCounter = 0;

  record(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
    const id = `audit-${++this.entryCounter}-${Date.now()}`;
    const timestamp = new Date().toISOString();
    const fullEntry: AuditEntry = {
      ...entry,
      id,
      timestamp,
    };
    this.entries.push(fullEntry);
    return fullEntry;
  }

  getEntriesForPlan(planId: string): readonly AuditEntry[] {
    return this.entries.filter((e) => e.planId === planId);
  }

  getEntriesByAction(action: AuditAction): readonly AuditEntry[] {
    return this.entries.filter((e) => e.action === action);
  }

  getEntriesInRange(start: string, end: string): readonly AuditEntry[] {
    const startTime = new Date(start).getTime();
    const endTime = new Date(end).getTime();

    return this.entries.filter((e) => {
      const entryTime = new Date(e.timestamp).getTime();
      return entryTime >= startTime && entryTime <= endTime;
    });
  }

  getAllEntries(): readonly AuditEntry[] {
    return this.entries;
  }

  exportAsJson(): string {
    return JSON.stringify(this.entries, null, 2);
  }

  clear(): void {
    this.entries = [];
    this.entryCounter = 0;
  }
}

export function createAuditTrail(): AuditTrail {
  return new AuditTrail();
}
