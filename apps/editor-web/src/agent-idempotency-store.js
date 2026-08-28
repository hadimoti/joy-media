const STORAGE_PREFIX = 'joy-media.agent-idempotency.v1';
/**
 * Project-scoped durable receipts for atomic agent runs.
 *
 * A completed receipt survives reload, making a retry of the same logical plan
 * a no-op. Failed receipts remain inspectable but do not block a retry.
 */
export class BrowserAgentIdempotencyStore {
    storage;
    #records = new Map();
    #storageKey;
    constructor(storage, projectId) {
        this.storage = storage;
        this.#storageKey = `${STORAGE_PREFIX}:${encodeURIComponent(projectId)}`;
        for (const record of readRecords(storage.getItem(this.#storageKey))) {
            this.#records.set(record.key, record);
        }
    }
    hasExecuted(key) {
        return this.#records.get(key)?.status === 'completed';
    }
    getRecord(key) {
        return this.#records.get(key);
    }
    recordExecution(key, planId, stepId, result) {
        this.#write({
            key,
            planId,
            stepId,
            executedAt: new Date().toISOString(),
            result,
            status: 'completed',
        });
    }
    recordFailure(key, planId, stepId, error) {
        this.#write({
            key,
            planId,
            stepId,
            executedAt: new Date().toISOString(),
            result: { success: false, error },
            status: 'failed',
        });
    }
    recordsForPlan(planId) {
        return [...this.#records.values()].filter((record) => record.planId === planId);
    }
    #write(record) {
        this.#records.set(record.key, record);
        this.storage.setItem(this.#storageKey, JSON.stringify([...this.#records.values()]));
    }
}
function readRecords(serialized) {
    if (serialized === null)
        return [];
    try {
        const parsed = JSON.parse(serialized);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter(isIdempotencyRecord);
    }
    catch {
        return [];
    }
}
function isIdempotencyRecord(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const record = value;
    return (typeof record.key === 'string' &&
        record.key.length > 0 &&
        typeof record.planId === 'string' &&
        typeof record.stepId === 'string' &&
        typeof record.executedAt === 'string' &&
        (record.status === 'pending' || record.status === 'completed' || record.status === 'failed'));
}
//# sourceMappingURL=agent-idempotency-store.js.map