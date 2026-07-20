/** P07 WP-07.3 — run operations: per-node logs/artifacts and the run dashboard model (§23.7). */

import type { JoyWorkflow } from './definition.js';
import type {
  ExecuteWorkflowResult,
  HumanInputRequest,
  NodeHandler,
  NodeResult,
  NodeRunState,
} from './runtime.js';

export type RunLogLevel = 'info' | 'warn' | 'error';

export interface RunLogEntry {
  /** Monotonic sequence number; the deterministic ordering key (no wall clock). */
  readonly seq: number;
  readonly nodeId: string;
  readonly attempt: number;
  readonly level: RunLogLevel;
  readonly message: string;
  /** JSON-serializable structured payload. */
  readonly data?: unknown;
}

export const RUN_ARTIFACT_KINDS = ['file', 'json', 'render', 'link'] as const;

export type RunArtifactKind = (typeof RUN_ARTIFACT_KINDS)[number];

export interface RunArtifact {
  readonly nodeId: string;
  readonly name: string;
  readonly kind: RunArtifactKind;
  /** Opaque reference (path, asset id, URL); never raw bytes. */
  readonly ref: string;
  readonly mediaType?: string;
}

/** Artifact declaration a node output may carry (without the nodeId, which is implied). */
export type RunArtifactDeclaration = Omit<RunArtifact, 'nodeId'>;

export function isRunArtifactDeclaration(value: unknown): value is RunArtifactDeclaration {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['name'] === 'string' &&
    typeof record['ref'] === 'string' &&
    RUN_ARTIFACT_KINDS.includes(record['kind'] as RunArtifactKind) &&
    (record['mediaType'] === undefined || typeof record['mediaType'] === 'string')
  );
}

/**
 * Collects per-node logs and artifacts for one run. Ordering is a monotonic
 * sequence number, not wall-clock time, so recorded runs stay deterministic.
 */
export class RunRecorder {
  private seq = 0;
  private readonly entries: RunLogEntry[] = [];
  private readonly collected: RunArtifact[] = [];

  log(nodeId: string, level: RunLogLevel, message: string, attempt = 0, data?: unknown): void {
    this.seq += 1;
    this.entries.push({
      seq: this.seq,
      nodeId,
      attempt,
      level,
      message,
      ...(data === undefined ? {} : { data }),
    });
  }

  addArtifact(artifact: RunArtifact): void {
    this.collected.push(artifact);
  }

  logEntries(): readonly RunLogEntry[] {
    return [...this.entries];
  }

  artifacts(): readonly RunArtifact[] {
    return [...this.collected];
  }
}

/**
 * Wraps every handler so each attempt and outcome is logged against its node,
 * and artifact declarations carried on a successful output's `artifacts` array
 * are collected. Handler semantics (results, thrown errors) are unchanged.
 */
export function instrumentHandlers(
  handlers: Readonly<Record<string, NodeHandler>>,
  recorder: RunRecorder,
): Readonly<Record<string, NodeHandler>> {
  const wrapped: Record<string, NodeHandler> = {};
  for (const [type, handler] of Object.entries(handlers)) {
    wrapped[type] = (ctx) => {
      recorder.log(ctx.node.id, 'info', `attempt ${String(ctx.attempt)} started`, ctx.attempt);
      let result: NodeResult;
      try {
        result = handler(ctx);
      } catch (error) {
        recorder.log(
          ctx.node.id,
          'error',
          `attempt ${String(ctx.attempt)} threw: ${error instanceof Error ? error.message : String(error)}`,
          ctx.attempt,
        );
        throw error;
      }
      if ('waiting' in result) {
        recorder.log(
          ctx.node.id,
          'warn',
          `waiting_for_input: ${result.request.kind}`,
          ctx.attempt,
          { prompt: result.request.prompt },
        );
      } else if (result.ok) {
        recorder.log(ctx.node.id, 'info', 'succeeded', ctx.attempt);
        const artifacts = (result.output as { artifacts?: unknown } | null)?.artifacts;
        if (Array.isArray(artifacts)) {
          for (const declaration of artifacts) {
            if (isRunArtifactDeclaration(declaration)) {
              recorder.addArtifact({ nodeId: ctx.node.id, ...declaration });
            }
          }
        }
      } else {
        recorder.log(
          ctx.node.id,
          'error',
          `failed: ${result.failureCode} (${result.retryable ? 'retryable' : 'non-retryable'})`,
          ctx.attempt,
        );
      }
      return result;
    };
  }
  return wrapped;
}

