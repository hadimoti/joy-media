/**
 * Keyboard movement through the Flow graph (§12.5).
 *
 * Tab already reaches every node, because each one is a button. What was
 * missing is movement *along the connections* — the thing the graph is for. A
 * screen-reader or keyboard user could enumerate the nodes and never learn
 * which fed which.
 *
 * So left and right follow edges, and up and down move within a column. Columns
 * are where parallel branches land, so a fork is reachable: right onto the first
 * branch, down onto its sibling. Nothing here selects or changes anything —
 * traversal moves focus only, and Enter still does the selecting.
 *
 * Pure and DOM-free so the rules can be tested as rules.
 */

export interface TraversalNode {
  readonly id: string;
}

export interface TraversalEdge {
  readonly from: string;
  readonly to: string;
}

export interface TraversalGraph {
  readonly nodes: readonly TraversalNode[];
  readonly edges: readonly TraversalEdge[];
  readonly positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
}

export type TraversalKey = 'ArrowRight' | 'ArrowLeft' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

const TRAVERSAL_KEYS = new Set<string>([
  'ArrowRight',
  'ArrowLeft',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
]);

export function isTraversalKey(key: string): key is TraversalKey {
  return TRAVERSAL_KEYS.has(key);
}

/**
 * The node focus should move to, or `undefined` when the move has nowhere to
 * go — a leaf pressed right, a column of one pressed down. Returning
 * `undefined` rather than wrapping around keeps the position honest: focus
 * staying put says "this is the end of the chain", where a wrap would claim a
 * connection that does not exist.
 */
export function traverseGraph(
  graph: TraversalGraph,
  fromId: string,
  key: TraversalKey,
): string | undefined {
  const ordered = layoutOrder(graph);
  if (key === 'Home') return ordered[0]?.id;
  if (key === 'End') return ordered[ordered.length - 1]?.id;

  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    // Edge declaration order decides, so the same graph always traverses the
    // same way rather than depending on map iteration.
    const neighbours = graph.edges
      .filter((edge) => (key === 'ArrowRight' ? edge.from === fromId : edge.to === fromId))
      .map((edge) => (key === 'ArrowRight' ? edge.to : edge.from))
      .filter((id) => graph.positions.has(id));
    return neighbours[0];
  }

  const origin = graph.positions.get(fromId);
  if (origin === undefined) return undefined;
  const column = ordered.filter((node) => graph.positions.get(node.id)?.x === origin.x);
  const index = column.findIndex((node) => node.id === fromId);
  if (index === -1) return undefined;
  return column[key === 'ArrowDown' ? index + 1 : index - 1]?.id;
}

/** Left to right, then top to bottom; id breaks a tie so the order is total. */
function layoutOrder(graph: TraversalGraph): readonly TraversalNode[] {
  return [...graph.nodes]
    .filter((node) => graph.positions.has(node.id))
    .sort((left, right) => {
      const a = graph.positions.get(left.id)!;
      const b = graph.positions.get(right.id)!;
      return a.x - b.x || a.y - b.y || left.id.localeCompare(right.id);
    });
}
