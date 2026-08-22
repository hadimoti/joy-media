/** P07 WP-07.3 — code/JSON workflow authoring with schema validation (§23.7). */

import type {
  JoyWorkflow,
  RetryPolicy,
  WorkflowFailureMode,
  WorkflowNode,
  WorkflowPermission,
} from './definition.js';
import { WORKFLOW_FORMAT_VERSION, validateWorkflow } from './definition.js';
import type { CreateNodeOptions, NodeRegistry } from './nodes.js';

// ---------------------------------------------------------------------------
// Minimal JSON-Schema subset validator (§23.7 "schema validation", §23.3
// inputs/outputs). Deliberately small and dependency-free; unsupported
// keywords are rejected rather than silently ignored so declarations stay
// within the validated subset.
// ---------------------------------------------------------------------------

export const SUPPORTED_SCHEMA_KEYWORDS: readonly string[] = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'minItems',
  'description',
  'title',
  'default',
];

const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'] as const;

export interface SchemaIssue {
  /** JSON-pointer-style path into the validated value (or schema for declaration issues). */
  readonly path: string;
  readonly message: string;
}

/** Checks that a declaration only uses the supported JSON-Schema subset. */
export function validateSchemaDeclaration(schema: unknown, path = '$'): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    issues.push({ path, message: 'schema declaration must be an object' });
    return issues;
  }
  const record = schema as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.includes(key)) {
      issues.push({ path, message: `unsupported schema keyword "${key}"` });
    }
  }
  const type = record['type'];
  if (type !== undefined && !SCHEMA_TYPES.includes(type as (typeof SCHEMA_TYPES)[number])) {
    issues.push({ path, message: `type must be one of: ${SCHEMA_TYPES.join(', ')}` });
  }
  const properties = record['properties'];
  if (properties !== undefined) {
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
      issues.push({ path, message: 'properties must be an object of schemas' });
    } else {
      for (const [name, sub] of Object.entries(properties)) {
        issues.push(...validateSchemaDeclaration(sub, `${path}.properties.${name}`));
      }
    }
  }
  const items = record['items'];
  if (items !== undefined) {
    issues.push(...validateSchemaDeclaration(items, `${path}.items`));
  }
  const required = record['required'];
  if (
    required !== undefined &&
    (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string'))
  ) {
    issues.push({ path, message: 'required must be an array of strings' });
  }
  return issues;
}

function typeOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/** Validates a value against a declaration from the supported subset. */
export function validateAgainstSchema(schema: unknown, value: unknown, path = '$'): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    issues.push({ path, message: 'schema declaration must be an object' });
    return issues;
  }
  const record = schema as Record<string, unknown>;

  if ('const' in record && JSON.stringify(record['const']) !== JSON.stringify(value)) {
    issues.push({ path, message: 'value does not match const' });
  }
  const allowed = record['enum'];
  if (
    Array.isArray(allowed) &&
    !allowed.some((entry) => JSON.stringify(entry) === JSON.stringify(value))
  ) {
    issues.push({ path, message: 'value is not one of the enum entries' });
  }

  const type = record['type'];
  if (typeof type === 'string') {
    const actual = typeOf(value);
    const matches =
      type === actual ||
      (type === 'integer' && actual === 'number' && Number.isInteger(value as number)) ||
      (type === 'number' && actual === 'number');
    if (!matches) {
      issues.push({ path, message: `expected ${type}, got ${actual}` });
      return issues;
    }
  }

  if (typeof value === 'number') {
    const minimum = record['minimum'];
    if (typeof minimum === 'number' && value < minimum) {
      issues.push({ path, message: `must be >= ${String(minimum)}` });
    }
    const maximum = record['maximum'];
    if (typeof maximum === 'number' && value > maximum) {
      issues.push({ path, message: `must be <= ${String(maximum)}` });
    }
  }
  if (typeof value === 'string') {
    const minLength = record['minLength'];
    if (typeof minLength === 'number' && value.length < minLength) {
      issues.push({ path, message: `must have length >= ${String(minLength)}` });
    }
  }
  if (Array.isArray(value)) {
    const minItems = record['minItems'];
    if (typeof minItems === 'number' && value.length < minItems) {
      issues.push({ path, message: `must have >= ${String(minItems)} items` });
    }
    const items = record['items'];
    if (items !== undefined) {
      value.forEach((entry, index) => {
        issues.push(...validateAgainstSchema(items, entry, `${path}[${String(index)}]`));
      });
    }
  }
  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>;
    const required = record['required'];
    if (Array.isArray(required)) {
      for (const name of required) {
        if (typeof name === 'string' && !(name in object)) {
          issues.push({ path: `${path}.${name}`, message: 'required property is missing' });
        }
      }
    }
    const properties = record['properties'];
    const propertySchemas =
      properties !== null && typeof properties === 'object' && !Array.isArray(properties)
        ? (properties as Record<string, unknown>)
        : {};
    for (const [name, sub] of Object.entries(propertySchemas)) {
      if (name in object) {
        issues.push(...validateAgainstSchema(sub, object[name], `${path}.${name}`));
      }
    }
    if (record['additionalProperties'] === false) {
      for (const name of Object.keys(object)) {
        if (!(name in propertySchemas)) {
          issues.push({ path: `${path}.${name}`, message: 'additional property is not allowed' });
        }
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// JSON authoring: parse + layered validation with coded issues.
// ---------------------------------------------------------------------------

export interface AuthoringIssue {
  /**
   * `authoring/*` for parse/shape issues; underlying `workflow/*` and
   * `node-library/*` codes are passed through unchanged.
   */
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly nodeId?: string;
}

export type ParseWorkflowResult =
  | { readonly ok: true; readonly workflow: JoyWorkflow; readonly order: readonly string[] }
  | { readonly ok: false; readonly issues: readonly AuthoringIssue[] };

function shapeIssue(path: string, message: string): AuthoringIssue {
  return { code: 'authoring/invalid-shape', message, path };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkRetryShape(value: unknown, path: string, issues: AuthoringIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push(shapeIssue(path, 'must be an object'));
    return;
  }
  if (typeof value['maxAttempts'] !== 'number') {
    issues.push(shapeIssue(`${path}.maxAttempts`, 'must be a number'));
  }
  if (typeof value['backoffMs'] !== 'number') {
    issues.push(shapeIssue(`${path}.backoffMs`, 'must be a number'));
  }
}

/**
 * Structural shape check for raw parsed JSON, so the typed validators in
 * `validateWorkflow` can safely assume field types afterwards.
 */
function checkWorkflowShape(raw: unknown): AuthoringIssue[] {
  const issues: AuthoringIssue[] = [];
  if (!isPlainObject(raw)) {
    return [shapeIssue('$', 'workflow document must be a JSON object')];
  }
  if (typeof raw['formatVersion'] !== 'number') {
    issues.push(shapeIssue('$.formatVersion', 'must be a number'));
  }
  for (const key of ['id', 'version', 'name'] as const) {
    if (typeof raw[key] !== 'string') {
      issues.push(shapeIssue(`$.${key}`, 'must be a string'));
    }
  }
  for (const key of ['inputs', 'outputs'] as const) {
    if (!isPlainObject(raw[key])) {
      issues.push(shapeIssue(`$.${key}`, 'must be a schema object'));
    }
  }
  const nodes = raw['nodes'];
  if (!Array.isArray(nodes)) {
    issues.push(shapeIssue('$.nodes', 'must be an array'));
  } else {
    nodes.forEach((node, index) => {
      const at = `$.nodes[${String(index)}]`;
      if (!isPlainObject(node)) {
        issues.push(shapeIssue(at, 'must be an object'));
        return;
      }
      for (const key of ['id', 'category', 'type'] as const) {
        if (typeof node[key] !== 'string') {
          issues.push(shapeIssue(`${at}.${key}`, 'must be a string'));
        }
      }
      if (!isPlainObject(node['params'])) {
        issues.push(shapeIssue(`${at}.params`, 'must be an object'));
      }
      if (typeof node['deterministic'] !== 'boolean') {
        issues.push(shapeIssue(`${at}.deterministic`, 'must be a boolean'));
      }
      if (node['retry'] !== undefined) {
        checkRetryShape(node['retry'], `${at}.retry`, issues);
      }
    });
  }
  const edges = raw['edges'];
  if (!Array.isArray(edges)) {
    issues.push(shapeIssue('$.edges', 'must be an array'));
  } else {
    edges.forEach((edge, index) => {
      const at = `$.edges[${String(index)}]`;
      if (
        !isPlainObject(edge) ||
        typeof edge['from'] !== 'string' ||
        typeof edge['to'] !== 'string'
      ) {
        issues.push(shapeIssue(at, 'must be an object with string "from" and "to"'));
      }
    });
  }
  const permissions = raw['permissions'];
  if (!Array.isArray(permissions)) {
    issues.push(shapeIssue('$.permissions', 'must be an array'));
  } else {
    permissions.forEach((permission, index) => {
      if (!isPlainObject(permission) || typeof permission['capability'] !== 'string') {
        issues.push(
          shapeIssue(
            `$.permissions[${String(index)}]`,
            'must be an object with a string "capability"',
          ),
        );
      }
    });
  }
  const policy = raw['policy'];
  if (!isPlainObject(policy)) {
    issues.push(shapeIssue('$.policy', 'must be an object'));
  } else {
    if (typeof policy['concurrency'] !== 'number') {
      issues.push(shapeIssue('$.policy.concurrency', 'must be a number'));
    }
    if (typeof policy['failure'] !== 'string') {
      issues.push(shapeIssue('$.policy.failure', 'must be a string'));
    }
    checkRetryShape(policy['defaultRetry'], '$.policy.defaultRetry', issues);
  }
  return issues;
}

/**
 * §23.7 JSON authoring entry point. Layered validation with coded issues:
 * JSON parse → structural shape → `validateWorkflow` (structure + DAG) →
 * inputs/outputs schema declarations → registry node validation when a
 * `NodeRegistry` is supplied. Never throws.
 */
export function parseWorkflowJson(
  raw: string,
  options: { readonly registry?: NodeRegistry } = {},
): ParseWorkflowResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: 'authoring/invalid-json',
          message: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  const shapeIssues = checkWorkflowShape(parsed);
  if (shapeIssues.length > 0) {
    return { ok: false, issues: shapeIssues };
  }
  const workflow = parsed as JoyWorkflow;

  const issues: AuthoringIssue[] = [];
  const validation = validateWorkflow(workflow);
  if (!validation.ok) {
    for (const issue of validation.issues) {
      issues.push({
        code: issue.code,
        message: issue.message,
        ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
      });
    }
  }
  for (const [field, schema] of [
    ['inputs', workflow.inputs],
    ['outputs', workflow.outputs],
  ] as const) {
    for (const issue of validateSchemaDeclaration(schema, `$.${field}`)) {
      issues.push({ code: 'authoring/invalid-schema', message: issue.message, path: issue.path });
    }
  }
  if (options.registry !== undefined) {
    for (const issue of options.registry.validateWorkflowNodes(workflow)) {
      issues.push({
        code: issue.code,
        message: issue.message,
        ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
        ...(issue.path === undefined ? {} : { path: issue.path }),
      });
    }
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, workflow, order: validation.ok ? validation.order : [] };
}

/** Stable, human-diffable serialization for authored workflows (§23.7 version diff). */
export function workflowToJson(workflow: JoyWorkflow): string {
  return `${JSON.stringify(workflow, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Code authoring: a small builder over the node registry.
// ---------------------------------------------------------------------------

export class WorkflowAuthoringError extends Error {
  readonly code: string;
  readonly issues: readonly AuthoringIssue[];

  constructor(code: string, message: string, issues: readonly AuthoringIssue[] = []) {
    super(message);
    this.name = 'WorkflowAuthoringError';
    this.code = code;
    this.issues = issues;
  }
}

export interface WorkflowBuilderOptions {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly outputs?: Readonly<Record<string, unknown>>;
  readonly policy?: {
    readonly concurrency?: number;
    readonly failure?: WorkflowFailureMode;
    readonly defaultRetry?: RetryPolicy;
  };
}

/**
 * §23.7 code authoring. Nodes are created through the registry so params are
 * validated at authoring time; `build()` re-runs full definition + registry
 * validation and throws a coded error carrying every issue.
 */
export class WorkflowBuilder {
  private readonly registry: NodeRegistry;
  private readonly options: WorkflowBuilderOptions;
  private readonly nodes: WorkflowNode[] = [];
  private readonly edges: { from: string; to: string }[] = [];
  private readonly permissions: WorkflowPermission[] = [];

  constructor(registry: NodeRegistry, options: WorkflowBuilderOptions) {
    this.registry = registry;
    this.options = options;
  }

  node(
    id: string,
    type: string,
    params: Readonly<Record<string, unknown>>,
    options: CreateNodeOptions = {},
  ): this {
    if (this.nodes.some((node) => node.id === id)) {
      throw new WorkflowAuthoringError(
        'authoring/duplicate-node-id',
        `node id "${id}" is already defined`,
      );
    }
    this.nodes.push(this.registry.createNode(id, type, params, options));
    return this;
  }

  edge(from: string, to: string): this {
    this.edges.push({ from, to });
    return this;
  }

  permission(capability: string): this {
    this.permissions.push({ capability });
    return this;
  }

  build(): { readonly workflow: JoyWorkflow; readonly order: readonly string[] } {
    const workflow: JoyWorkflow = {
      formatVersion: WORKFLOW_FORMAT_VERSION,
      id: this.options.id,
      version: this.options.version,
      name: this.options.name,
      inputs: this.options.inputs ?? { type: 'object' },
      outputs: this.options.outputs ?? { type: 'object' },
      nodes: [...this.nodes],
      edges: [...this.edges],
      permissions: [...this.permissions],
      policy: {
        concurrency: this.options.policy?.concurrency ?? 1,
        failure: this.options.policy?.failure ?? 'stop',
        defaultRetry: this.options.policy?.defaultRetry ?? { maxAttempts: 1, backoffMs: 0 },
      },
    };
    const result = parseWorkflowJson(workflowToJson(workflow), { registry: this.registry });
    if (!result.ok) {
      const first = result.issues[0];
      throw new WorkflowAuthoringError(
        'authoring/invalid-workflow',
        `workflow failed validation: ${first ? `${first.code} — ${first.message}` : 'unknown'}`,
        result.issues,
      );
    }
    return { workflow: result.workflow, order: result.order };
  }
}
