import type { AgentEditPlan } from '@joy-media/agent-tools';
import type { JoyWorkflow, WorkflowNode } from '@joy-media/workflow-engine';
export interface RecordedWorkflow {
    readonly workflow: JoyWorkflow;
    readonly originalPlan: AgentEditPlan;
    readonly savedAt: string;
}
export interface WorkflowInputParameter {
    readonly name: string;
    readonly type: 'string' | 'number';
    readonly description: string;
    readonly default?: unknown;
}
/** Deep-resolve parameter markers in a recorded node params object. */
export declare function resolveParameterizedValue(value: unknown, inputs: Readonly<Record<string, unknown>>): unknown;
/** Extract workflow input schema from recorded nodes. */
export declare function extractWorkflowInputs(nodes: readonly WorkflowNode[]): Record<string, unknown>;
/** Convert an AgentEditPlan to a JoyWorkflow. */
export declare function convertPlanToWorkflow(plan: AgentEditPlan): JoyWorkflow;
/** Save a recorded workflow to workspace storage. */
export declare function saveWorkflow(_session: unknown, plan: AgentEditPlan): RecordedWorkflow;
/** Load a recorded workflow from workspace storage. */
export declare function loadWorkflow(_session: unknown, workflowId: string): RecordedWorkflow | undefined;
/** List all recorded workflows from workspace storage. */
export declare function listWorkflows(_session: unknown): readonly RecordedWorkflow[];
/** Delete a recorded workflow from workspace storage. */
export declare function deleteWorkflow(_session: unknown, workflowId: string): boolean;
//# sourceMappingURL=workflow-recorder.d.ts.map