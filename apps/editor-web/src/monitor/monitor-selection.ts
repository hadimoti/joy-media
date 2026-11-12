import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import {
  flattenRenderNodes,
  type EditorOverlayIR,
  type NodeBounds,
  type RenderFrameIR,
} from '@joy-media/render-ir';
import { renderNodeIdToClipId } from './monitor-ids.js';
import { hitTestElements, marqueeSelect, type HitTestElement } from './monitor-hit-test.js';

/**
 * Monitor selection (ADR-0046 section 4, T-M04). The Monitor keeps no
 * selection of its own: it reads the timeline's `state.selectedIds` (clip
 * ids) and writes through `selectClips`, `toggleSelection` and
 * `clearSelection`. Drawn node ids become clip ids only through
 * `renderNodeIdToClipId` (monitor-ids.ts); clip ids go back to the drawn nodes
 * through the same pairing kept on each element, so there is one converter
 * each way and the Monitor never guesses.
 */

/** A drawn element the Monitor can select: its node, its box and its clip. */
export interface MonitorElement extends HitTestElement {
  /** The timeline clip the selection holds for this node. */
  readonly clipId: string;
  /** The full drawn box from the renderer. */
  readonly bounds: NodeBounds;
}

export interface MonitorElementsInput {
  /** The frame the Monitor drew last. */
  readonly frame: RenderFrameIR;
  /** The renderer's `nodeBounds(id)` for that frame. */
  readonly nodeBounds: (id: string) => NodeBounds | undefined;
  /** The visual project that was drawn (the staged preview while one is on screen). */
  readonly project: JoyProjectV1;
  /** The timeline (clip ids, tracks, lock and visibility). */
  readonly timeline: SpikeProject;
}

interface TrackFlags {
  readonly locked: boolean;
  readonly hidden: boolean;
}

function clipTrackFlags(timeline: SpikeProject): ReadonlyMap<string, TrackFlags> {
  const flags = new Map<string, TrackFlags>();
  const root = timeline.compositions[timeline.rootCompositionId];
  for (const track of root?.tracks ?? []) {
    const trackFlags = { locked: track.locked === true, hidden: track.enabled === false };
    for (const clip of track.clips) flags.set(clip.id, trackFlags);
  }
  return flags;
}

/**
 * The elements of the drawn frame, topmost first (the renderer's draw order
 * reversed: higher `zIndex` on top, then later in the list). A node the
 * renderer did not draw (no bounds, e.g. a transition) or that maps to no
 * timeline clip is left out. Video, pictures, text, captions, shapes and the
 * 3D element all come through here, because each is a drawn node with bounds.
 */
export function buildMonitorElements(input: MonitorElementsInput): readonly MonitorElement[] {
  const tracks = clipTrackFlags(input.timeline);
  const clipIds = new Set(tracks.keys());
  const ordered = flattenRenderNodes(input.frame.nodes)
    .map((node, index) => ({ node, index }))
    .sort((a, b) => b.node.zIndex - a.node.zIndex || b.index - a.index);
  const elements: MonitorElement[] = [];
  for (const { node } of ordered) {
    if (node.kind === 'transition') continue;
    const bounds = input.nodeBounds(node.id);
    if (bounds === undefined) continue;
    const clipId = renderNodeIdToClipId(input.project, node.id, clipIds);
    if (clipId === undefined) continue;
    const flags = tracks.get(clipId);
    elements.push({
      id: node.id,
      clipId,
      bounds,
      ...(flags?.locked === true ? { locked: true } : {}),
      ...(flags?.hidden === true ? { hidden: true } : {}),
    });
  }
  return elements;
}

/** Node ids to their clip ids, first seen first, each clip once. */
export function clipIdsForNodeIds(
  elements: readonly MonitorElement[],
  nodeIds: readonly string[],
): readonly string[] {
  const byNode = new Map(elements.map((element) => [element.id, element.clipId]));
  const result: string[] = [];
  for (const nodeId of nodeIds) {
    const clipId = byNode.get(nodeId);
    if (clipId !== undefined && !result.includes(clipId)) result.push(clipId);
  }
  return result;
}

/** The clips under a canvas point, topmost first, each clip once. */
export function monitorHitClipIds(
  canvasPoint: { x: number; y: number },
  elements: readonly MonitorElement[],
): readonly string[] {
  return clipIdsForNodeIds(elements, hitTestElements(canvasPoint, elements));
}

/** The clips a marquee touches, topmost first, each clip once. */
export function monitorMarqueeClipIds(
  start: { x: number; y: number },
  end: { x: number; y: number },
  elements: readonly MonitorElement[],
): readonly string[] {
  return clipIdsForNodeIds(elements, marqueeSelect(start, end, elements));
}

