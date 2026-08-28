// apps/editor-web/src/workflow-recorder.ts
import { WORKFLOW_FORMAT_VERSION } from '@joy-media/workflow-engine';
const WORKFLOW_STORAGE_PREFIX = 'joy-media.workflow.v1:';
const memoryStore = new Map();
function storageGetItem(key) {
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
        return window.localStorage.getItem(key);
    }
    return memoryStore.get(key) ?? null;
}
function storageSetItem(key, value) {
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
        window.localStorage.setItem(key, value);
    }
    else {
        memoryStore.set(key, value);
    }
}
function storageRemoveItem(key) {
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
        window.localStorage.removeItem(key);
    }
    else {
        memoryStore.delete(key);
    }
}
function storageLength() {
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
        return window.localStorage.length;
    }
    return memoryStore.size;
}
function storageKey(index) {
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
        return window.localStorage.key(index);
    }
    const keys = Array.from(memoryStore.keys());
    return keys[index] ?? null;
}
function workflowKey(workflowId) {
    return `${WORKFLOW_STORAGE_PREFIX}${workflowId}`;
}
/** Derive a kebab-case slug from the plan goal. */
function slugify(goal) {
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
function isParameterMarker(value) {
    return (typeof value === 'object' &&
        value !== null &&
        value.__parameter === true &&
        typeof value.name === 'string');
}
function parameterizeValue(key, paramName, value) {
    if (value === null || value === undefined || typeof value === 'boolean') {
        return { value };
    }
    if (BAKED_KEYS.has(key)) {
        return { value };
    }
    if (typeof value === 'number') {
        if (PARAMETERIZABLE_KEYS.has(key)) {
            return {
                value: { __parameter: true, name: paramName },
                parameter: { name: paramName, type: 'number', description: key, default: value },
            };
        }
        return { value };
    }
    if (typeof value === 'string') {
        if (PARAMETERIZABLE_KEYS.has(key)) {
            return {
                value: { __parameter: true, name: paramName },
                parameter: { name: paramName, type: 'string', description: key, default: value },
            };
        }
        return { value };
    }
    return { value };
}
function parameterizeRecord(record, keyPrefix = '') {
    const params = {};
    const parameters = [];
    for (const [key, value] of Object.entries(record)) {
        if (Array.isArray(value)) {
            params[key] = value.map((item) => typeof item === 'object' && item !== null && !Array.isArray(item)
                ? parameterizeRecord(item).params
                : item);
            continue;
        }
        if (typeof value === 'object' && value !== null) {
            const childPrefix = keyPrefix
                ? `${keyPrefix}${key.charAt(0).toUpperCase()}${key.slice(1)}`
                : key;
            const { params: nestedParams, parameters: nestedParameters } = parameterizeRecord(value, childPrefix);
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
function uniqueParameters(parameters) {
    const seen = new Set();
    const result = [];
    for (const parameter of parameters) {
        if (!seen.has(parameter.name)) {
            seen.add(parameter.name);
            result.push(parameter);
        }
    }
    return result;
}
function inputsSchema(parameters) {
    const properties = {};
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
const TOOL_TO_NODE_TYPE = {
    insertClip: 'editor.commandTransaction',
    removeClip: 'editor.commandTransaction',
    moveClip: 'editor.commandTransaction',
    trimClip: 'editor.commandTransaction',
    splitClip: 'editor.commandTransaction',
    joinClips: 'editor.commandTransaction',
};
const TOOL_TO_CATEGORY = {
    insertClip: 'editor',
    removeClip: 'editor',
    moveClip: 'editor',
    trimClip: 'editor',
    splitClip: 'editor',
    joinClips: 'editor',
};
/** Convert one AgentPlanStep to a WorkflowNode. */
function convertStepToNode(step) {
    const nodeType = TOOL_TO_NODE_TYPE[step.tool];
    if (nodeType === undefined) {
        throw new Error(`Unknown tool: ${step.tool}`);
    }
    const { params, parameters } = parameterizeRecord(step.arguments);
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
function resolveMarker(marker, inputs) {
    if (marker.name in inputs) {
        return inputs[marker.name];
    }
    return marker;
}
/** Deep-resolve parameter markers in a recorded node params object. */
export function resolveParameterizedValue(value, inputs) {
    if (isParameterMarker(value)) {
        return resolveMarker(value, inputs);
    }
    if (Array.isArray(value)) {
        return value.map((item) => resolveParameterizedValue(item, inputs));
    }
    if (typeof value === 'object' && value !== null) {
        const result = {};
        for (const [key, entry] of Object.entries(value)) {
            result[key] = resolveParameterizedValue(entry, inputs);
        }
        return result;
    }
    return value;
}
/** Extract workflow input schema from recorded nodes. */
export function extractWorkflowInputs(nodes) {
    let merged = {
        type: 'object',
        properties: {},
        required: [],
    };
    for (const node of nodes) {
        const nodeInputs = node.params.__inputs;
        if (nodeInputs === undefined)
            continue;
        const nodeProps = nodeInputs.properties ?? {};
        const nodeRequired = nodeInputs.required ?? [];
        merged = {
            type: 'object',
            properties: { ...merged.properties, ...nodeProps },
            required: [...merged.required, ...nodeRequired],
        };
    }
    return merged;
}
/** Convert an AgentEditPlan to a JoyWorkflow. */
export function convertPlanToWorkflow(plan) {
    const slug = slugify(plan.goal);
    const workflowId = `user.workflows.${slug}`;
    const nodes = plan.steps.map(convertStepToNode);
    const edges = plan.steps.flatMap((step) => step.dependsOn.map((dep) => ({ from: dep, to: step.id })));
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
export function saveWorkflow(_session, plan) {
    const workflow = convertPlanToWorkflow(plan);
    const recorded = {
        workflow,
        originalPlan: plan,
        savedAt: new Date().toISOString(),
    };
    const key = workflowKey(workflow.id);
    storageSetItem(key, JSON.stringify(recorded));
    return recorded;
}
/** Load a recorded workflow from workspace storage. */
export function loadWorkflow(_session, workflowId) {
    const key = workflowKey(workflowId);
    const raw = storageGetItem(key);
    if (raw === null)
        return undefined;
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
/** List all recorded workflows from workspace storage. */
export function listWorkflows(_session) {
    const workflows = [];
    for (let i = 0; i < storageLength(); i++) {
        const key = storageKey(i);
        if (key?.startsWith(WORKFLOW_STORAGE_PREFIX)) {
            const raw = storageGetItem(key);
            if (raw !== null) {
                try {
                    workflows.push(JSON.parse(raw));
                }
                catch {
                    // Skip invalid entries
                }
            }
        }
    }
    return workflows;
}
/** Delete a recorded workflow from workspace storage. */
export function deleteWorkflow(_session, workflowId) {
    const key = workflowKey(workflowId);
    storageRemoveItem(key);
    return true;
}
//# sourceMappingURL=workflow-recorder.js.map