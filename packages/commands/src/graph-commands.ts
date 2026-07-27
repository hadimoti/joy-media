/**
 * Workflow graph commands (ADR-0024, plan §9.3).
 *
 * The graph is edited the same way the timeline is: semantic commands over an
 * immutable value, each returning the next graph AND its inverse computed from
 * pre-state, so history can undo without patches. Rollback is free because a
 * failed command simply discards the intermediate value.
 *
 * This is a command *family*, not a second undo system — the distinction the
 * plan's non-goals turn on. There is no history class here. `applyGraphTransaction`
 * hands back inverses in the same shape `applyTransaction` does, so the editor's
 * single unified history owns graph edits alongside timeline, audio, and
 * document edits, and one Undo means one user action regardless of which lens
 * the user was looking through when they made it.
 *
 * Ids are supplied by callers, never generated here, so serialization and
 * replay stay deterministic (ADR-0003).
 */

import type {
  AgentAssignmentV2,
  TemporalBinding,
  WorkflowEdgeV2,
  WorkflowGraphV2,
  WorkflowGroupV2,
  WorkflowNodeV2,
  WorkflowNodeStatus,
} from '@joy-media/project-schema';
import { arePortsCompatible, validateWorkflowGraph } from '@joy-media/project-schema';

export class GraphCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GraphCommandError';
    this.code = code;
  }
}

export interface NodeUiStateV2 {
  readonly position: { readonly x: number; readonly y: number };
  readonly collapsed?: boolean;
  readonly colorTag?: string;
}

export type WorkflowGraphCommand =
  | { readonly type: 'graph.node.create'; readonly payload: { readonly node: WorkflowNodeV2 } }
  | { readonly type: 'graph.node.delete'; readonly payload: { readonly nodeId: string } }
  | {
      readonly type: 'graph.node.update';
      readonly payload: {
        readonly nodeId: string;
        readonly label?: string;
        readonly config?: Readonly<Record<string, unknown>>;
      };
    }
  | {
      readonly type: 'graph.node.setStatus';
      /** Omitting `status` clears it — the inverse of setting one on a fresh node. */
      readonly payload: { readonly nodeId: string; readonly status?: WorkflowNodeStatus };
    }
  | {
      readonly type: 'graph.node.bindTime';
      readonly payload: { readonly nodeId: string; readonly binding?: TemporalBinding };
    }
  | {
      readonly type: 'graph.node.assignAgent';
      readonly payload: { readonly nodeId: string; readonly assignment?: AgentAssignmentV2 };
    }
  | {
      readonly type: 'graph.node.setUi';
      readonly payload: { readonly nodeId: string; readonly ui?: NodeUiStateV2 };
    }
  | { readonly type: 'graph.edge.connect'; readonly payload: { readonly edge: WorkflowEdgeV2 } }
  | { readonly type: 'graph.edge.disconnect'; readonly payload: { readonly edgeId: string } }
  /**
   * Inverse of a node deletion. Deleting a node also drops every edge touching
   * it, so a single-command inverse has to restore both — the same shape
   * `timeline.restoreTrackClips` uses to undo a compound timeline edit.
   */
  | {
      readonly type: 'graph.restoreNode';
      readonly payload: {
        readonly node: WorkflowNodeV2;
        readonly edges: readonly WorkflowEdgeV2[];
        /** The group the node was in, so undo puts it back where it was. */
        readonly groupId?: string;
      };
    }
  | { readonly type: 'graph.group.create'; readonly payload: { readonly group: WorkflowGroupV2 } }
  | { readonly type: 'graph.group.delete'; readonly payload: { readonly groupId: string } }
  | {
      readonly type: 'graph.group.setNodes';
      readonly payload: { readonly groupId: string; readonly nodeIds: readonly string[] };
    }
  | {
      readonly type: 'graph.group.setLabel';
      readonly payload: { readonly groupId: string; readonly label: string };
    };

export type WorkflowGraphCommandType = WorkflowGraphCommand['type'];

export const GRAPH_COMMAND_REGISTRY: Readonly<
  Record<WorkflowGraphCommandType, { readonly description: string }>
> = {
  'graph.node.create': { description: 'Add a node to the workflow graph.' },
  'graph.node.delete': { description: 'Remove a node and every edge touching it.' },
  'graph.node.update': { description: 'Change a node label or configuration.' },
  'graph.node.setStatus': { description: 'Set node execution status (including stale).' },
  'graph.node.bindTime': { description: 'Bind or unbind a node to a time range or item.' },
  'graph.node.assignAgent': { description: 'Assign or clear a specialist capability on a node.' },
  'graph.node.setUi': { description: 'Move or collapse a node. View state only.' },
  'graph.edge.connect': { description: 'Connect two type-compatible ports.' },
  'graph.edge.disconnect': { description: 'Remove an edge.' },
  'graph.restoreNode': { description: 'Restore a deleted node with its edges (undo).' },
  'graph.group.create': { description: 'Name a set of nodes as a group.' },
  'graph.group.delete': { description: 'Ungroup, leaving the nodes in place.' },
  'graph.group.setNodes': { description: 'Change which nodes a group contains.' },
  'graph.group.setLabel': { description: 'Rename a group.' },
};

