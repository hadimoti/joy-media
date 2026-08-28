import { FIRST_PARTY_WORKFLOW_IDS } from '@joy-media/workflow-engine';
import type { JoyWorkflow } from '@joy-media/workflow-engine';
import type { RecordedWorkflow } from './workflow-recorder.js';
/**
 * First-party workflows loaded from `@joy-media/workflow-engine` (D-W17-1a:
 * bundled via the workspace package — same artifact the CLI/tests pin).
 */
export interface FirstPartyWorkflow {
    readonly workflow: JoyWorkflow;
    readonly fileName: string;
    readonly label: string;
    readonly summary: string;
    readonly requiredPorts: readonly string[];
    readonly optionalPorts: readonly string[];
    readonly capabilities: readonly string[];
    readonly approvals: readonly string[];
    readonly reportRefs: readonly string[];
}
export declare function loadFirstPartyWorkflows(): readonly FirstPartyWorkflow[];
export declare function getFirstPartyWorkflow(workflowId: string): FirstPartyWorkflow | undefined;
export declare function getFirstPartyWorkflowVersion(): string;
/**
 * WP-17.3 — surface lineage when a recorded workflow's goal/name references a
 * first-party system workflow. Exact recording-from-system lineage lands later;
 * this makes teachable reuse visible without inventing false provenance.
 */
export declare function detectDerivedFrom(recorded: RecordedWorkflow): string | undefined;
export { FIRST_PARTY_WORKFLOW_IDS };
//# sourceMappingURL=first-party-workflows.d.ts.map