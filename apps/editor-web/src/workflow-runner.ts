// apps/editor-web/src/workflow-runner.ts

import type { EditorSession } from './editor-session.js';
import {
  executeWorkflow,
  type HumanInputRequest,
  type JoyWorkflow,
  type RunCheckpoint,
  type WorkflowEdge,
  type WorkflowNode,
} from '@joy-media/workflow-engine';
import type { SpikeCommand } from '@joy-media/commands';
import { createAgentCommandBus } from './agent-command-bus.js';
import { loadWorkflow, resolveParameterizedValue } from './workflow-recorder.js';
import { getFirstPartyWorkflow } from './first-party-workflows.js';
import { createStubFirstPartyLibrary } from './first-party-handlers.js';

interface NodeRunResult {
  readonly nodeId: string;
  readonly success: boolean;
  readonly error?: string;
}

type CommandLike = { readonly tool: string; readonly arguments: unknown };

export interface ParkedWorkflowRun {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflow: JoyWorkflow;
  readonly workflowInputs: unknown;
  readonly checkpoint: RunCheckpoint;
  readonly nodeId: string;
  readonly request: HumanInputRequest;
}

export type WorkflowRunOutcome =
  | {
      readonly status: 'succeeded';
      readonly workflowId: string;
      readonly runId: string;
      readonly outputs?: unknown;
    }
  | {
      readonly status: 'waiting_for_input';
      readonly workflowId: string;
      readonly runId: string;
      readonly nodeId: string;
      readonly request: HumanInputRequest;
      readonly checkpoint: RunCheckpoint;
    }
  | {
      readonly status: 'failed';
      readonly workflowId: string;
      readonly runId: string;
      readonly error: string;
    };

const parkedRuns = new Map<string, ParkedWorkflowRun>();
let stubLibrary = createStubFirstPartyLibrary();

/** Test seam: replace the stub library (e.g. to assert call counts). */
export function setFirstPartyLibraryForTests(library: ReturnType<typeof createStubFirstPartyLibrary>): void {
  stubLibrary = library;
}

export function resetFirstPartyLibraryForTests(): void {
  stubLibrary = createStubFirstPartyLibrary();
  parkedRuns.clear();
}

export function getParkedWorkflowRun(runId: string): ParkedWorkflowRun | undefined {
  return parkedRuns.get(runId);
}

function spikeCommandsFor(commands: readonly CommandLike[]): SpikeCommand[] {
  const mapped: SpikeCommand[] = [];
  for (const cmd of commands) {
    const payload = cmd.arguments as Record<string, unknown>;
    switch (cmd.tool) {
      case 'insertClip':
        mapped.push({ type: 'timeline.insertClip', payload } as unknown as SpikeCommand);
        break;
      case 'removeClip':
        mapped.push({ type: 'timeline.removeClip', payload } as unknown as SpikeCommand);
        break;
      case 'moveClip':
        mapped.push({ type: 'timeline.moveClip', payload } as unknown as SpikeCommand);
        break;
      case 'trimClip': {
        if (typeof payload.newStartUs === 'number') {
          mapped.push({ type: 'timeline.trimClipStart', payload } as unknown as SpikeCommand);
        }
        if (typeof payload.newEndUs === 'number') {
          mapped.push({ type: 'timeline.trimClipEnd', payload } as unknown as SpikeCommand);
        }
        break;
      }
      case 'splitClip':
        mapped.push({ type: 'timeline.splitClip', payload } as unknown as SpikeCommand);
        break;
      case 'joinClips':
        mapped.push({ type: 'timeline.joinClips', payload } as unknown as SpikeCommand);
        break;
      default:
        throw new Error(`Unsupported workflow command: ${cmd.tool}`);
    }
  }
  return mapped;
}

