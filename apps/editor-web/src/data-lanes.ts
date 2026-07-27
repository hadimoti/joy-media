/**
 * Data lanes: the durable creative document, laid out against timeline time.
 *
 * §6.2 of the unified data plan asks for these to be *collapsed by default*, and
 * that constraint shapes the model more than it looks. A lane only earns space
 * when it has something in it, and an artifact that is not bound to time is not
 * hidden — it appears as unplaced, because "we have a script but it is not
 * attached to anything yet" is information the editor needs, and silently
 * dropping it would make the drawer lie about what the project contains.
 *
 * Everything here is derived. Lanes are a view over artifacts, the workflow
 * graph, and existing document slices; nothing in this file mutates, and lane
 * edits go out as artifact commands like any other edit.
 */

import type {
  ArtifactVersionV2,
  CreativeArtifactV2,
  JoyProjectV1,
  TemporalBinding,
  WorkflowGraphV2,
} from '@joy-media/project-schema';
import type { ArtifactStore } from '@joy-media/commands';

export type DataLaneKind =
  | 'script'
  | 'transcript'
  | 'captions'
  | 'prompt'
  | 'analysis'
  | 'generation'
  | 'changeSet'
  | 'workflow'
  | 'reviewGate';

export interface DataLaneItem {
  readonly id: string;
  readonly label: string;
  readonly kind: DataLaneKind;
  /** Absent for unplaced items, which render as chips rather than ranges. */
  readonly startUs?: number;
  readonly durationUs?: number;
  readonly artifactId?: string;
  readonly versionCount: number;
  readonly pinned: boolean;
  /** Upstream changed after this was produced (plan §7.6). */
  readonly stale: boolean;
  readonly detail: string;
}

export interface DataLane {
  readonly id: string;
  readonly kind: DataLaneKind;
  readonly label: string;
  readonly items: readonly DataLaneItem[];
}

export interface DataLaneInput {
  readonly artifacts: ArtifactStore;
  readonly graph: WorkflowGraphV2;
  readonly creative: JoyProjectV1;
}

const LANE_ORDER: readonly { readonly kind: DataLaneKind; readonly label: string }[] = [
  { kind: 'script', label: 'Script' },
  { kind: 'transcript', label: 'Transcript' },
  { kind: 'captions', label: 'Captions' },
  { kind: 'prompt', label: 'Prompts' },
  { kind: 'analysis', label: 'Analysis' },
  { kind: 'generation', label: 'Generated' },
  { kind: 'changeSet', label: 'Agent changes' },
  { kind: 'workflow', label: 'Workflow runs' },
  { kind: 'reviewGate', label: 'Review gates' },
];

/** Artifact kinds that are not their own lane fold into the closest one. */
function laneKindFor(artifact: CreativeArtifactV2): DataLaneKind | undefined {
  switch (artifact.kind) {
    case 'script':
      return 'script';
    case 'transcript':
      return 'transcript';
    case 'captionDocument':
      return 'captions';
    case 'prompt':
      return 'prompt';
    case 'analysis':
      return 'analysis';
    case 'generatedMedia':
    case 'renderOutput':
      return 'generation';
    case 'changeSet':
      return 'changeSet';
    // Plain media and metadata already appear on the tracks above; repeating
    // them as data would double-count the same thing in one drawer.
    default:
      return undefined;
  }
}

function placement(binding: TemporalBinding): {
  readonly startUs?: number;
  readonly durationUs?: number;
} {
  switch (binding.type) {
    case 'range':
      return { startUs: binding.startUs, durationUs: binding.durationUs };
    case 'point':
      return { startUs: binding.timeUs, durationUs: 0 };
    default:
      // global / none / track / item / selection have no direct span. Track and
      // item could be resolved later; until then, honestly unplaced.
      return {};
  }
}