// ---------------------------------------------------------------------------
// Run dashboard model: the JSON contract behind §23.7 "logs and artifacts per
// node". The visual builder/dashboard UI is deferred; this is its data source.
// ---------------------------------------------------------------------------

export interface RunDashboardNode {
  readonly nodeId: string;
  readonly type: string;
  readonly category: string;
  readonly state: NodeRunState;
  readonly attempts: number;
  readonly deterministic: boolean;
  readonly runKey: string;
  /** True when the node was restored from a checkpoint without re-running. */
  readonly reused: boolean;
  readonly failureCode?: string;
  readonly pendingRequest?: HumanInputRequest;
  readonly logs: readonly RunLogEntry[];
  readonly artifacts: readonly RunArtifact[];
}

export interface RunDashboard {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly projectRevision: string;
  readonly state: string;
  /** Node counts per state; absent states are omitted. */
  readonly counts: Readonly<Partial<Record<NodeRunState, number>>>;
  readonly executedNodeIds: readonly string[];
  readonly reusedNodeIds: readonly string[];
  readonly nodes: readonly RunDashboardNode[];
}

export interface BuildRunDashboardOptions {
  readonly workflow: JoyWorkflow;
  readonly result: ExecuteWorkflowResult;
  readonly recorder?: RunRecorder;
}

/** Joins the checkpoint, workflow definition, and recorder into one JSON view. */
export function buildRunDashboard(options: BuildRunDashboardOptions): RunDashboard {
  const { workflow, result, recorder } = options;
  const { checkpoint } = result;
  const logs = recorder?.logEntries() ?? [];
  const artifacts = recorder?.artifacts() ?? [];
  const reused = new Set(result.reusedNodeIds);

  const counts: Partial<Record<NodeRunState, number>> = {};
  const nodes: RunDashboardNode[] = [];
  for (const node of workflow.nodes) {
    const record = checkpoint.nodes[node.id];
    if (record === undefined) {
      continue;
    }
    counts[record.state] = (counts[record.state] ?? 0) + 1;
    nodes.push({
      nodeId: node.id,
      type: node.type,
      category: node.category,
      state: record.state,
      attempts: record.attempts,
      deterministic: record.deterministic,
      runKey: record.runKey,
      reused: reused.has(node.id),
      ...(record.failureCode === undefined ? {} : { failureCode: record.failureCode }),
      ...(record.pendingRequest === undefined ? {} : { pendingRequest: record.pendingRequest }),
      logs: logs.filter((entry) => entry.nodeId === node.id),
      artifacts: artifacts.filter((artifact) => artifact.nodeId === node.id),
    });
  }

  return {
    runId: checkpoint.runId,
    workflowId: checkpoint.workflowId,
    workflowVersion: checkpoint.workflowVersion,
    projectRevision: checkpoint.projectRevision,
    state: checkpoint.state,
    counts,
    executedNodeIds: result.executedNodeIds,
    reusedNodeIds: result.reusedNodeIds,
    nodes,
  };
}

/** Terse fixed-format text view of a dashboard, for the headless CLI (§7.4). */
export function renderRunDashboardText(dashboard: RunDashboard): string {
  const lines: string[] = [];
  lines.push(
    `run ${dashboard.runId} — ${dashboard.workflowId}@${dashboard.workflowVersion} — ${dashboard.state}`,
  );
  const countText = Object.entries(dashboard.counts)
    .map(([state, count]) => `${state}=${String(count)}`)
    .join(' ');
  lines.push(`nodes: ${countText === '' ? 'none' : countText}`);
  for (const node of dashboard.nodes) {
    const marks: string[] = [];
    if (node.reused) {
      marks.push('reused');
    }
    if (node.failureCode !== undefined) {
      marks.push(node.failureCode);
    }
    if (node.pendingRequest !== undefined) {
      marks.push(`awaiting ${node.pendingRequest.kind}`);
    }
    const suffix = marks.length > 0 ? ` [${marks.join(', ')}]` : '';
    lines.push(
      `  ${node.nodeId} (${node.type}) ${node.state} attempts=${String(node.attempts)}${suffix}`,
    );
    for (const artifact of node.artifacts) {
      lines.push(`    artifact ${artifact.kind} ${artifact.name} -> ${artifact.ref}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