export interface GraphApplyResult {
  readonly graph: WorkflowGraphV2;
  readonly inverse: WorkflowGraphCommand;
}

/**
 * Applies one command, returning the next graph and its inverse.
 *
 * The result is validated before it is returned, so a command can never leave
 * a cycle, a dangling edge, or an unknown capability in the document — the
 * check that makes an invalid graph unstorable rather than merely unexecutable.
 */
export function applyGraphCommand(
  graph: WorkflowGraphV2,
  command: WorkflowGraphCommand,
): GraphApplyResult {
  const result = applyGraphCommandUnchecked(graph, command);
  const diagnostics = validateWorkflowGraph(result.graph, 'workflow');
  if (diagnostics.length > 0) {
    const first = diagnostics[0]!;
    throw new GraphCommandError(
      'GRAPH_COMMAND_RESULT_INVALID',
      `${command.type} would produce an invalid graph: [${first.code}] ${first.message}`,
    );
  }
  return result;
}

function applyGraphCommandUnchecked(
  graph: WorkflowGraphV2,
  command: WorkflowGraphCommand,
): GraphApplyResult {
  switch (command.type) {
    case 'graph.node.create':
      return applyCreateNode(graph, command.payload.node);
    case 'graph.node.delete':
      return applyDeleteNode(graph, command.payload.nodeId);
    case 'graph.restoreNode':
      return applyRestoreNode(
        graph,
        command.payload.node,
        command.payload.edges,
        command.payload.groupId,
      );
    case 'graph.group.create':
      return applyCreateGroup(graph, command.payload.group);
    case 'graph.group.delete':
      return applyDeleteGroup(graph, command.payload.groupId);
    case 'graph.group.setNodes':
      return applyGroupPatch(
        graph,
        command.payload.groupId,
        (group) => ({ ...group, nodeIds: command.payload.nodeIds }),
        (previous) => ({
          type: 'graph.group.setNodes',
          payload: { groupId: previous.id, nodeIds: previous.nodeIds },
        }),
      );
    case 'graph.group.setLabel':
      return applyGroupPatch(
        graph,
        command.payload.groupId,
        (group) => ({ ...group, label: command.payload.label }),
        (previous) => ({
          type: 'graph.group.setLabel',
          payload: { groupId: previous.id, label: previous.label },
        }),
      );
    case 'graph.node.update':
      return applyUpdateNode(graph, command.payload);
    case 'graph.node.setStatus':
      return applyNodePatch(
        graph,
        command.payload.nodeId,
        (node) => withOptional(node, 'status', command.payload.status),
        // Restores "no status at all" rather than defaulting to idle: a node
        // that had never run must not come back from undo claiming it had.
        (previous) => ({
          type: 'graph.node.setStatus',
          payload: withOptional({ nodeId: previous.id }, 'status', previous.status),
        }),
      );
    case 'graph.node.bindTime':
      return applyNodePatch(
        graph,
        command.payload.nodeId,
        (node) => withOptional(node, 'binding', command.payload.binding),
        (previous) => ({
          type: 'graph.node.bindTime',
          payload: withOptional({ nodeId: previous.id }, 'binding', previous.binding),
        }),
      );
    case 'graph.node.assignAgent':
      return applyNodePatch(
        graph,
        command.payload.nodeId,
        (node) => withOptional(node, 'agentAssignment', command.payload.assignment),
        (previous) => ({
          type: 'graph.node.assignAgent',
          payload: withOptional({ nodeId: previous.id }, 'assignment', previous.agentAssignment),
        }),
      );
    case 'graph.node.setUi':
      return applyNodePatch(
        graph,
        command.payload.nodeId,
        (node) => withOptional(node, 'ui', command.payload.ui),
        (previous) => ({
          type: 'graph.node.setUi',
          payload: withOptional({ nodeId: previous.id }, 'ui', previous.ui),
        }),
      );
    case 'graph.edge.connect':
      return applyConnect(graph, command.payload.edge);
    case 'graph.edge.disconnect':
      return applyDisconnect(graph, command.payload.edgeId);
  }
}

function applyCreateNode(graph: WorkflowGraphV2, node: WorkflowNodeV2): GraphApplyResult {
  if (findNode(graph, node.id) !== undefined) {
    throw new GraphCommandError('GRAPH_NODE_EXISTS', `node "${node.id}" already exists`);
  }
  return {
    graph: { ...graph, nodes: [...graph.nodes, node] },
    inverse: { type: 'graph.node.delete', payload: { nodeId: node.id } },
  };
}

