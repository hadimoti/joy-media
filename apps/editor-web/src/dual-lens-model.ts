import type { Clip, JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import type { HistoryEntry } from './editor-session.js';
import { polishMediaLabel } from './media-label.js';
import { readClipObjectMap } from './sticker-bindings.js';
import {
  timelineTrackCode,
  timelineTrackDisplayName,
  timelineTrackKind,
} from './timeline-track-kind.js';
import { formatTime } from './format-time.js';
import { timelineEffectiveDurationUs } from './timeline-layout.js';
import {
  readTimelineElementKindMap,
  timelineElementKindForClip,
  type TimelineElementKind,
} from './timeline-element-kind.js';

export { formatTime } from './format-time.js';

export type DualLensNodeKind =
  'provider' | 'asset' | 'clip' | 'visual' | 'data' | 'agent' | 'output';

export interface DualLensNode {
  readonly id: string;
  readonly kind: DualLensNodeKind;
  readonly label: string;
  readonly detail: string;
  readonly column: number;
  readonly startUs?: number;
  readonly endUs?: number;
  /**
   * Timeline clips this node stands for. Reveal and selection sync read this
   * rather than parsing node ids, so the `kind:value` id format stays a display
   * detail instead of becoming a contract two more modules depend on.
   */
  readonly clipIds: readonly string[];
}

export interface DualLensEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label?: string;
}

export interface DualLensLaneItem {
  readonly id: string;
  readonly label: string;
  readonly startUs?: number;
  readonly endUs?: number;
  /** Set on track lanes, so clicking the item can select rather than seek. */
  readonly clipId?: string;
  /** Glyph shown left of the polished label in Time View. */
  readonly icon?: DualLensItemIcon;
  /** Shared Classic/Time View presentation for placed timeline elements. */
  readonly elementKind?: TimelineElementKind;
}

export type DualLensItemIcon =
  TimelineElementKind | 'caption' | 'script' | 'prompt' | 'generation' | 'agent' | 'generic';

export interface DualLensLane {
  readonly id: string;
  readonly label: string;
  readonly advanced: boolean;
  readonly items: readonly DualLensLaneItem[];
  /** Polished gutter chrome (kind icon + V1 / Main Video). Falls back to `label`. */
  readonly header?: {
    readonly kind: DualLensItemIcon;
    readonly code: string;
    readonly name: string;
  };
  /** Composition track id for lock/mute/solo — only on core timeline lanes. */
  readonly sourceTrackId?: string;
  /** Seed for mute when track flags have not been toggled yet. */
  readonly trackEnabled?: boolean;
}

export interface DualLensProjection {
  readonly durationUs: number;
  readonly nodes: readonly DualLensNode[];
  readonly edges: readonly DualLensEdge[];
  readonly lanes: readonly DualLensLane[];
  readonly traceNodeIds: ReadonlySet<string>;
  readonly traceEdgeIds: ReadonlySet<string>;
  readonly traceSummary: string;
}

interface TimelineClipProjection {
  readonly trackId: string;
  readonly trackName: string;
  readonly clip: Clip;
}

