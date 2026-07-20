/** P07 WP-07.1 — workflow definition format, versioning, and DAG validation (§23.2, §23.3). */

export const WORKFLOW_FORMAT_VERSION = 1 as const;

/** §23.2 node categories. Concrete node types (WP-07.2) declare one category each. */
export type WorkflowNodeCategory =
  | 'input'
  | 'analysis'
  | 'transform'
  | 'generation'
  | 'decision'
  | 'editor'
  | 'render'
  | 'output'
  | 'control';

export const WORKFLOW_NODE_CATEGORIES: readonly WorkflowNodeCategory[] = [
  'input',
  'analysis',
  'transform',
  'generation',
  'decision',
  'editor',
  'render',
  'output',
  'control',
];

export interface RetryPolicy {
  /** Total attempts including the first (>= 1). */
  readonly maxAttempts: number;
  /** Deterministic backoff between attempts; the runtime records it, schedulers apply it. */
  readonly backoffMs: number;
}

export interface WorkflowNode {
  readonly id: string;
  readonly category: WorkflowNodeCategory;
  /** Namespaced node type, e.g. `analysis.transcribe`; resolved to a handler at run time. */
  readonly type: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** §23.5: deterministic nodes may be reused across resumes; nondeterministic only by policy. */
  readonly deterministic: boolean;
  readonly retry?: RetryPolicy;
}

export interface WorkflowEdge {
  readonly from: string;
  readonly to: string;
}

export interface WorkflowPermission {
  /** Capability the workflow may exercise, e.g. `remote.upload`; enforced by approval policy. */
  readonly capability: string;
}

export type WorkflowFailureMode = 'stop' | 'continue-independent' | 'manual';

/** §23.3 versioned workflow definition. */
export interface JoyWorkflow {
  readonly formatVersion: typeof WORKFLOW_FORMAT_VERSION;
  readonly id: string;
  readonly version: string;
  readonly name: string;
  /** JSON-Schema-shaped description of run inputs (validated structurally in WP-07.3). */
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly permissions: readonly WorkflowPermission[];
  readonly policy: {
    readonly concurrency: number;
    readonly failure: WorkflowFailureMode;
    readonly defaultRetry: RetryPolicy;
  };
}

export type WorkflowIssueCode =
  | 'workflow/unsupported-format-version'
  | 'workflow/empty-identity'
  | 'workflow/invalid-policy'
  | 'workflow/invalid-retry'
  | 'workflow/duplicate-node-id'
  | 'workflow/empty-node-id'
  | 'workflow/unknown-node-category'
  | 'workflow/empty-node-type'
  | 'workflow/unknown-edge-endpoint'
  | 'workflow/self-edge'
  | 'workflow/duplicate-edge'
  | 'workflow/cycle';

export interface WorkflowIssue {
  readonly code: WorkflowIssueCode;
  readonly message: string;
  readonly nodeId?: string;
}

export type WorkflowValidation =
  | { readonly ok: true; readonly order: readonly string[] }
  | { readonly ok: false; readonly issues: readonly WorkflowIssue[] };

function validateRetry(retry: RetryPolicy, where: string, issues: WorkflowIssue[]): void {
  if (
    !Number.isInteger(retry.maxAttempts) ||
    retry.maxAttempts < 1 ||
    !Number.isFinite(retry.backoffMs) ||
    retry.backoffMs < 0
  ) {
    issues.push({
      code: 'workflow/invalid-retry',
      message: `${where}: maxAttempts must be an integer >= 1 and backoffMs >= 0`,
    });
  }
}

/**
 * Structural + graph validation. Rejects cycles (Kahn), dangling/self/duplicate edges and
 * duplicate node ids; on success returns a deterministic topological execution order
 * (ready nodes are taken in definition order).
 */