function applyDeleteNode(graph: WorkflowGraphV2, nodeId: string): GraphApplyResult {
  const node = requireNode(graph, nodeId);
  // Edges are captured before removal so the inverse can put them back. Leaving
  // them would strand edges pointing at a node that no longer exists, which the
  // graph validator rejects — deleting a node must take its edges with it.
  const detached = graph.edges.filter(
    (edge) => edge.fromNodeId === nodeId || edge.toNodeId === nodeId,
  );
  // Group membership goes the same way for the same reason: a group naming a
  // node that no longer exists is rejected by the validator.
  const owner = groupOf(graph, nodeId);
  return {
    graph: {
      ...graph,
      nodes: graph.nodes.filter((candidate) => candidate.id !== nodeId),
      edges: graph.edges.filter((edge) => !detached.includes(edge)),
      ...(graph.groups === undefined
        ? {}
        : {
            groups: graph.groups.map((group) => ({
              ...group,
              nodeIds: group.nodeIds.filter((candidate) => candidate !== nodeId),
            })),
          }),
    },
    inverse: {
      type: 'graph.restoreNode',
      payload: {
        node,
        edges: detached,
        ...(owner === undefined ? {} : { groupId: owner.id }),
      },
    },
  };
}

function applyRestoreNode(
  graph: WorkflowGraphV2,
  node: WorkflowNodeV2,
  edges: readonly WorkflowEdgeV2[],
  groupId: string | undefined,
): GraphApplyResult {
  if (findNode(graph, node.id) !== undefined) {
    throw new GraphCommandError('GRAPH_NODE_EXISTS', `node "${node.id}" already exists`);
  }
  // A group that has itself been removed since is simply not restored into;
  // undo is last-in-first-out, so in practice it is still there.
  const groups =
    groupId === undefined || graph.groups === undefined
      ? graph.groups
      : graph.groups.map((group) =>
          group.id === groupId ? { ...group, nodeIds: [...group.nodeIds, node.id] } : group,
        );
  return {
    graph: {
      ...graph,
      nodes: [...graph.nodes, node],
      edges: [...graph.edges, ...edges],
      ...(groups === undefined ? {} : { groups }),
    },
    inverse: { type: 'graph.node.delete', payload: { nodeId: node.id } },
  };
}

function applyCreateGroup(graph: WorkflowGraphV2, group: WorkflowGroupV2): GraphApplyResult {
  if ((graph.groups ?? []).some((candidate) => candidate.id === group.id)) {
    throw new GraphCommandError('GRAPH_GROUP_EXISTS', `group "${group.id}" already exists`);
  }
  return {
    graph: { ...graph, groups: [...(graph.groups ?? []), group] },
    inverse: { type: 'graph.group.delete', payload: { groupId: group.id } },
  };
}

function applyDeleteGroup(graph: WorkflowGraphV2, groupId: string): GraphApplyResult {
  const group = requireGroup(graph, groupId);
  return {
    graph: {
      ...graph,
      // Ungrouping keeps every node; a group is a name for a set, not a
      // container that owns what is inside it.
      groups: (graph.groups ?? []).filter((candidate) => candidate.id !== groupId),
    },
    inverse: { type: 'graph.group.create', payload: { group } },
  };
}

function applyGroupPatch(
  graph: WorkflowGraphV2,
  groupId: string,
  patch: (group: WorkflowGroupV2) => WorkflowGroupV2,
  invert: (previous: WorkflowGroupV2) => WorkflowGraphCommand,
): GraphApplyResult {
  const previous = requireGroup(graph, groupId);
  return {
    graph: {
      ...graph,
      groups: (graph.groups ?? []).map((candidate) =>
        candidate.id === groupId ? patch(previous) : candidate,
      ),
    },
    inverse: invert(previous),
  };
}

function groupOf(graph: WorkflowGraphV2, nodeId: string): WorkflowGroupV2 | undefined {
  return (graph.groups ?? []).find((group) => group.nodeIds.includes(nodeId));
}

function requireGroup(graph: WorkflowGraphV2, groupId: string): WorkflowGroupV2 {
  const group = (graph.groups ?? []).find((candidate) => candidate.id === groupId);
  if (group === undefined) {
    throw new GraphCommandError('GRAPH_GROUP_MISSING', `group "${groupId}" does not exist`);
  }
  return group;
}