function kahnTopoOrder(nodes: readonly WorkflowNode[], edges: readonly WorkflowEdge[]): readonly string[] {
  const indegree = new Map<string, number>();
  const downstream = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node.id, 0);
    downstream.set(node.id, []);
  }
  for (const edge of edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    downstream.get(edge.from)?.push(edge.to);
  }
  const ready = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) {
      continue;
    }
    order.push(id);
    for (const next of downstream.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
      }
    }
  }
  return order;
}

function resolveWorkflow(session: EditorSession, workflowId: string): JoyWorkflow {
  const recorded = loadWorkflow(session, workflowId);
  if (recorded !== undefined) {
    return recorded.workflow;
  }
  const system = getFirstPartyWorkflow(workflowId);
  if (system !== undefined) {
    return system.workflow;
  }
  throw new Error(`Workflow not found: ${workflowId}`);
}

/** Normalize editor modal inputs into the first-party workflow input shape. */
export function normalizeFirstPartyInputs(
  workflow: JoyWorkflow,
  inputs: Readonly<Record<string, unknown>>,
): unknown {
  const required = (workflow.inputs.required as string[] | undefined) ?? [];
  if (required.includes('asset') && inputs.asset === undefined && typeof inputs.assetId === 'string') {
    return { ...inputs, asset: { assetId: inputs.assetId, fixture: true } };
  }
  if (typeof inputs.asset === 'string') {
    return { ...inputs, asset: { assetId: inputs.asset, fixture: true } };
  }
  return inputs;
}

function findPendingApproval(checkpoint: RunCheckpoint): {
  readonly nodeId: string;
  readonly request: HumanInputRequest;
} | undefined {
  for (const [nodeId, record] of Object.entries(checkpoint.nodes)) {
    if (record.state === 'waiting_for_input' && record.pendingRequest !== undefined) {
      return { nodeId, request: record.pendingRequest };
    }
  }
  return undefined;
}

function newRunId(workflowId: string): string {
  return `editor-${workflowId.replaceAll('.', '-')}-${String(Date.now())}`;
}

async function runRecordedWorkflow(
  session: EditorSession,
  workflow: JoyWorkflow,
  inputs: Readonly<Record<string, unknown>>,
): Promise<WorkflowRunOutcome> {
  const runId = newRunId(workflow.id);
  if (workflow.formatVersion !== 1) {
    return {
      status: 'failed',
      workflowId: workflow.id,
      runId,
      error: `Unsupported workflow format version: ${String(workflow.formatVersion)}`,
    };
  }

  const bus = createAgentCommandBus(session);
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const order = kahnTopoOrder(workflow.nodes, workflow.edges);

  const results = new Map<string, NodeRunResult>();
  for (const nodeId of order) {
    const node = byId.get(nodeId);
    if (node === undefined) {
      continue;
    }

    if (node.category === 'editor' && node.type === 'editor.commandTransaction') {
      const commands = (node.params.commands as readonly CommandLike[] | undefined) ?? [];
      if (commands.length === 0) {
        results.set(nodeId, { nodeId, success: true });
        continue;
      }

      const resolvedCommands = commands.map((cmd) => ({
        ...cmd,
        arguments: resolveParameterizedValue(cmd.arguments, inputs),
      }));
      const spikeCommands = spikeCommandsFor(resolvedCommands);
      const label = (node.params.label as string | undefined) ?? nodeId;
      const result = bus.dispatchTimeline(spikeCommands, label);
      const success = result.success ?? false;
      const nodeResult: NodeRunResult = { ...(!success ? { error: result.error } : {}), nodeId, success };
      results.set(nodeId, nodeResult);
      if (!success && workflow.policy.failure === 'stop') {
        return {
          status: 'failed',
          workflowId: workflow.id,
          runId,
          error: `Workflow stopped at ${nodeId}: ${String(result.error ?? 'unknown error')}`,
        };
      }
    } else {
      const nodeResult: NodeRunResult = { nodeId, success: false, error: `unsupported node type ${node.type}` };
      results.set(nodeId, nodeResult);
      if (workflow.policy.failure === 'stop') {
        return {
          status: 'failed',
          workflowId: workflow.id,
          runId,
          error: `Workflow stopped at ${nodeId}: unsupported node type ${node.type}`,
        };
      }
    }
  }

  return { status: 'succeeded', workflowId: workflow.id, runId };
}

