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
const WORKFLOW_INDEX_KEY = 'joy-media.workflow.v1:index';

/**
 * A deliberately narrow durable-store contract. The app root passes its
 * project-writer guarded adapter; no workflow path is allowed to silently
 * select raw browser localStorage on its own.
 */
export interface WorkflowStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
  /** Optional for legacy-record discovery; new records use the durable index. */
  readonly length?: number;
  key?(index: number): string | null;
}

export class WorkflowStorageRequiredError extends Error {
  constructor() {
    super('A guarded workflow storage adapter is required in the browser.');
    this.name = 'WorkflowStorageRequiredError';
  }
}

const memoryStore = new Map<string, string>();

const serverMemoryStorage: Required<Pick<WorkflowStorage, 'getItem' | 'setItem' | 'removeItem'>> = {
  getItem: (key) => memoryStore.get(key) ?? null,
  setItem: (key, value) => memoryStore.set(key, value),
  removeItem: (key) => memoryStore.delete(key),
};

/**
 * Test/SSR has no writable browser origin. Production callers must inject the
 * root-gated adapter explicitly, so a released tab cannot retain an unguarded
 * storage reference through a module-level fallback.
 */
function requireWorkflowStorage(storage: WorkflowStorage | undefined): WorkflowStorage {
  if (storage !== undefined) return storage;
  if (typeof window === 'undefined') return serverMemoryStorage;
  throw new WorkflowStorageRequiredError();
}

function storageGetItem(storage: WorkflowStorage, key: string): string | null {
  return storage.getItem(key);
}

function storageSetItem(storage: WorkflowStorage, key: string, value: string): void {
  storage.setItem(key, value);
}

function storageRemoveItem(storage: WorkflowStorage, key: string): void {
  if (storage.removeItem === undefined) {
    throw new WorkflowStorageRequiredError();
  }
  storage.removeItem(key);
}

function workflowKey(workflowId: string): string {
  return `${WORKFLOW_STORAGE_PREFIX}${workflowId}`;
}

interface WorkflowIndex {
  readonly version: 1;
  readonly workflowIds: readonly string[];
}

function readWorkflowIndex(storage: WorkflowStorage): readonly string[] {
  const serialized = storageGetItem(storage, WORKFLOW_INDEX_KEY);
  if (serialized === null) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { readonly version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { readonly workflowIds?: unknown }).workflowIds)
    ) {
      return [];
    }
    return (parsed as { readonly workflowIds: readonly unknown[] }).workflowIds.filter(
      (workflowId): workflowId is string =>
        typeof workflowId === 'string' && workflowId.startsWith('user.workflows.'),
    );
  } catch {
    return [];
  }
}

function writeWorkflowIndex(storage: WorkflowStorage, workflowIds: readonly string[]): void {
  const index: WorkflowIndex = { version: 1, workflowIds: [...new Set(workflowIds)] };
  storageSetItem(storage, WORKFLOW_INDEX_KEY, JSON.stringify(index));
}

function addWorkflowToIndex(storage: WorkflowStorage, workflowId: string): void {
  const previous = readWorkflowIndex(storage).filter((id) => id !== workflowId);
  writeWorkflowIndex(storage, [...previous, workflowId]);
}

function removeWorkflowFromIndex(storage: WorkflowStorage, workflowId: string): void {
  writeWorkflowIndex(
    storage,
    readWorkflowIndex(storage).filter((id) => id !== workflowId),
  );
}

/**
 * Older builds did not keep a workflow index. An injected adapter may expose
 * read-only enumeration so we can preserve those records without coupling this
 * module to raw browser storage. The guarded production adapter need not
 * implement it for all newly-written records to remain discoverable.
 */
function discoverLegacyWorkflowIds(storage: WorkflowStorage): readonly string[] {
  if (storage.length === undefined || storage.key === undefined) return [];
  const workflowIds: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === undefined || key === null || !key.startsWith(WORKFLOW_STORAGE_PREFIX)) continue;
    const workflowId = key.slice(WORKFLOW_STORAGE_PREFIX.length);
    if (workflowId.startsWith('user.workflows.')) workflowIds.push(workflowId);
  }
  return workflowIds;
}

function listedWorkflowIds(storage: WorkflowStorage): readonly string[] {
  return [...new Set([...readWorkflowIndex(storage), ...discoverLegacyWorkflowIds(storage)])];
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
      const childPrefix = keyPrefix
        ? `${keyPrefix}${key.charAt(0).toUpperCase()}${key.slice(1)}`
        : key;
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
export function resolveParameterizedValue(
  value: unknown,
  inputs: Readonly<Record<string, unknown>>,
): unknown {
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
  let merged: Record<string, unknown> = {
    type: 'object',
    properties: {},
    required: [] as string[],
  };
  for (const node of nodes) {
    const nodeInputs = (
      node.params as Record<string, unknown> & { __inputs?: Record<string, unknown> }
    ).__inputs;
    if (nodeInputs === undefined) continue;
    const nodeProps = (nodeInputs.properties as Record<string, unknown>) ?? {};
    const nodeRequired = (nodeInputs.required as string[]) ?? [];
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

/** Save a recorded workflow to the injected, writer-gated workspace store. */
export function saveWorkflow(
  _session: unknown,
  plan: AgentEditPlan,
  storage?: WorkflowStorage,
): RecordedWorkflow {
  const workflowStorage = requireWorkflowStorage(storage);
  const workflow = convertPlanToWorkflow(plan);
  const recorded: RecordedWorkflow = {
    workflow,
    originalPlan: plan,
    savedAt: new Date().toISOString(),
  };

  // Write discovery metadata first. If the guarded writer loses authority
  // between the two operations, a harmless dangling index entry is skipped by
  // readers; the inverse order could leave a durable workflow invisible.
  addWorkflowToIndex(workflowStorage, workflow.id);
  const key = workflowKey(workflow.id);
  storageSetItem(workflowStorage, key, JSON.stringify(recorded));

  return recorded;
}

/** Load a recorded workflow from the injected, writer-gated workspace store. */
export function loadWorkflow(
  _session: unknown,
  workflowId: string,
  storage?: WorkflowStorage,
): RecordedWorkflow | undefined {
  const workflowStorage = requireWorkflowStorage(storage);
  const key = workflowKey(workflowId);
  const raw = storageGetItem(workflowStorage, key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as RecordedWorkflow;
  } catch {
    return undefined;
  }
}

/** List all recorded workflows from the injected, writer-gated workspace store. */
export function listWorkflows(
  _session: unknown,
  storage?: WorkflowStorage,
): readonly RecordedWorkflow[] {
  const workflowStorage = requireWorkflowStorage(storage);
  const workflows: RecordedWorkflow[] = [];
  for (const workflowId of listedWorkflowIds(workflowStorage)) {
    const recorded = loadWorkflow(_session, workflowId, workflowStorage);
    if (recorded !== undefined) {
      workflows.push(recorded);
    }
  }
  return workflows;
}

/** Delete a recorded workflow from the injected, writer-gated workspace store. */
export function deleteWorkflow(
  _session: unknown,
  workflowId: string,
  storage?: WorkflowStorage,
): boolean {
  const workflowStorage = requireWorkflowStorage(storage);
  const key = workflowKey(workflowId);
  storageRemoveItem(workflowStorage, key);
  removeWorkflowFromIndex(workflowStorage, workflowId);
  return true;
}
