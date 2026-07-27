/**
 * The bridge between the editor's timeline selection and the Flow projection.
 *
 * ADR-0022 makes Flow a projection of the same session state the timeline
 * reads, but a projection is only half of "one document, two lenses": the user
 * also has to be able to cross between them. Selecting a clip has to light up
 * its node, selecting a node has to select its clips, and `Reveal in Flow` /
 * `Reveal on Timeline` have to resolve to the right target in the other view.
 *
 * All of that is pure graph work over `DualLensProjection`, so it lives here
 * rather than inside either panel — neither view owns the correspondence, and
 * keeping it out of the components is what lets it be tested without a DOM.
 *
 * Nothing in this module mutates the project. Reveal changes what is on screen
 * and what is selected; it never dispatches a command.
 */

import type { DualLensNode, DualLensProjection } from './dual-lens-model.js';

export type LensMode = 'time' | 'flow' | 'split';

/**
 * A one-shot request from elsewhere in the app ("reveal this clip in Flow").
 * `token` exists because the same clip may be revealed twice in a row, and the
 * panel needs to react the second time too.
 */
export interface LensRevealRequest {
  readonly mode: LensMode;
  readonly nodeId?: string;
  readonly token: number;
}

export interface ProvenanceStep {
  readonly nodeId: string;
  readonly label: string;
  readonly kind: DualLensNode['kind'];
}

/** Nodes standing for any of `clipIds`, in projection order. */
export function graphNodeIdsForClips(
  projection: DualLensProjection,
  clipIds: readonly string[],
): readonly string[] {
  if (clipIds.length === 0) return [];
  const wanted = new Set(clipIds);
  return projection.nodes
    .filter((node) => node.clipIds.some((clipId) => wanted.has(clipId)))
    .map((node) => node.id);
}

/**
 * The clip node for a selection, preferred over the asset or visual nodes that
 * also carry the binding. `Reveal in Flow` wants the item the user pointed at,
 * not every node that mentions it.
 */
export function primaryNodeIdForClip(
  projection: DualLensProjection,
  clipId: string,
): string | undefined {
  const bound = projection.nodes.filter((node) => node.clipIds.includes(clipId));
  return (bound.find((node) => node.kind === 'clip') ?? bound[0])?.id;
}

/** Timeline clips a graph node stands for. Empty for unplaced data and agents. */
export function timelineClipIdsForNode(
  projection: DualLensProjection,
  nodeId: string,
): readonly string[] {
  return projection.nodes.find((node) => node.id === nodeId)?.clipIds ?? [];
}

/**
 * The causal chain through a clip, from its furthest source to Program Output.
 *
 * Ordered by dependency depth rather than the node's display column: a provider
 * and the asset it generated share a column, but the provider must read first
 * or the ribbon claims the wrong causality.
 */
export function provenanceRibbon(
  projection: DualLensProjection,
  clipId: string,
): readonly ProvenanceStep[] {
  const origin = primaryNodeIdForClip(projection, clipId);
  if (origin === undefined) return [];

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of projection.edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }

  const chain = new Set<string>([origin]);
  collect(origin, incoming, chain);
  collect(origin, outgoing, chain);

  const depth = new Map<string, number>();
  const depthOf = (nodeId: string, seen: ReadonlySet<string>): number => {
    const cached = depth.get(nodeId);
    if (cached !== undefined) return cached;
    // A cycle would be a bug upstream, but guard anyway so a malformed
    // projection degrades to a flat ribbon instead of hanging the panel.
    if (seen.has(nodeId)) return 0;
    const parents = (incoming.get(nodeId) ?? []).filter((from) => chain.has(from));
    const value =
      parents.length === 0
        ? 0
        : 1 + Math.max(...parents.map((from) => depthOf(from, new Set([...seen, nodeId]))));
    depth.set(nodeId, value);
    return value;
  };

  return projection.nodes
    .filter((node) => chain.has(node.id))
    .map((node) => ({ node, depth: depthOf(node.id, new Set()) }))
    .sort((left, right) => left.depth - right.depth)
    .map(({ node }) => ({ nodeId: node.id, label: node.label, kind: node.kind }));
}

/** Renders a ribbon for the trace strip above the timeline. */
export function formatProvenanceRibbon(steps: readonly ProvenanceStep[]): string {
  return steps.map((step) => step.label).join(' → ');
}

function collect(
  from: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  into: Set<string>,
): void {
  for (const next of adjacency.get(from) ?? []) {
    if (into.has(next)) continue;
    into.add(next);
    collect(next, adjacency, into);
  }
}
