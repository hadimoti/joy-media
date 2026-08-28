import type { IdempotencyRecord, IdempotencyTracker, ToolResult } from '@joy-media/agent-tools';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
/**
 * Project-scoped durable receipts for atomic agent runs.
 *
 * A completed receipt survives reload, making a retry of the same logical plan
 * a no-op. Failed receipts remain inspectable but do not block a retry.
 */
export declare class BrowserAgentIdempotencyStore implements IdempotencyTracker {
    #private;
    private readonly storage;
    constructor(storage: BrowserKeyValueStore, projectId: string);
    hasExecuted(key: string): boolean;
    getRecord(key: string): IdempotencyRecord | undefined;
    recordExecution(key: string, planId: string, stepId: string, result: ToolResult): void;
    recordFailure(key: string, planId: string, stepId: string, error: string): void;
    recordsForPlan(planId: string): readonly IdempotencyRecord[];
}
//# sourceMappingURL=agent-idempotency-store.d.ts.map