export function buildDataLanes(input: DataLaneInput): readonly DataLane[] {
  const staleNodeIds = new Set(
    input.graph.nodes.filter((node) => node.status === 'stale').map((node) => node.id),
  );
  const byKind = new Map<DataLaneKind, DataLaneItem[]>();
  const push = (kind: DataLaneKind, item: DataLaneItem) => {
    byKind.set(kind, [...(byKind.get(kind) ?? []), item]);
  };

  for (const artifact of Object.values(input.artifacts.artifacts)) {
    const kind = laneKindFor(artifact);
    if (kind === undefined) continue;
    const versions: readonly ArtifactVersionV2[] = input.artifacts.versions[artifact.id] ?? [];
    const producedBy = artifact.provenance.workflowNodeId;
    push(kind, {
      id: `artifact:${artifact.id}`,
      label: artifact.label,
      kind,
      ...placement(artifact.binding),
      artifactId: artifact.id,
      versionCount: versions.length,
      pinned: artifact.pinned === true || versions.some((version) => version.pinned === true),
      stale: producedBy !== undefined && staleNodeIds.has(producedBy),
      detail: describeArtifact(artifact, versions.length),
    });
  }

  // Caption documents predate artifacts and are still stored as their own slice,
  // so they are read from where they actually live rather than being migrated
  // into artifacts, which ADR-0023 deliberately did not do.
  const composition = input.creative.compositions[input.creative.rootCompositionId];
  for (const track of composition?.tracks ?? []) {
    if (track.kind !== 'caption') continue;
    for (const clip of track.clips) {
      if (clip.kind !== 'caption') continue;
      const document = input.creative.captionDocuments[clip.captionDocumentId];
      push('captions', {
        id: `caption:${clip.id}`,
        label: document?.language ?? clip.captionDocumentId,
        kind: 'captions',
        startUs: clip.startUs,
        durationUs: clip.durationUs,
        versionCount: 0,
        pinned: false,
        stale: false,
        detail: `${Object.keys(document?.words ?? {}).length} words`,
      });
    }
  }

  for (const node of input.graph.nodes) {
    const place = node.binding === undefined ? {} : placement(node.binding);
    if (node.executionPolicy.requiresApproval) {
      push('reviewGate', {
        id: `gate:${node.id}`,
        label: node.label,
        kind: 'reviewGate',
        ...place,
        versionCount: 0,
        pinned: false,
        stale: node.status === 'stale',
        detail: node.status ?? 'idle',
      });
    }
    if (node.status === 'running' || node.status === 'queued' || node.status === 'failed') {
      push('workflow', {
        id: `run:${node.id}`,
        label: node.label,
        kind: 'workflow',
        ...place,
        versionCount: 0,
        pinned: false,
        stale: false,
        detail: node.status,
      });
    }
  }

  return LANE_ORDER.flatMap(({ kind, label }) => {
    const items = byKind.get(kind);
    // An empty lane is omitted rather than shown empty: the drawer has to stay
    // uncluttered by default, and a row of nothing is clutter.
    if (items === undefined || items.length === 0) return [];
    return [{ id: `lane:${kind}`, kind, label, items: sortItems(items) }];
  });
}

function sortItems(items: readonly DataLaneItem[]): readonly DataLaneItem[] {
  return [...items].sort((left, right) => {
    if (left.startUs === undefined && right.startUs === undefined) {
      return left.label.localeCompare(right.label);
    }
    // Unplaced items sort last so the placed timeline reads cleanly.
    if (left.startUs === undefined) return 1;
    if (right.startUs === undefined) return -1;
    return left.startUs - right.startUs;
  });
}

function describeArtifact(artifact: CreativeArtifactV2, versionCount: number): string {
  const provider = artifact.provenance.modelId ?? artifact.provenance.providerId;
  const parts = [
    `rev ${artifact.revision}`,
    ...(versionCount > 0 ? [`${versionCount} version${versionCount === 1 ? '' : 's'}`] : []),
    ...(provider === undefined ? [] : [provider]),
  ];
  return parts.join(' · ');
}

/** Total placed + unplaced items, for the collapsed drawer's badge. */
export function countLaneItems(lanes: readonly DataLane[]): number {
  return lanes.reduce((total, lane) => total + lane.items.length, 0);
}
