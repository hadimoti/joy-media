import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import { type ProductionRunAuthority, type ProductionRunCheckpointUpdateResultV1, type ProductionRunCheckpointUpdateV1, type ProductionRunRecordV1, type ProductionRunStateV1, type ProductionRunStore, type RecordProductionApprovalResponseInput, type RecordProductionApprovalResponseResult } from '@joy-media/workflow-engine';
export interface BrowserProductionRunScope {
    readonly projectId: string;
    readonly authority: ProductionRunAuthority;
}
export interface BrowserProductionRunStoreOptions {
    readonly maxLogMessageBytes?: number;
    readonly maxLogsPerNode?: number;
}
export interface BrowserProductionRunCreateOptions {
    readonly runKey?: string;
}
export interface BrowserProductionRunListOptions {
    readonly limit?: number;
    readonly cursor?: string;
    readonly state?: ProductionRunStateV1;
}
export interface BrowserProductionRunListResult {
    readonly runs: readonly ProductionRunRecordV1[];
    readonly nextCursor?: string;
}
export interface BrowserProductionRunApprovalResponseInput extends RecordProductionApprovalResponseInput {
    readonly expectedApprovalId?: string;
    readonly expectedRequestedSeq?: number;
    readonly expiresAtSeq?: number;
}
export type BrowserProductionRunApprovalResponseResult = RecordProductionApprovalResponseResult | {
    readonly ok: false;
    readonly reason: 'approval-expired';
};
export type BrowserProductionRunCancelResult = {
    readonly ok: true;
    readonly record: ProductionRunRecordV1;
} | {
    readonly ok: false;
    readonly reason: 'not-found' | 'revision-conflict' | 'already-terminal';
    readonly currentUpdatedSeq?: number;
};
/**
 * Browser-only production run history for explicit local/offline execution.
 *
 * The storage key includes both project and actor authority, so this store never
 * attempts to reconcile local records with the authenticated control-plane API.
 */
export declare class BrowserProductionRunStore implements ProductionRunStore {
    #private;
    private readonly storage;
    private readonly scope;
    constructor(storage: BrowserKeyValueStore, scope: BrowserProductionRunScope, options?: BrowserProductionRunStoreOptions);
    load(runId: string): Promise<ProductionRunRecordV1 | undefined>;
    list(options?: BrowserProductionRunListOptions): Promise<BrowserProductionRunListResult>;
    create(record: ProductionRunRecordV1): Promise<void>;
    createLocalRun(record: ProductionRunRecordV1, options?: BrowserProductionRunCreateOptions): Promise<void>;
    compareAndSwapCheckpoint(update: ProductionRunCheckpointUpdateV1): Promise<ProductionRunCheckpointUpdateResultV1>;
    recordApprovalResponse(runId: string, response: RecordProductionApprovalResponseInput): Promise<RecordProductionApprovalResponseResult>;
    respondToApproval(runId: string, response: BrowserProductionRunApprovalResponseInput): Promise<BrowserProductionRunApprovalResponseResult>;
    cancel(runId: string, input: {
        readonly authority: ProductionRunAuthority;
        readonly expectedUpdatedSeq?: number;
    }): Promise<BrowserProductionRunCancelResult>;
}
//# sourceMappingURL=browser-production-run-store.d.ts.map