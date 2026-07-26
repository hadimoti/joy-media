import type { Clip, JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import type { HistoryEntry } from './editor-session.js';
import { readClipObjectMap } from './sticker-bindings.js';

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
}

export interface DualLensLane {
  readonly id: string;
  readonly label: string;
  readonly advanced: boolean;
  readonly items: readonly DualLensLaneItem[];
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
  const durationUs = composition?.durationUs ?? 0;
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

  const addNode = (node: DualLensNode) => {
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
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
    addNode({
      id: clipId,
      kind: 'clip',
      label: clip.id,
      detail: `${trackName} · ${formatSeconds(clip.durationUs)}`,
      column: 1,
      startUs: clip.startUs,
      endUs,
    });
    if (clip.kind === 'video') {
      const assetId = `asset:${clip.assetId}`;
      const asset = creative.assets[clip.assetId];
      addNode({
        id: assetId,
        kind: 'asset',
        label: asset?.displayName ?? clip.assetId,
        detail: asset?.kind ?? 'video source',
        column: 0,
      });
      addEdge(assetId, clipId, 'source');
      const provenance = asset?.generationProvenance;
      if (provenance !== undefined) {
        const providerId = `provider:${provenance.providerId}:${provenance.modelId}`;
        addNode({
          id: providerId,
          kind: 'provider',
          label: provenance.modelId,
          detail: `${provenance.providerId} · ${provenance.modelVersion}`,
          column: 0,
        });
        addEdge(providerId, assetId, 'generated');
      }
    }
    const objectId = objectBindings[clip.id];
    const object = objectId === undefined ? undefined : creative.visualObjects[objectId];
    if (object !== undefined) {
      const visualId = `visual:${object.id}`;
      addNode({
        id: visualId,
        kind: 'visual',
        label: object.kind === 'text' ? (object.text ?? object.id) : object.id,
        detail: `${object.kind} layer`,
        column: 2,
        startUs: clip.startUs,
        endUs,
      });
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
      label: `${document.language} captions`,
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

  const lanes = buildLanes(timeline, creative, history, clips);
  const traceNodeIds = new Set<string>();
  for (const node of nodes) {
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
  const activeClipLabels = nodes
    .filter((node) => node.kind === 'clip' && traceNodeIds.has(node.id))
    .map((node) => node.label);
  const traceSummary =
    activeClipLabels.length === 0
      ? `No placed media at ${formatTime(playheadUs)}`
      : `${formatTime(playheadUs)} · ${activeClipLabels.join(' + ')} → Program Output`;

  return {
    durationUs,
    nodes,
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
  const rangeForClip = (clipId: string): { readonly startUs?: number; readonly endUs?: number } => {
    const found = clips.find(({ clip }) => clip.id === clipId)?.clip;
    return found === undefined
      ? {}
      : { startUs: found.startUs, endUs: found.startUs + found.durationUs };
  };
  const core: DualLensLane[] =
    composition?.tracks.map((track) => ({
      id: `track:${track.id}`,
      label: `V${track.order + 1} · ${track.id}`,
      advanced: false,
      items: track.clips.map((clip) => ({
        id: clip.id,
        label: clip.id,
        startUs: clip.startUs,
        endUs: clip.startUs + clip.durationUs,
      })),
    })) ?? [];
  const textItems: DualLensLaneItem[] = Object.entries(objectBindings).flatMap(
    ([clipId, objectId]) => {
      const object = creative.visualObjects[objectId];
      if (object?.kind !== 'text') return [];
      return [{ id: objectId, label: object.text ?? object.id, ...rangeForClip(clipId) }];
    },
  );
  const audioItems: DualLensLaneItem[] = Object.keys(creative.audio?.clips ?? {}).map((clipId) => ({
    id: clipId,
    label: clipId,
    ...rangeForClip(clipId),
  }));
  const creativeComposition = creative.compositions[creative.rootCompositionId];
  const captionItems: readonly DualLensLaneItem[] =
    creativeComposition?.tracks.flatMap((track) =>
      track.kind !== 'caption'
        ? []
        : track.clips.flatMap((clip) =>
            clip.kind !== 'caption'
              ? []
              : [
                  {
                    id: `caption:${clip.id}`,
                    label:
                      creative.captionDocuments[clip.captionDocumentId]?.language ??
                      clip.captionDocumentId,
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
      ? [{ id: 'script', label: scriptValue.slice(0, 48) }]
      : [];
  const agentItems: readonly DualLensLaneItem[] = history
    .filter((entry) => /agent/i.test(entry.label))
    .slice(-8)
    .map((entry) => ({ id: entry.id, label: entry.label }));

  return [
    ...core,
    { id: 'data:text', label: 'Text', advanced: true, items: textItems },
    { id: 'data:audio', label: 'Audio', advanced: true, items: audioItems },
    { id: 'data:captions', label: 'Captions', advanced: true, items: captionItems },
    { id: 'data:script', label: 'Script', advanced: true, items: scriptItems },
    {
      id: 'data:prompts',
      label: 'Prompts',
      advanced: true,
      items: generationAssets.map((asset) => ({
        id: `prompt:${asset.id}`,
        label: asset.generationProvenance?.prompt ?? asset.displayName,
        ...rangeForAsset(asset.id),
      })),
    },
    {
      id: 'data:model-outputs',
      label: 'Model outputs',
      advanced: true,
      items: generationAssets.map((asset) => ({
        id: asset.id,
        label: asset.displayName,
        ...rangeForAsset(asset.id),
      })),
    },
    { id: 'data:agent-changes', label: 'Agent change sets', advanced: true, items: agentItems },
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

export function formatTime(timeUs: number): string {
  const seconds = Math.max(0, timeUs) / 1_000_000;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
}