export function buildDualLensProjection(
  timeline: SpikeProject,
  creative: JoyProjectV1,
  playheadUs: number,
  history: readonly HistoryEntry[],
): DualLensProjection {
  const composition = timeline.compositions[timeline.rootCompositionId];
  const durationUs = composition === undefined ? 0 : timelineEffectiveDurationUs(composition);
  const clips: readonly TimelineClipProjection[] =
    composition?.tracks.flatMap((track) =>
      track.clips.map((clip) => ({
        trackId: track.id,
        trackName: `Video ${track.order + 1}`,
        clip,
      })),
    ) ?? [];
  const objectBindings = readClipObjectMap(creative);
  const nodes: DualLensNode[] = [];
  const edges: DualLensEdge[] = [];
  const nodeIds = new Set<string>();
  // An asset or provider is reached once per clip that uses it, so bindings
  // accumulate across visits while the node itself is only added on the first.
  const clipBindings = new Map<string, Set<string>>();

  const addNode = (node: Omit<DualLensNode, 'clipIds'>, boundClipId?: string) => {
    if (boundClipId !== undefined) {
      const bound = clipBindings.get(node.id) ?? new Set<string>();
      bound.add(boundClipId);
      clipBindings.set(node.id, bound);
    }
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push({ ...node, clipIds: [] });
  };
  const addEdge = (from: string, to: string, label?: string) => {
    const id = `${from}->${to}`;
    if (edges.some((edge) => edge.id === id)) return;
    edges.push({ id, from, to, ...(label === undefined ? {} : { label }) });
  };

  const outputId = 'output:program';
  addNode({
    id: outputId,
    kind: 'output',
    label: 'Program Output',
    detail: `${creative.title} · ${composition?.width ?? 0}×${composition?.height ?? 0}`,
    column: 3,
  });

  for (const { trackName, clip } of clips) {
    const clipId = `clip:${clip.id}`;
    const endUs = clip.startUs + clip.durationUs;
    addNode(
      {
        id: clipId,
        kind: 'clip',
        label: polishMediaLabel(clip.id),
        detail: `${trackName} · ${formatSeconds(clip.durationUs)}`,
        column: 1,
        startUs: clip.startUs,
        endUs,
      },
      clip.id,
    );
    if (clip.kind === 'video') {
      const assetId = `asset:${clip.assetId}`;
      const asset = creative.assets[clip.assetId];
      addNode(
        {
          id: assetId,
          kind: 'asset',
          label: polishMediaLabel(asset?.displayName ?? clip.assetId),
          detail: asset?.kind ?? 'video source',
          column: 0,
        },
        clip.id,
      );
      addEdge(assetId, clipId, 'source');
      const provenance = asset?.generationProvenance;
      if (provenance !== undefined) {
        const providerId = `provider:${provenance.providerId}:${provenance.modelId}`;
        addNode(
          {
            id: providerId,
            kind: 'provider',
            label: polishMediaLabel(provenance.modelId),
            detail: `${provenance.providerId} · ${provenance.modelVersion}`,
            column: 0,
          },
          clip.id,
        );
        addEdge(providerId, assetId, 'generated');
      }
    }
    const objectId = objectBindings[clip.id];
    const object = objectId === undefined ? undefined : creative.visualObjects[objectId];
    if (object !== undefined) {
      const visualId = `visual:${object.id}`;
      addNode(
        {
          id: visualId,
          kind: 'visual',
          label: polishMediaLabel(object.kind === 'text' ? (object.text ?? object.id) : object.id),
          detail: `${object.kind} layer`,
          column: 2,
          startUs: clip.startUs,
          endUs,
        },
        clip.id,
      );
      addEdge(clipId, visualId, 'drives');
      addEdge(visualId, outputId, 'composite');
    } else {
      addEdge(clipId, outputId, 'composite');
    }
  }

  for (const document of Object.values(creative.captionDocuments)) {
    const nodeId = `data:captions:${document.id}`;
    const placements = findCaptionPlacements(creative, document.id);
    const placement = placements[0];
    addNode({
      id: nodeId,
      kind: 'data',
      label: polishMediaLabel(`${document.language} captions`),
      detail: `${Object.keys(document.words).length} words`,
      column: 2,
      ...(placement === undefined ? {} : { startUs: placement.startUs, endUs: placement.endUs }),
    });
    addEdge(nodeId, outputId, 'burn-in');
  }

  const agentEntries = history.filter((entry) => /agent/i.test(entry.label));
  if (agentEntries.length > 0) {
    const agentId = 'agent:kilocode';
    addNode({
      id: agentId,
      kind: 'agent',
      label: 'KiloCode',
      detail: `${agentEntries.length} committed change set(s)`,
      column: 0,
    });
    addEdge(agentId, outputId, 'change sets');
  }

  const resolvedNodes: readonly DualLensNode[] = nodes.map((node) => ({
    ...node,
    clipIds: [...(clipBindings.get(node.id) ?? [])],
  }));

  const lanes = buildLanes(timeline, creative, history, clips);
  const traceNodeIds = new Set<string>();
  for (const node of resolvedNodes) {
    if (
      node.startUs !== undefined &&
      node.endUs !== undefined &&
      playheadUs >= node.startUs &&
      playheadUs < node.endUs
    ) {
      traceNodeIds.add(node.id);
    }
  }
  // Walk upstream only from timed nodes that are active at this frame. Starting
  // at Program Output would pull in every source connected to the final mix and
  // turn a frame trace into a whole-document dependency graph.
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (edge.to !== outputId && traceNodeIds.has(edge.to) && !traceNodeIds.has(edge.from)) {
        traceNodeIds.add(edge.from);
        changed = true;
      }
    }
  }
  traceNodeIds.add(outputId);
  const traceEdgeIds = new Set(
    edges
      .filter((edge) => traceNodeIds.has(edge.from) && traceNodeIds.has(edge.to))
      .map((edge) => edge.id),
  );
  const activeClipLabels = resolvedNodes
    .filter((node) => node.kind === 'clip' && traceNodeIds.has(node.id))
    .map((node) => node.label);
  const traceSummary =
    activeClipLabels.length === 0
      ? `No placed media at ${formatTime(playheadUs)}`
      : `${formatTime(playheadUs)} · ${activeClipLabels.join(' + ')} → Program Output`;

  return {
    durationUs,
    nodes: resolvedNodes,
    edges,
    lanes,
    traceNodeIds,
    traceEdgeIds,
    traceSummary,
  };
}

