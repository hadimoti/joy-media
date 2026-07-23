// apps/editor-web/src/workflow-recorder.ts

import type { AgentEditPlan, AgentPlanStep } from '@joy-media/agent-tools';
import type { JoyWorkflow, WorkflowNode } from '@joy-media/workflow-engine';
import { WORKFLOW_FORMAT_VERSION } from '@joy-media/workflow-engine';

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

const BAKED_KEYS = new Set(['assetId', 'compositionId', 'kind', 'captionDocumentId']);

const PARAMETERIZABLE_KEYS = new Set([
  'trackId',
  'clipId',
  'newClipId',
  'firstClipId',
  'secondClipId',
  'id',
  'startUs',
  'durationUs',
  'atUs',
  'newStartUs',
  'newEndUs',
  'sourceInUs',
  'text',
  'label',
]);

/** Marker that a value is a workflow input parameter. */
interface ParameterMarker {
  readonly __parameter: true;
  readonly name: string;
}

function isParameterMarker(value: unknown): value is ParameterMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as ParameterMarker).__parameter === true &&
    typeof (value as ParameterMarker).name === 'string'
  );
}

function parameterizeValue(
  key: string,
  paramName: string,
  value: unknown,
): { value: unknown; parameter?: WorkflowInputParameter } {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return { value };
  }
  if (BAKED_KEYS.has(key)) {
    return { value };
  }
  if (typeof value === 'number') {
    if (PARAMETERIZABLE_KEYS.has(key)) {
      return {
        value: { __parameter: true, name: paramName } satisfies ParameterMarker,
        parameter: { name: paramName, type: 'number', description: key, default: value },
      };
    }
    return { value };
  }
  if (typeof value === 'string') {
    if (PARAMETERIZABLE_KEYS.has(key)) {
      return {
        value: { __parameter: true, name: paramName } satisfies ParameterMarker,
        parameter: { name: paramName, type: 'string', description: key, default: value },
      };
    }
    return { value };
  }
  return { value };
}

function parameterizeRecord(
  record: Readonly<Record<string, unknown>>,
  keyPrefix: string = '',
): {
  params: Record<string, unknown>;
  parameters: WorkflowInputParameter[];
} {
  const params: Record<string, unknown> = {};
  const parameters: WorkflowInputParameter[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      params[key] = value.map((item) =>
        typeof item === 'object' && item !== null && !Array.isArray(item)
          ? parameterizeRecord(item as Readonly<Record<string, unknown>>).params
          : item,
      );
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      const childPrefix = keyPrefix ? `${keyPrefix}${key.charAt(0).toUpperCase()}${key.slice(1)}` : key;
      const { params: nestedParams, parameters: nestedParameters } = parameterizeRecord(
        value as Readonly<Record<string, unknown>>,
        childPrefix,
      );
      params[key] = nestedParams;
      parameters.push(...nestedParameters);
      continue;
    }
    const paramName = keyPrefix ? `${keyPrefix}${key.charAt(0).toUpperCase()}${key.slice(1)}` : key;
    const { value: replaced, parameter } = parameterizeValue(key, paramName, value);
    params[key] = replaced;
    if (parameter !== undefined) {
      parameters.push(parameter);
    }
  }
  return { params, parameters };
}

function uniqueParameters(parameters: WorkflowInputParameter[]): WorkflowInputParameter[] {
  const seen = new Set<string>();
  const result: WorkflowInputParameter[] = [];
  for (const parameter of parameters) {
    if (!seen.has(parameter.name)) {
      seen.add(parameter.name);
      result.push(parameter);
    }
  }
  return result;
}

function inputsSchema(parameters: readonly WorkflowInputParameter[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const parameter of parameters) {
    properties[parameter.name] = {
      type: parameter.type,
      description: parameter.description,
      ...(parameter.default !== undefined ? { default: parameter.default } : {}),
    };
  }
  return {
    type: 'object',
    properties,
    required: parameters.map((p) => p.name),
  };
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

  const { params, parameters } = parameterizeRecord(step.arguments as Record<string, unknown>);

  return {
    id: step.id,
    category: TOOL_TO_CATEGORY[step.tool] ?? 'editor',
    type: nodeType,
    params: {
      ...params,
      label: step.description,
      commands: [
        {
          tool: step.tool,
          arguments: params,
        },
      ],
      __inputs: inputsSchema(uniqueParameters(parameters)),
    },
    deterministic: true,
  };
}

/** Resolve a parameter marker to its runtime value. */
function resolveMarker(
  marker: ParameterMarker,
  inputs: Readonly<Record<string, unknown>>,
): unknown {
  if (marker.name in inputs) {
    return inputs[marker.name];
  }
  return marker;
}

/** Deep-resolve parameter markers in a recorded node params object. */
export function resolveParameterizedValue(value: unknown, inputs: Readonly<Record<string, unknown>>): unknown {
  if (isParameterMarker(value)) {
    return resolveMarker(value, inputs);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveParameterizedValue(item, inputs));
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Readonly<Record<string, unknown>>)) {
      result[key] = resolveParameterizedValue(entry, inputs);
    }
    return result;
  }
  return value;
}

/** Extract workflow input schema from recorded nodes. */
export function extractWorkflowInputs(nodes: readonly WorkflowNode[]): Record<string, unknown> {
  let merged: Record<string, unknown> = { type: 'object', properties: {}, required: [] as string[] };
  for (const node of nodes) {
    const nodeInputs = (node.params as Record<string, unknown> & { __inputs?: Record<string, unknown> }).__inputs;
    if (nodeInputs === undefined) continue;
    const nodeProps = nodeInputs.properties as Record<string, unknown> ?? {};
    const nodeRequired = nodeInputs.required as string[] ?? [];
    merged = {
      type: 'object',
      properties: { ...(merged.properties as Record<string, unknown>), ...nodeProps },
      required: [...(merged.required as string[]), ...nodeRequired],
    };
  }
  return merged;
}

/** Convert an AgentEditPlan to a JoyWorkflow. */
export function convertPlanToWorkflow(plan: AgentEditPlan): JoyWorkflow {
  const slug = slugify(plan.goal);
  const workflowId = `user.workflows.${slug}`;

  const nodes = plan.steps.map(convertStepToNode);
  const edges = plan.steps.flatMap((step) =>
    step.dependsOn.map((dep) => ({ from: dep, to: step.id })),
  );

  const workflowInputs = extractWorkflowInputs(nodes);

  return {
    formatVersion: WORKFLOW_FORMAT_VERSION,
    id: workflowId,
    version: '1.0.0',
    name: plan.goal,
    inputs: workflowInputs,
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

