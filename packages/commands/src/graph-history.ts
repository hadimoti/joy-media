/**
 * Graph transactions and dry-run.
 *
 * There is intentionally **no** `WorkflowGraphHistory` class here. The plan's
 * non-goals forbid a second undo/redo system, and a graph-only stack would be
 * exactly that: undoing a graph edit would not interleave correctly with the
 * timeline edit the user made a moment earlier, so "one Undo = one thing I
 * did" would stop being true the moment they used both lenses.
 *
 * Instead this mirrors `applyTransaction`: it returns the next graph plus
 * inverses already in application order, and the editor's single history holds
 * the record alongside timeline, audio, and document records.
 */

import type { WorkflowGraphV2 } from '@joy-media/project-schema';
import type { WorkflowGraphCommand } from './graph-commands.js';
import { applyGraphCommand, GraphCommandError } from './graph-commands.js';

export interface GraphTransaction {
  readonly label: string;
  readonly commands: readonly WorkflowGraphCommand[];
  /** Continuous interactions with the same key collapse into one undo entry. */
  readonly coalesceKey?: string;
}

export interface GraphTransactionRecord {
  readonly label: string;
  readonly commands: readonly WorkflowGraphCommand[];
  /** Inverses in application order for undo (i.e. already reversed). */
  readonly inverses: readonly WorkflowGraphCommand[];
  readonly coalesceKey?: string;
}

export interface GraphTransactionResult {
  readonly graph: WorkflowGraphV2;
  readonly record: GraphTransactionRecord;
}

/**
 * Applies all commands atomically.
 *
 * Throws on any failure, leaving the input untouched — the graph is immutable,
 * so a half-applied transaction is simply an intermediate value nobody keeps.
 */
export function applyGraphTransaction(
  graph: WorkflowGraphV2,
  transaction: GraphTransaction,
): GraphTransactionResult {
  if (transaction.commands.length === 0) {
    throw new GraphCommandError(
      'GRAPH_VALIDATION_EMPTY_TRANSACTION',
      'a transaction needs commands',
    );
  }
  let current = graph;
  const inverses: WorkflowGraphCommand[] = [];
  for (const command of transaction.commands) {
    const result = applyGraphCommand(current, command);
    current = result.graph;
    inverses.unshift(result.inverse);
  }
  return {
    graph: current,
    record: {
      label: transaction.label,
      commands: [...transaction.commands],
      inverses,
      ...(transaction.coalesceKey === undefined ? {} : { coalesceKey: transaction.coalesceKey }),
    },
  };
}

/** Applies a record's inverses. The undo half of the pair above. */
export function revertGraphTransaction(
  graph: WorkflowGraphV2,
  record: GraphTransactionRecord,
): WorkflowGraphV2 {
  let current = graph;
  for (const inverse of record.inverses) {
    current = applyGraphCommand(current, inverse).graph;
  }
  return current;
}

export interface GraphChangeSummary {
  readonly nodesAdded: readonly string[];
  readonly nodesRemoved: readonly string[];
  readonly nodesChanged: readonly string[];
  readonly edgesAdded: readonly string[];
  readonly edgesRemoved: readonly string[];
}

export interface GraphDryRun {
  readonly ok: boolean;
  /** The graph the transaction would produce. Present only when `ok`. */
  readonly preview?: WorkflowGraphV2;
  readonly summary: GraphChangeSummary;
  readonly errors: readonly string[];
}

/**
 * Runs a transaction against a scratch copy and reports what it would change.
 *
 * The summary is diffed from the real applied result rather than predicted from
 * the command list, so a command with a knock-on effect — deleting a node takes
 * its edges with it — is reported truthfully instead of as the one change the
 * user asked for.
 */
export function dryRunGraphTransaction(
  graph: WorkflowGraphV2,
  transaction: GraphTransaction,
): GraphDryRun {
  let preview: WorkflowGraphV2;
  try {
    preview = applyGraphTransaction(graph, transaction).graph;
  } catch (error) {
    return {
      ok: false,
      summary: emptySummary(),
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
  return { ok: true, preview, summary: diffGraphs(graph, preview), errors: [] };
}

export function diffGraphs(before: WorkflowGraphV2, after: WorkflowGraphV2): GraphChangeSummary {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Set(before.edges.map((edge) => edge.id));
  const afterEdges = new Set(after.edges.map((edge) => edge.id));

  return {
    nodesAdded: [...afterNodes.keys()].filter((id) => !beforeNodes.has(id)),
    nodesRemoved: [...beforeNodes.keys()].filter((id) => !afterNodes.has(id)),
    nodesChanged: [...afterNodes.keys()].filter((id) => {
      const previous = beforeNodes.get(id);
      return previous !== undefined && previous !== afterNodes.get(id);
    }),
    edgesAdded: [...afterEdges].filter((id) => !beforeEdges.has(id)),
    edgesRemoved: [...beforeEdges].filter((id) => !afterEdges.has(id)),
  };
}

function emptySummary(): GraphChangeSummary {
  return {
    nodesAdded: [],
    nodesRemoved: [],
    nodesChanged: [],
    edgesAdded: [],
    edgesRemoved: [],
  };
}
