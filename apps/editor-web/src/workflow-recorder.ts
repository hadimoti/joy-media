// apps/editor-web/src/workflow-recorder.ts

import type { AgentEditPlan, AgentPlanStep } from '@joy-media/agent-tools';
import type { JoyWorkflow, WorkflowNode } from '@joy-media/workflow-engine';
import { WORKFLOW_FORMAT_VERSION } from '@joy-media/workflow-engine';

export interface RecordedWorkflow {
  readonly workflow: JoyWorkflow;
  readonly originalPlan: AgentEditPlan;
  readonly savedAt: string;
}

const WORKFLOW_STORAGE_PREFIX = 'joy-media.workflow.v1:';

const memoryStore = new Map<string, string>();

function storageGetItem(key: string): string | null {
  if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
    return window.localStorage.getItem(key);
  }
  return memoryStore.get(key) ?? null;
}

function storageSetItem(key: string, value: string): void {
  if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
    window.localStorage.setItem(key, value);
  } else {
    memoryStore.set(key, value);
  }
}

function storageRemoveItem(key: string): void {
  if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
    window.localStorage.removeItem(key);
  } else {
    memoryStore.delete(key);
  }
}

function storageLength(): number {
  if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
    return window.localStorage.length;
  }
  return memoryStore.size;
}

function storageKey(index: number): string | null {
  if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
    return window.localStorage.key(index);
  }
  const keys = Array.from(memoryStore.keys());
  return keys[index] ?? null;
}

function workflowKey(workflowId: string): string {
  return `${WORKFLOW_STORAGE_PREFIX}${workflowId}`;
}

/** Derive a kebab-case slug from the plan goal. */
function slugify(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 64);
}

const TOOL_TO_NODE_TYPE: Record<string, string> = {
  insertClip: 'editor.commandTransaction',
  removeClip: 'editor.commandTransaction',
  moveClip: 'editor.commandTransaction',
  trimClip: 'editor.commandTransaction',
  splitClip: 'editor.commandTransaction',
  joinClips: 'editor.commandTransaction',
};

const TOOL_TO_CATEGORY: Record<string, 'editor'> = {
  insertClip: 'editor',
  removeClip: 'editor',
  moveClip: 'editor',
  trimClip: 'editor',
  splitClip: 'editor',
  joinClips: 'editor',
};

/** Convert one AgentPlanStep to a WorkflowNode. */
function convertStepToNode(step: AgentPlanStep): WorkflowNode {
  const nodeType = TOOL_TO_NODE_TYPE[step.tool];
  if (nodeType === undefined) {
    throw new Error(`Unknown tool: ${step.tool}`);
  }

  return {
    id: step.id,
    category: TOOL_TO_CATEGORY[step.tool] ?? 'editor',
    type: nodeType,
    params: {
      label: step.description,
      commands: [
        {
          tool: step.tool,
          arguments: step.arguments,
        },
      ],
    },
    deterministic: true,
  };
}

/** Convert an AgentEditPlan to a JoyWorkflow. */
export function convertPlanToWorkflow(plan: AgentEditPlan): JoyWorkflow {
  const slug = slugify(plan.goal);
  const workflowId = `user.workflows.${slug}`;

  const nodes = plan.steps.map(convertStepToNode);
  const edges = plan.steps.flatMap((step) =>
    step.dependsOn.map((dep) => ({ from: dep, to: step.id })),
  );

  return {
    formatVersion: WORKFLOW_FORMAT_VERSION,
    id: workflowId,
    version: '1.0.0',
    name: plan.goal,
    inputs: { type: 'object' },
    outputs: { type: 'object' },
    nodes,
    edges,
    permissions: [],
    policy: {
      concurrency: 1,
      failure: 'stop',
      defaultRetry: { maxAttempts: 1, backoffMs: 0 },
    },
  };
}

/** Save a recorded workflow to workspace storage. */
export function saveWorkflow(_session: unknown, plan: AgentEditPlan): RecordedWorkflow {
  const workflow = convertPlanToWorkflow(plan);
  const recorded: RecordedWorkflow = {
    workflow,
    originalPlan: plan,
    savedAt: new Date().toISOString(),
  };

  const key = workflowKey(workflow.id);
  storageSetItem(key, JSON.stringify(recorded));

  return recorded;
}

/** Load a recorded workflow from workspace storage. */
export function loadWorkflow(_session: unknown, workflowId: string): RecordedWorkflow | undefined {
  const key = workflowKey(workflowId);
  const raw = storageGetItem(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as RecordedWorkflow;
  } catch {
    return undefined;
  }
}

/** List all recorded workflows from workspace storage. */
export function listWorkflows(_session: unknown): readonly RecordedWorkflow[] {
  const workflows: RecordedWorkflow[] = [];
  for (let i = 0; i < storageLength(); i++) {
    const key = storageKey(i);
    if (key?.startsWith(WORKFLOW_STORAGE_PREFIX)) {
      const raw = storageGetItem(key);
      if (raw !== null) {
        try {
          workflows.push(JSON.parse(raw) as RecordedWorkflow);
        } catch {
          // Skip invalid entries
        }
      }
    }
  }
  return workflows;
}

/** Delete a recorded workflow from workspace storage. */
export function deleteWorkflow(_session: unknown, workflowId: string): boolean {
  const key = workflowKey(workflowId);
  storageRemoveItem(key);
  return true;
}