function buildLanes(
  timeline: SpikeProject,
  creative: JoyProjectV1,
  history: readonly HistoryEntry[],
  clips: readonly TimelineClipProjection[],
): readonly DualLensLane[] {
  const composition = timeline.compositions[timeline.rootCompositionId];
  const objectBindings = readClipObjectMap(creative);
  const elementKinds = readTimelineElementKindMap(creative);
  const rangeForClip = (clipId: string): { readonly startUs?: number; readonly endUs?: number } => {
    const found = clips.find(({ clip }) => clip.id === clipId)?.clip;
    return found === undefined
      ? {}
      : { startUs: found.startUs, endUs: found.startUs + found.durationUs };
  };
  const tracks = composition?.tracks ?? [];
  const core: DualLensLane[] = tracks.map((track, index) => {
    const kind = timelineTrackKind(track, elementKinds);
    const kindIndex = tracks
      .slice(0, index + 1)
      .filter((row) => timelineTrackKind(row, elementKinds) === kind).length;
    const code = timelineTrackCode(kind, kindIndex);
    const name = timelineTrackDisplayName(kind, kindIndex);
    return {
      id: `track:${track.id}`,
      label: `${code} ${name}`,
      advanced: false,
      header: { kind, code, name },
      sourceTrackId: track.id,
      trackEnabled: track.enabled ?? true,
      items: track.clips.map((clip) => ({
        id: clip.id,
        label: polishMediaLabel(clip.id),
        clipId: clip.id,
        icon: timelineElementKindForClip(clip, elementKinds),
        elementKind: timelineElementKindForClip(clip, elementKinds),
        startUs: clip.startUs,
        endUs: clip.startUs + clip.durationUs,
      })),
    };
  });
  const textItems: DualLensLaneItem[] = Object.entries(objectBindings).flatMap(
    ([clipId, objectId]) => {
      const object = creative.visualObjects[objectId];
      if (object?.kind !== 'text') return [];
      return [
        {
          id: objectId,
          label: polishMediaLabel(object.text ?? object.id),
          icon: 'text' as const,
          ...rangeForClip(clipId),
        },
      ];
    },
  );
  const audioItems: DualLensLaneItem[] = Object.keys(creative.audio?.clips ?? {}).map((clipId) => ({
    id: clipId,
    label: polishMediaLabel(clipId),
    icon: 'audio' as const,
    ...rangeForClip(clipId),
  }));
  const creativeComposition = creative.compositions[creative.rootCompositionId];
  const captionClipIdsInCore = new Set(
    tracks.flatMap((track) =>
      track.clips
        .filter((clip) => timelineElementKindForClip(clip, elementKinds) === 'caption')
        .map((clip) => clip.id),
    ),
  );
  const captionItems: readonly DualLensLaneItem[] =
    creativeComposition?.tracks.flatMap((track) =>
      track.kind !== 'caption'
        ? []
        : track.clips.flatMap((clip) =>
            clip.kind !== 'caption'
              ? []
              : captionClipIdsInCore.has(clip.id)
                ? []
                : [
                    {
                      id: `caption:${clip.id}`,
                      label: polishMediaLabel(
                        creative.captionDocuments[clip.captionDocumentId]?.language ??
                          clip.captionDocumentId,
                      ),
                      icon: 'caption' as const,
                      startUs: clip.startUs,
                      endUs: clip.startUs + clip.durationUs,
                    },
                  ],
          ),
    ) ?? [];
  const generationAssets = Object.values(creative.assets).filter(
    (asset) => asset.generationProvenance !== undefined,
  );
  const rangeForAsset = (
    assetId: string,
  ): { readonly startUs?: number; readonly endUs?: number } => {
    const found = clips.find(({ clip }) => clip.kind === 'video' && clip.assetId === assetId)?.clip;
    return found === undefined
      ? {}
      : { startUs: found.startUs, endUs: found.startUs + found.durationUs };
  };
  const scriptValue = creative.variables['script'];
  const scriptItems: readonly DualLensLaneItem[] =
    typeof scriptValue === 'string' && scriptValue.length > 0
      ? [
          {
            id: 'script',
            label: polishMediaLabel(scriptValue.slice(0, 48)),
            icon: 'script',
          },
        ]
      : [];
  const agentItems: readonly DualLensLaneItem[] = history
    .filter((entry) => /agent/i.test(entry.label))
    .slice(-8)
    .map((entry) => ({
      id: entry.id,
      label: polishMediaLabel(entry.label),
      icon: 'agent' as const,
    }));

  return [
    ...core,
    {
      id: 'data:text',
      label: 'Text',
      advanced: true,
      header: { kind: 'text', code: 'T1', name: 'Text' },
      items: textItems,
    },
    {
      id: 'data:audio',
      label: 'Audio',
      advanced: true,
      header: { kind: 'audio', code: 'A1', name: 'Audio' },
      items: audioItems,
    },
    {
      id: 'data:captions',
      label: 'Captions',
      advanced: true,
      header: { kind: 'caption', code: 'CC1', name: 'Captions' },
      items: captionItems,
    },
    {
      id: 'data:script',
      label: 'Script',
      advanced: true,
      header: { kind: 'script', code: 'S1', name: 'Script' },
      items: scriptItems,
    },
    {
      id: 'data:prompts',
      label: 'Prompts',
      advanced: true,
      header: { kind: 'prompt', code: 'P1', name: 'Prompts' },
      items: generationAssets.map((asset) => ({
        id: `prompt:${asset.id}`,
        label: polishMediaLabel(asset.generationProvenance?.prompt ?? asset.displayName),
        icon: 'prompt' as const,
        ...rangeForAsset(asset.id),
      })),
    },
    {
      id: 'data:model-outputs',
      label: 'Model outputs',
      advanced: true,
      header: { kind: 'generation', code: 'G1', name: 'Model outputs' },
      items: generationAssets.map((asset) => ({
        id: asset.id,
        label: polishMediaLabel(asset.displayName),
        icon: 'generation' as const,
        ...rangeForAsset(asset.id),
      })),
    },
    {
      id: 'data:agent-changes',
      label: 'Agent change sets',
      advanced: true,
      header: { kind: 'agent', code: 'N1', name: 'Agent changes' },
      items: agentItems,
    },
  ];
}

function findCaptionPlacements(
  creative: JoyProjectV1,
  documentId: string,
): readonly { readonly startUs: number; readonly endUs: number }[] {
  const composition = creative.compositions[creative.rootCompositionId];
  return (
    composition?.tracks.flatMap((track) =>
      track.kind !== 'caption'
        ? []
        : track.clips.flatMap((clip) =>
            clip.kind === 'caption' && clip.captionDocumentId === documentId
              ? [{ startUs: clip.startUs, endUs: clip.startUs + clip.durationUs }]
              : [],
          ),
    ) ?? []
  );
}

function formatSeconds(durationUs: number): string {
  return `${(durationUs / 1_000_000).toFixed(1)}s`;
}
