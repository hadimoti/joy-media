import type { EditorSession } from './editor-session.js';
import type { JoyWorkflow, WorkflowEdge, WorkflowNode } from '@joy-media/workflow-engine';
import type { SpikeCommand } from '@joy-media/commands';
import { createAgentCommandBus } from './agent-command-bus.js';
import type { RecordedWorkflow } from './workflow-recorder.js';
import { loadWorkflow, resolveParameterizedValue } from './workflow-recorder.js';

interface NodeRunResult {
  readonly nodeId: string;
  readonly success: boolean;
  readonly error?: string;
}

type CommandLike = { readonly tool: string; readonly arguments: unknown };

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

export async function runWorkflow(
  session: EditorSession,
  workflowId: string,
  inputs: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  const recorded = loadWorkflow(session, workflowId);
  if (recorded === undefined) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }

  const workflow = recorded.workflow;
  if (workflow.formatVersion !== 1) {
    throw new Error(`Unsupported workflow format version: ${String(workflow.formatVersion)}`);
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
        throw new Error(`Workflow stopped at ${nodeId}: ${String(result.error ?? 'unknown error')}`);
      }
    } else {
      const nodeResult: NodeRunResult = { nodeId, success: false, error: `unsupported node type ${node.type}` };
      results.set(nodeId, nodeResult);
      if (workflow.policy.failure === 'stop') {
        throw new Error(`Workflow stopped at ${nodeId}: unsupported node type ${node.type}`);
      }
    }
  }
}

