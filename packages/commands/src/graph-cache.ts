/**
 * Node cache keys and downstream invalidation.
 *
 * A cache key answers "has this node's meaning changed?" and is computed from
 * node type, version, normalized config, and the keys of everything upstream —
 * so a change anywhere in a node's ancestry changes its key, and an unrelated
 * branch keeps its cached result (plan §7.6).
 *
 * Invalidation returns **commands** rather than a mutated graph. Marking nodes
 * stale is a project mutation like any other, and letting it write directly
 * would be a back door around the command bus: it would not undo, would not
 * appear in history, and would not be visible to a dry run.
 */

import type { WorkflowGraphV2, WorkflowNodeV2 } from '@joy-media/project-schema';
import type { WorkflowGraphCommand } from './graph-commands.js';

/**
 * Config is serialized with sorted keys so that two configs differing only in
 * property order produce the same key. Without this, re-saving a project could
 * invalidate every cached node for no reason.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

/**
 * A small non-cryptographic digest. Cache keys only need to differ when inputs
 * differ; they are never a security or integrity boundary, and the package has
 * no hashing dependency.
 */
function digest(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code + index, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * Cache key for one node, including its whole upstream closure.
 *
 * `ui` is deliberately excluded: moving a node on the canvas must never
 * invalidate its cached result. That is the same separation ADR-0023 draws
 * between view state and creative meaning, enforced here where it would
 * otherwise cost real recomputation.
 */
export function computeNodeCacheKey(graph: WorkflowGraphV2, nodeId: string): string {
  return computeKeyWithSeen(graph, nodeId, new Set());
}

function computeKeyWithSeen(
  graph: WorkflowGraphV2,
  nodeId: string,
  seen: Set<string>,
): string {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) return digest(`missing:${nodeId}`);
  // The document validator rejects cycles, but a caller may hold a graph mid
  // edit; degrade to a stable marker rather than recursing forever.
  if (seen.has(nodeId)) return digest(`cycle:${nodeId}`);
  const nextSeen = new Set([...seen, nodeId]);

  const upstream = graph.edges
    .filter((edge) => edge.toNodeId === nodeId)
    .map((edge) => `${edge.toPortId}<-${computeKeyWithSeen(graph, edge.fromNodeId, nextSeen)}`)
    .sort();

  return digest(
    [
      node.type,
      String(node.schemaVersion),
      stableStringify(node.config),
      stableStringify(node.binding ?? null),
      stableStringify(node.agentAssignment ?? null),
      ...upstream,
    ].join('|'),
  );
}

/** Every node reachable downstream of `nodeId`, excluding the node itself. */
export function downstreamNodeIds(graph: WorkflowGraphV2, nodeId: string): readonly string[] {
  const found = new Set<string>();
  const walk = (current: string): void => {
    for (const edge of graph.edges) {
      if (edge.fromNodeId !== current || found.has(edge.toNodeId)) continue;
      found.add(edge.toNodeId);
      walk(edge.toNodeId);
    }
  };
  walk(nodeId);
  return [...found];
}

export interface InvalidationOptions {
  /**
   * Pinned node ids whose results must survive. Re-running must not silently
   * overwrite a version the user deliberately kept (plan §7.6, §19.14).
   */
  readonly pinnedNodeIds?: readonly string[];
}

/**
 * Commands that mark everything downstream of a changed node stale.
 *
 * Returns only the nodes whose status actually changes, so an already-stale
 * branch does not produce a no-op transaction that still lands on the undo
 * stack as a user-visible entry.
 */
export function invalidateDownstream(
  graph: WorkflowGraphV2,
  changedNodeId: string,
  options: InvalidationOptions = {},
): readonly WorkflowGraphCommand[] {
  const pinned = new Set(options.pinnedNodeIds ?? []);
  return downstreamNodeIds(graph, changedNodeId)
    .filter((id) => !pinned.has(id))
    .map((id) => graph.nodes.find((node) => node.id === id))
    .filter((node): node is WorkflowNodeV2 => node !== undefined && node.status !== 'stale')
    .map((node) => ({
      type: 'graph.node.setStatus' as const,
      payload: { nodeId: node.id, status: 'stale' as const },
    }));
}

export interface StalenessReport {
  readonly nodeId: string;
  readonly cacheKey: string;
  readonly stale: boolean;
}

/**
 * Compares live cache keys against the keys a previous run recorded.
 *
 * A node with no recorded key is stale: never having run is not the same as
 * being up to date, and treating it as fresh would skip it forever.
 */
export function reportStaleness(
  graph: WorkflowGraphV2,
  recordedKeys: Readonly<Record<string, string>>,
): readonly StalenessReport[] {
  return graph.nodes.map((node) => {
    const cacheKey = computeNodeCacheKey(graph, node.id);
    return { nodeId: node.id, cacheKey, stale: recordedKeys[node.id] !== cacheKey };
  });
}
