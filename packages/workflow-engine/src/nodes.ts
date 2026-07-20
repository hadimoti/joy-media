/** P07 WP-07.2 — typed node specs and the node registry (§23.2, §23.7 code/JSON authoring). */

import type { JoyWorkflow, RetryPolicy, WorkflowNode, WorkflowNodeCategory } from './definition.js';

export interface NodeParamIssue {
  /** Dotted path into params, e.g. `condition.left`. */
  readonly path: string;
  readonly message: string;
}

export type NodeParamValidator = (params: Readonly<Record<string, unknown>>) => NodeParamIssue[];

/**
 * A concrete node type in the library: one §23.2 category, a namespaced type name,
 * a determinism default (§23.5 reuse semantics), and a params validator.
 */
export interface WorkflowNodeSpec {
  /** Namespaced type, `<category>.<name>`, e.g. `analysis.transcribe`. */
  readonly type: string;
  readonly category: WorkflowNodeCategory;
  readonly description: string;
  /** Default §23.5 determinism; `createNode` may not override generation nodes to true. */
  readonly deterministic: boolean;
  readonly validateParams: NodeParamValidator;
}

export type NodeLibraryIssueCode =
  | 'node-library/unknown-type'
  | 'node-library/category-mismatch'
  | 'node-library/invalid-params'
  | 'node-library/determinism-mismatch';

export interface NodeLibraryIssue {
  readonly code: NodeLibraryIssueCode;
  readonly message: string;
  readonly nodeId?: string;
  readonly path?: string;
}

export class NodeRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NodeRegistryError';
    this.code = code;
  }
}

export interface CreateNodeOptions {
  readonly retry?: RetryPolicy;
  /**
   * Determinism override. Tightening (true → false) is always allowed; claiming a
   * generation node is deterministic is rejected — §23.5 reuses generation only by policy.
   */
  readonly deterministic?: boolean;
}

/** Registry of node specs; the searchable palette contract behind §23.7 authoring. */
export class NodeRegistry {
  private readonly specs = new Map<string, WorkflowNodeSpec>();

  register(spec: WorkflowNodeSpec): this {
    if (this.specs.has(spec.type)) {
      throw new NodeRegistryError(
        'node-library/duplicate-type',
        `node type "${spec.type}" is already registered`,
      );
    }
    if (!spec.type.startsWith(`${spec.category}.`)) {
      throw new NodeRegistryError(
        'node-library/type-category-prefix',
        `node type "${spec.type}" must be prefixed with its category "${spec.category}."`,
      );
    }
    this.specs.set(spec.type, spec);
    return this;
  }

  get(type: string): WorkflowNodeSpec | undefined {
    return this.specs.get(type);
  }

  list(): readonly WorkflowNodeSpec[] {
    return [...this.specs.values()];
  }

  listByCategory(category: WorkflowNodeCategory): readonly WorkflowNodeSpec[] {
    return this.list().filter((spec) => spec.category === category);
  }

  /** Build a validated `WorkflowNode` from a registered spec. Throws on invalid params. */
  createNode(
    id: string,
    type: string,
    params: Readonly<Record<string, unknown>>,
    options: CreateNodeOptions = {},
  ): WorkflowNode {
    const spec = this.specs.get(type);
    if (spec === undefined) {
      throw new NodeRegistryError(
        'node-library/unknown-type',
        `node type "${type}" is not registered`,
      );
    }
    const paramIssues = spec.validateParams(params);
    if (paramIssues.length > 0) {
      const first = paramIssues[0];
      throw new NodeRegistryError(
        'node-library/invalid-params',
        `invalid params for "${type}": ${first ? `${first.path}: ${first.message}` : 'unknown'}`,
      );
    }
    if (options.deterministic === true && !spec.deterministic && spec.category === 'generation') {
      throw new NodeRegistryError(
        'node-library/determinism-mismatch',
        `generation node "${type}" cannot be declared deterministic (§23.5)`,
      );
    }
    const node: {
      id: string;
      category: WorkflowNodeCategory;
      type: string;
      params: Readonly<Record<string, unknown>>;
      deterministic: boolean;
      retry?: RetryPolicy;
    } = {
      id,
      category: spec.category,
      type,
      params,
      deterministic: options.deterministic ?? spec.deterministic,
    };
    if (options.retry !== undefined) {
      node.retry = options.retry;
    }
    return node;
  }

  /**
   * Registry-level validation for authored/imported workflow JSON (§23.7): every node
   * type must be registered, carry its spec's category, and pass its param validator.
   * Complements the structural/DAG checks in `validateWorkflow`.
   */
  validateWorkflowNodes(workflow: JoyWorkflow): readonly NodeLibraryIssue[] {
    const issues: NodeLibraryIssue[] = [];
    for (const node of workflow.nodes) {
      const spec = this.specs.get(node.type);
      if (spec === undefined) {
        issues.push({
          code: 'node-library/unknown-type',
          message: `node "${node.id}" uses unregistered type "${node.type}"`,
          nodeId: node.id,
        });
        continue;
      }
      if (spec.category !== node.category) {
        issues.push({
          code: 'node-library/category-mismatch',
          message: `node "${node.id}" declares category "${node.category}" but "${node.type}" is "${spec.category}"`,
          nodeId: node.id,
        });
      }
      if (node.deterministic && !spec.deterministic && spec.category === 'generation') {
        issues.push({
          code: 'node-library/determinism-mismatch',
          message: `generation node "${node.id}" ("${node.type}") cannot be deterministic (§23.5)`,
          nodeId: node.id,
        });
      }
      for (const issue of spec.validateParams(node.params)) {
        issues.push({
          code: 'node-library/invalid-params',
          message: `node "${node.id}" ("${node.type}"): ${issue.path}: ${issue.message}`,
          nodeId: node.id,
          path: issue.path,
        });
      }
    }
    return issues;
  }
}

// --- Small param-validation helpers used by the v1 catalog (no external deps). ---

export const paramIssue = (path: string, message: string): NodeParamIssue => ({ path, message });

export function requireString(
  params: Readonly<Record<string, unknown>>,
  key: string,
  issues: NodeParamIssue[],
): void {
  const value = params[key];
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(paramIssue(key, 'must be a non-empty string'));
  }
}

export function optionalString(
  params: Readonly<Record<string, unknown>>,
  key: string,
  issues: NodeParamIssue[],
): void {
  const value = params[key];
  if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
    issues.push(paramIssue(key, 'must be a non-empty string when present'));
  }
}

export function requireEnum(
  params: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly string[],
  issues: NodeParamIssue[],
): void {
  const value = params[key];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    issues.push(paramIssue(key, `must be one of: ${allowed.join(', ')}`));
  }
}

export function requireArray(
  params: Readonly<Record<string, unknown>>,
  key: string,
  issues: NodeParamIssue[],
): void {
  if (!Array.isArray(params[key])) {
    issues.push(paramIssue(key, 'must be an array'));
  }
}