function applyUpdateNode(
  graph: WorkflowGraphV2,
  payload: {
    readonly nodeId: string;
    readonly label?: string;
    readonly config?: Readonly<Record<string, unknown>>;
  },
): GraphApplyResult {
  const previous = requireNode(graph, payload.nodeId);
  const next: WorkflowNodeV2 = {
    ...previous,
    ...(payload.label === undefined ? {} : { label: payload.label }),
    ...(payload.config === undefined ? {} : { config: payload.config }),
  };
  return {
    graph: replaceNode(graph, next),
    // The inverse restores both fields regardless of which the command touched:
    // a partial inverse would silently keep the new value for the other one.
    inverse: {
      type: 'graph.node.update',
      payload: { nodeId: previous.id, label: previous.label, config: previous.config },
    },
  };
}

function applyNodePatch(
  graph: WorkflowGraphV2,
  nodeId: string,
  patch: (node: WorkflowNodeV2) => WorkflowNodeV2,
  invert: (previous: WorkflowNodeV2) => WorkflowGraphCommand,
): GraphApplyResult {
  const previous = requireNode(graph, nodeId);
  return { graph: replaceNode(graph, patch(previous)), inverse: invert(previous) };
}

function applyConnect(graph: WorkflowGraphV2, edge: WorkflowEdgeV2): GraphApplyResult {
  if (graph.edges.some((candidate) => candidate.id === edge.id)) {
    throw new GraphCommandError('GRAPH_EDGE_EXISTS', `edge "${edge.id}" already exists`);
  }
  const from = requireNode(graph, edge.fromNodeId);
  const to = requireNode(graph, edge.toNodeId);
  const fromPort = from.outputs.find((port) => port.id === edge.fromPortId);
  const toPort = to.inputs.find((port) => port.id === edge.toPortId);
  if (fromPort === undefined) {
    throw new GraphCommandError(
      'GRAPH_PORT_MISSING',
      `node "${from.id}" has no output port "${edge.fromPortId}"`,
    );
  }
  if (toPort === undefined) {
    throw new GraphCommandError(
      'GRAPH_PORT_MISSING',
      `node "${to.id}" has no input port "${edge.toPortId}"`,
    );
  }
  if (!arePortsCompatible(fromPort, toPort)) {
    throw new GraphCommandError(
      'GRAPH_PORT_TYPE_MISMATCH',
      `cannot connect ${fromPort.dataType} to ${toPort.dataType}: ` +
        `"${toPort.label}" accepts ${[toPort.dataType, ...(toPort.accepts ?? [])].join(', ')}`,
    );
  }
  // An input that is not `multiple` holds one upstream value; a second edge
  // would make which one it receives depend on edge ordering.
  if (
    toPort.multiple !== true &&
    graph.edges.some((c) => c.toNodeId === edge.toNodeId && c.toPortId === edge.toPortId)
  ) {
    throw new GraphCommandError(
      'GRAPH_PORT_OCCUPIED',
      `input "${toPort.label}" on "${to.id}" already has a connection and does not accept multiple`,
    );
  }
  return {
    graph: { ...graph, edges: [...graph.edges, edge] },
    inverse: { type: 'graph.edge.disconnect', payload: { edgeId: edge.id } },
  };
}

function applyDisconnect(graph: WorkflowGraphV2, edgeId: string): GraphApplyResult {
  const edge = graph.edges.find((candidate) => candidate.id === edgeId);
  if (edge === undefined) {
    throw new GraphCommandError('GRAPH_EDGE_MISSING', `edge "${edgeId}" does not exist`);
  }
  return {
    graph: { ...graph, edges: graph.edges.filter((candidate) => candidate.id !== edgeId) },
    inverse: { type: 'graph.edge.connect', payload: { edge } },
  };
}

function findNode(graph: WorkflowGraphV2, nodeId: string): WorkflowNodeV2 | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}

function requireNode(graph: WorkflowGraphV2, nodeId: string): WorkflowNodeV2 {
  const node = findNode(graph, nodeId);
  if (node === undefined) {
    throw new GraphCommandError('GRAPH_NODE_MISSING', `node "${nodeId}" does not exist`);
  }
  return node;
}

function replaceNode(graph: WorkflowGraphV2, node: WorkflowNodeV2): WorkflowGraphV2 {
  return {
    ...graph,
    nodes: graph.nodes.map((candidate) => (candidate.id === node.id ? node : candidate)),
  };
}

/**
 * Sets an optional field, or removes it when the value is undefined.
 *
 * Assigning `undefined` would leave the key present, and `exactOptionalPropertyTypes`
 * treats "absent" and "present but undefined" as different — which matters here
 * because an unbound node must round trip as having no `binding` at all.
 */
function withOptional<T extends object, K extends string, V>(
  target: T,
  key: K,
  value: V | undefined,
): T & { readonly [P in K]?: V } {
  const { [key as unknown as keyof T]: _removed, ...rest } = target;
  void _removed;
  return (value === undefined ? rest : { ...rest, [key]: value }) as T & {
    readonly [P in K]?: V;
  };
}