export type MonitorSelectionAction =
  | { readonly kind: 'select'; readonly clipIds: readonly string[] }
  | { readonly kind: 'toggle'; readonly clipId: string }
  | { readonly kind: 'clear' }
  | { readonly kind: 'none' };

export interface MonitorClickModifiers {
  readonly shift: boolean;
  readonly alt: boolean;
}

/**
 * What a plain click (press and release without a drag) does:
 * - on nothing: deselect (Shift keeps the selection);
 * - plain: select the topmost;
 * - Alt: select the next one below the selected one under the pointer
 *   (below the topmost when none is selected; after the bottom one it goes
 *   back to the top);
 * - Shift: add or remove the topmost (with Alt: the Alt choice).
 */
export function monitorClickAction(
  hitClipIds: readonly string[],
  selectedIds: readonly string[],
  modifiers: MonitorClickModifiers,
): MonitorSelectionAction {
  if (hitClipIds.length === 0) return modifiers.shift ? { kind: 'none' } : { kind: 'clear' };
  let target = hitClipIds[0]!;
  if (modifiers.alt) {
    const selectedIndex = hitClipIds.findIndex((clipId) => selectedIds.includes(clipId));
    const nextIndex = selectedIndex < 0 ? 1 : selectedIndex + 1;
    target = hitClipIds[nextIndex % hitClipIds.length]!;
  }
  if (modifiers.shift) return { kind: 'toggle', clipId: target };
  return { kind: 'select', clipIds: [target] };
}

/**
 * What a marquee drag on empty canvas does (Shift adds to the selection).
 * A marquee that touches nothing keeps the selection, with or without Shift:
 * only a plain click-and-release on empty canvas deselects
 * (`monitorClickAction`).
 */
export function monitorMarqueeAction(
  marqueeClipIds: readonly string[],
  selectedIds: readonly string[],
  shift: boolean,
): MonitorSelectionAction {
  if (marqueeClipIds.length === 0) return { kind: 'none' };
  if (!shift) return { kind: 'select', clipIds: marqueeClipIds };
  const added = marqueeClipIds.filter((clipId) => !selectedIds.includes(clipId));
  return added.length === 0
    ? { kind: 'none' }
    : { kind: 'select', clipIds: [...selectedIds, ...added] };
}

/** The shared selection setters of the editor (`EditorPanelContextValue`). */
export interface MonitorSelectionSetters {
  readonly selectClips: (clipIds: readonly string[]) => void;
  readonly toggleSelection: (id: string) => void;
  readonly clearSelection: () => void;
}

/** Writes an action through the shared selection, the only place it is kept. */
export function applyMonitorSelection(
  action: MonitorSelectionAction,
  setters: MonitorSelectionSetters,
): void {
  if (action.kind === 'select') setters.selectClips(action.clipIds);
  else if (action.kind === 'toggle') setters.toggleSelection(action.clipId);
  else if (action.kind === 'clear') setters.clearSelection();
}

/**
 * The editor overlay for the selection (the timeline's selection shown on the
 * Monitor): one outline per drawn node of a selected clip. Hidden tracks are
 * not outlined (nothing is drawn there). The overlay is editor-only: it is
 * drawn above the canvas in HTML, never into the frame, the export or
 * `readPixels`.
 */
export function monitorSelectionOverlay(
  elements: readonly MonitorElement[],
  selectedIds: readonly string[],
): EditorOverlayIR {
  const selected = new Set(selectedIds);
  return {
    version: 1,
    selections: elements
      .filter((element) => selected.has(element.clipId) && element.hidden !== true)
      .map((element) => ({
        nodeId: element.id,
        x: element.bounds.aabb.x,
        y: element.bounds.aabb.y,
        width: element.bounds.aabb.width,
        height: element.bounds.aabb.height,
        corners: element.bounds.corners,
      })),
  };
}

export const EMPTY_MONITOR_OVERLAY: EditorOverlayIR = { version: 1, selections: [] };

/** True when two overlays draw the same outlines (avoids needless re-renders). */
export function sameMonitorOverlay(a: EditorOverlayIR, b: EditorOverlayIR): boolean {
  if (a.selections.length !== b.selections.length) return false;
  return a.selections.every((selection, index) => {
    const other = b.selections[index]!;
    if (selection.nodeId !== other.nodeId) return false;
    const corners = selection.corners ?? [];
    const otherCorners = other.corners ?? [];
    return (
      selection.x === other.x &&
      selection.y === other.y &&
      selection.width === other.width &&
      selection.height === other.height &&
      corners.length === otherCorners.length &&
      corners.every(
        (corner, i) => corner.x === otherCorners[i]!.x && corner.y === otherCorners[i]!.y,
      )
    );
  });
}