export function validateWorkflow(workflow: JoyWorkflow): WorkflowValidation {
  const issues: WorkflowIssue[] = [];

  if (workflow.formatVersion !== WORKFLOW_FORMAT_VERSION) {
    issues.push({
      code: 'workflow/unsupported-format-version',
      message: `formatVersion ${String(workflow.formatVersion)} is not supported (expected ${WORKFLOW_FORMAT_VERSION})`,
    });
  }
  if (workflow.id.trim() === '' || workflow.version.trim() === '' || workflow.name.trim() === '') {
    issues.push({
      code: 'workflow/empty-identity',
      message: 'workflow id, version, and name must be non-empty',
    });
  }
  if (!Number.isInteger(workflow.policy.concurrency) || workflow.policy.concurrency < 1) {
    issues.push({
      code: 'workflow/invalid-policy',
      message: 'policy.concurrency must be an integer >= 1',
    });
  }
  validateRetry(workflow.policy.defaultRetry, 'policy.defaultRetry', issues);

  const nodeIds = new Set<string>();
  for (const node of workflow.nodes) {
    if (node.id.trim() === '') {
      issues.push({ code: 'workflow/empty-node-id', message: 'node id must be non-empty' });
      continue;
    }
    if (nodeIds.has(node.id)) {
      issues.push({
        code: 'workflow/duplicate-node-id',
        message: `duplicate node id "${node.id}"`,
        nodeId: node.id,
      });
    }
    nodeIds.add(node.id);
    if (!WORKFLOW_NODE_CATEGORIES.includes(node.category)) {
      issues.push({
        code: 'workflow/unknown-node-category',
        message: `node "${node.id}" has unknown category "${String(node.category)}"`,
        nodeId: node.id,
      });
    }
    if (node.type.trim() === '') {
      issues.push({
        code: 'workflow/empty-node-type',
        message: `node "${node.id}" has an empty type`,
        nodeId: node.id,
      });
    }
    if (node.retry !== undefined) {
      validateRetry(node.retry, `node "${node.id}" retry`, issues);
    }
  }

  const seenEdges = new Set<string>();
  for (const edge of workflow.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      issues.push({
        code: 'workflow/unknown-edge-endpoint',
        message: `edge ${edge.from} -> ${edge.to} references an unknown node`,
      });
      continue;
    }
    if (edge.from === edge.to) {
      issues.push({
        code: 'workflow/self-edge',
        message: `edge ${edge.from} -> ${edge.to} is a self-edge`,
        nodeId: edge.from,
      });
      continue;
    }
    const key = `${edge.from} ${edge.to}`;
    if (seenEdges.has(key)) {
      issues.push({
        code: 'workflow/duplicate-edge',
        message: `duplicate edge ${edge.from} -> ${edge.to}`,
      });
    }
    seenEdges.add(key);
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  // Kahn topological sort; deterministic because ready nodes are visited in definition order.
  const indegree = new Map<string, number>();
  const downstream = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    indegree.set(node.id, 0);
    downstream.set(node.id, []);
  }
  for (const edge of workflow.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    downstream.get(edge.from)?.push(edge.to);
  }
  const order: string[] = [];
  const ready = workflow.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  while (ready.length > 0) {
    const id = ready.shift() as string;
    order.push(id);
    for (const next of downstream.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
      }
    }
  }
  if (order.length !== workflow.nodes.length) {
    const stuck = workflow.nodes.filter((n) => !order.includes(n.id)).map((n) => n.id);
    return {
      ok: false,
      issues: [
        {
          code: 'workflow/cycle',
          message: `workflow graph contains a cycle involving: ${stuck.join(', ')}`,
        },
      ],
    };
  }
  return { ok: true, order };
}

/** Upstream node ids for each node, in deterministic (definition-order) form. */
export function upstreamOf(workflow: JoyWorkflow): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    map.set(node.id, []);
  }
  for (const edge of workflow.edges) {
    map.get(edge.to)?.push(edge.from);
  }
  return map;
}