function runFirstPartyWorkflow(
  workflow: JoyWorkflow,
  inputs: Readonly<Record<string, unknown>>,
  options: {
    readonly runId?: string;
    readonly resumeFrom?: RunCheckpoint;
    readonly humanInputs?: Readonly<Record<string, unknown>>;
  } = {},
): WorkflowRunOutcome {
  const runId = options.runId ?? newRunId(workflow.id);
  const workflowInputs = normalizeFirstPartyInputs(workflow, inputs);
  const result = executeWorkflow({
    workflow,
    runId,
    projectRevision: 'editor-local',
    workflowInputs,
    handlers: stubLibrary.handlers,
    ...(options.resumeFrom !== undefined ? { resumeFrom: options.resumeFrom } : {}),
    ...(options.humanInputs !== undefined ? { humanInputs: options.humanInputs } : {}),
  });

  const checkpoint = result.checkpoint;
  if (checkpoint.state === 'waiting_for_input') {
    const pending = findPendingApproval(checkpoint);
    if (pending === undefined) {
      return {
        status: 'failed',
        workflowId: workflow.id,
        runId,
        error: 'Workflow parked without a pending approval request',
      };
    }
    parkedRuns.set(runId, {
      runId,
      workflowId: workflow.id,
      workflow,
      workflowInputs,
      checkpoint,
      nodeId: pending.nodeId,
      request: pending.request,
    });
    return {
      status: 'waiting_for_input',
      workflowId: workflow.id,
      runId,
      nodeId: pending.nodeId,
      request: pending.request,
      checkpoint,
    };
  }

  parkedRuns.delete(runId);

  if (checkpoint.state === 'failed' || checkpoint.state === 'waiting_for_manual_intervention') {
    const failedNode = Object.entries(checkpoint.nodes).find(([, node]) => node.state === 'failed');
    return {
      status: 'failed',
      workflowId: workflow.id,
      runId,
      error: failedNode?.[1].failureCode ?? `Workflow ended in state ${checkpoint.state}`,
    };
  }

  const outputsNode = checkpoint.nodes['manifest'] ?? checkpoint.nodes['write-manifest'];
  return {
    status: 'succeeded',
    workflowId: workflow.id,
    runId,
    ...(outputsNode?.output !== undefined ? { outputs: outputsNode.output } : {}),
  };
}

export async function runWorkflow(
  session: EditorSession,
  workflowId: string,
  inputs: Readonly<Record<string, unknown>> = {},
): Promise<WorkflowRunOutcome> {
  const recorded = loadWorkflow(session, workflowId);
  if (recorded !== undefined) {
    return runRecordedWorkflow(session, recorded.workflow, inputs);
  }

  const system = getFirstPartyWorkflow(workflowId);
  if (system === undefined) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }
  return runFirstPartyWorkflow(system.workflow, inputs);
}

export async function resumeWorkflow(
  _session: EditorSession,
  runId: string,
  humanInputs: Readonly<Record<string, unknown>>,
): Promise<WorkflowRunOutcome> {
  const parked = parkedRuns.get(runId);
  if (parked === undefined) {
    return {
      status: 'failed',
      workflowId: 'unknown',
      runId,
      error: `No parked workflow run: ${runId}`,
    };
  }

  const inputs =
    typeof parked.workflowInputs === 'object' && parked.workflowInputs !== null
      ? (parked.workflowInputs as Record<string, unknown>)
      : {};

  return runFirstPartyWorkflow(parked.workflow, inputs, {
    runId: parked.runId,
    resumeFrom: parked.checkpoint,
    humanInputs,
  });
}

export { resolveWorkflow };
