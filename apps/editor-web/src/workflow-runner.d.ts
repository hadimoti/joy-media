import type { EditorSession } from './editor-session.js';
import { type HumanInputRequest, type JoyWorkflow, type NodeLibrary, type ProductionRunAuthority, type ProductionRunStore, type RunCheckpoint } from '@joy-media/workflow-engine';
export interface ParkedWorkflowRun {
    readonly runId: string;
    readonly workflowId: string;
    readonly workflow: JoyWorkflow;
    readonly workflowInputs: unknown;
    readonly checkpoint: RunCheckpoint;
    readonly nodeId: string;
    readonly request: HumanInputRequest;
}
export type WorkflowRunOutcome = {
    readonly status: 'succeeded';
    readonly workflowId: string;
    readonly runId: string;
    readonly outputs?: unknown;
} | {
    readonly status: 'waiting_for_input';
    readonly workflowId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly request: HumanInputRequest;
    readonly checkpoint: RunCheckpoint;
    readonly approvalId?: string;
    readonly approvalRequestedSeq?: number;
    readonly approvalExpiresAtSeq?: number;
} | {
    readonly status: 'failed';
    readonly workflowId: string;
    readonly runId: string;
    readonly error: string;
};
export interface WorkflowRunnerOptions {
    readonly productionRunStore?: ProductionRunStore;
    readonly authority?: ProductionRunAuthority;
    readonly firstPartyLibrary?: NodeLibrary;
}
export interface WorkflowResumeOptions extends WorkflowRunnerOptions {
    readonly approvalId?: string;
    readonly approvalRequestedSeq?: number;
    readonly approvalExpiresAtSeq?: number;
}
export declare function defaultWorkflowAuthority(): ProductionRunAuthority;
export declare function resetFirstPartyLibraryForTests(): void;
declare function resolveWorkflow(session: EditorSession, workflowId: string): JoyWorkflow;
/** Normalize editor modal inputs into the first-party workflow input shape. */
export declare function normalizeFirstPartyInputs(workflow: JoyWorkflow, inputs: Readonly<Record<string, unknown>>): unknown;
export declare function runWorkflow(session: EditorSession, workflowId: string, inputs?: Readonly<Record<string, unknown>>, options?: WorkflowRunnerOptions): Promise<WorkflowRunOutcome>;
export declare function resumeWorkflow(session: EditorSession, runId: string, humanInputs: Readonly<Record<string, unknown>>, options?: WorkflowResumeOptions): Promise<WorkflowRunOutcome>;
export { resolveWorkflow };
//# sourceMappingURL=workflow-runner.d.ts.map