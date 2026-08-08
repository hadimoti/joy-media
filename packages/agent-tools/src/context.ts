import type {
  Composition,
  CompositionV1,
  Clip,
  ClipV1,
  JoyProjectV1,
  SpikeProject,
  Track,
  TrackV1,
} from '@joy-media/project-schema';
import type { AudioState, SpikeCommand } from '@joy-media/commands';
import type { JsonValue } from './types.js';

/**
 * The live seam between an edit tool and the real, undoable command bus the
 * human editor uses (WP-15.1). When bound, `EditTool.execute` dispatches a
 * genuine `SpikeCommand` transaction instead of fabricating a preview diff;
 * a real validation failure (unknown target, overlap, duplicate id, ...) comes
 * back as `success: false` with the underlying command's own error. When
 * absent, planning/estimation contexts fall back to preview-shaped results.
 */
export interface CommandDispatcher {
  /** Applies one or more commands as a single undoable transaction. */
  dispatchTimeline(commands: readonly SpikeCommand[], label: string): CommandDispatchResult;
}

export interface CommandDispatchResult {
  readonly success: boolean;
  readonly error?: string;
}

export interface EditorContext {
  readonly project: ProjectSummary;
  readonly selection: SelectionContext;
  readonly timeline: TimelineContext;
  readonly captions?: CaptionContext;
  readonly audio: AudioContext;
  /** Indexed data used by local query tools; omitted by hand-authored contexts. */
  readonly query?: QueryContext;
  /** Live mixer graph when the editor binds one. */
  readonly liveAudio?: AudioState;
  readonly providers: ProviderContext;
  readonly availableTools: readonly string[];
  readonly recentHistory: readonly string[];
  readonly exportTarget?: ExportTargetContext;
  readonly constraints: readonly string[];
  readonly dispatch?: CommandDispatcher;
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly durationUs: number;
  readonly compositionCount: number;
  readonly trackCount: number;
  readonly clipCount: number;
  readonly hasCaptions: boolean;
  readonly hasAudio: boolean;
  readonly missingAssets: readonly string[];
}

export interface SelectionContext {
  readonly selectedClipIds: readonly string[];
  readonly selectedTrackIds: readonly string[];
  readonly playheadUs: number;
  readonly inPointUs?: number;
  readonly outPointUs?: number;
}

export interface TimelineContext {
  readonly compositions: readonly CompositionSummary[];
  readonly totalDurationUs: number;
}

export interface CompositionSummary {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: { num: number; den: number };
  readonly durationUs: number;
  readonly trackCount: number;
}

export interface CaptionContext {
  readonly documentCount: number;
  readonly languages: readonly string[];
  readonly totalWordCount: number;
  readonly lowConfidenceSegments: number;
}

export interface AudioContext {
  readonly clipCount: number;
  readonly busCount: number;
  readonly hasDialogue: boolean;
  readonly peakLevelDb?: number;
  readonly loudnessLufs?: number;
}

export interface QueryClipSummary {
  readonly id: string;
  readonly compositionId: string;
  readonly trackId: string;
  readonly kind: 'video' | 'composition' | 'caption';
  readonly startUs: number;
  readonly durationUs: number;
  readonly source?: string;
  readonly name?: string;
}

export interface QueryCaptionSegment {
  readonly id: string;
  readonly documentId: string;
  readonly language: string;
  readonly text: string;
  readonly startUs: number;
  readonly endUs: number;
}

export interface QueryAudioRegion {
  readonly id: string;
  readonly type: 'silence' | 'speech';
  readonly startUs: number;
  readonly endUs: number;
  readonly clipId?: string;
}

export interface QueryEntity {
  readonly id: string;
  readonly kind: string;
  readonly properties: Readonly<Record<string, JsonValue>>;
}

export interface QueryContext {
  readonly clips: readonly QueryClipSummary[];
  readonly captionSegments: readonly QueryCaptionSegment[];
  readonly entities: readonly QueryEntity[];
  /** Undefined means analysis has not run; an empty array means it ran and found none. */
  readonly audioRegions?: readonly QueryAudioRegion[];
}

export interface ProviderContext {
  readonly availableProviders: readonly ProviderSummary[];
  readonly localOnly: boolean;
}

export interface ProviderSummary {
  readonly id: string;
  readonly displayName: string;
  readonly execution: 'worker-local' | 'remote-api' | 'server' | 'browser';
  readonly capabilities: readonly string[];
  readonly dataLeavesDevice: boolean;
}

export interface ExportTargetContext {
  readonly format: string;
  readonly resolution: string;
  readonly codec: string;
}

export interface ContextOptions {
  readonly maxTimelineSummaryItems?: number;
  readonly maxHistoryItems?: number;
  readonly maxCaptionExcerptWords?: number;
  readonly includeProviderDetails?: boolean;
}

export interface EditorContextExtras {
  readonly liveAudio?: AudioState;
  readonly creativeProject?: JoyProjectV1;
  readonly selection?: Partial<SelectionContext>;
  readonly audioRegions?: readonly QueryAudioRegion[];
  readonly providers?: ProviderContext;
  readonly availableTools?: readonly string[];
  readonly recentHistory?: readonly string[];
  readonly constraints?: readonly string[];
}

export function buildEditorContext(
  projectState: unknown,
  options?: ContextOptions,
  dispatch?: CommandDispatcher,
  extras?: EditorContextExtras,
): EditorContext {
  const opts = {
    maxTimelineSummaryItems: 10,
    maxHistoryItems: 5,
    maxCaptionExcerptWords: 50,
    includeProviderDetails: true,
    ...options,
  };
  const creativeProject =
    extras?.creativeProject ?? (isV1Project(projectState) ? projectState : undefined);
  const project = extractProjectSummary(projectState, creativeProject, extras?.liveAudio);
  const selection = extractSelectionContext(extras?.selection);
  const timeline = extractTimelineContext(projectState, opts.maxTimelineSummaryItems);
  const captions = extractCaptionContext(creativeProject, opts.maxCaptionExcerptWords);
  const audio = extractAudioContext(extras?.liveAudio, creativeProject);
  const providers = extras?.providers ?? extractProviderContext(opts.includeProviderDetails);
  const query = extractQueryContext(projectState, creativeProject, extras?.audioRegions);

  return {
    project,
    selection,
    timeline,
    ...(captions !== undefined ? { captions } : {}),
    audio,
    query,
    ...(extras?.liveAudio !== undefined ? { liveAudio: extras.liveAudio } : {}),
    providers,
    availableTools: extras?.availableTools ?? [],
    recentHistory: (extras?.recentHistory ?? []).slice(0, opts.maxHistoryItems),
    constraints: extras?.constraints ?? [],
    ...(dispatch !== undefined ? { dispatch } : {}),
  };
}

function extractProjectSummary(
  state: unknown,
  creativeProject: JoyProjectV1 | undefined,
  liveAudio: AudioState | undefined,
): ProjectSummary {
  if (!isProject(state) && !isV1Project(state)) {
    return {
      id: creativeProject?.id ?? 'unknown',
      name: creativeProject?.title ?? 'Unknown Project',
      durationUs: 0,
      compositionCount: 0,
      trackCount: 0,
      clipCount: 0,
      hasCaptions: Object.keys(creativeProject?.captionDocuments ?? {}).length > 0,
      hasAudio: audioClipCount(liveAudio, creativeProject) > 0,
      missingAssets: [],
    };
  }

  const compositions = Object.values(state.compositions);
  const tracks = compositions.flatMap((composition) => composition.tracks);
  const clips = tracks.flatMap((track) => track.clips);
  const rootComposition = state.compositions[state.rootCompositionId];
  const assetCatalog = creativeProject?.assets ?? (isV1Project(state) ? state.assets : undefined);
  const referencedAssetIds = clips.flatMap((clip) => (clip.kind === 'video' ? [clip.assetId] : []));
  const missingAssets =
    assetCatalog === undefined
      ? []
      : [...new Set(referencedAssetIds.filter((assetId) => assetCatalog[assetId] === undefined))];

  return {
    id: state.id,
    name: creativeProject?.title ?? (isV1Project(state) ? state.title : state.id),
    durationUs: rootComposition?.durationUs ?? 0,
    compositionCount: compositions.length,
    trackCount: tracks.length,
    clipCount: clips.length,
    hasCaptions: Object.keys(creativeProject?.captionDocuments ?? {}).length > 0,
    hasAudio:
      tracks.some((track) => 'kind' in track && track.kind === 'audio') ||
      audioClipCount(liveAudio, creativeProject) > 0,
    missingAssets,
  };
}

function extractSelectionContext(
  selection: Partial<SelectionContext> | undefined,
): SelectionContext {
  return {
    selectedClipIds: selection?.selectedClipIds ?? [],
    selectedTrackIds: selection?.selectedTrackIds ?? [],
    playheadUs: selection?.playheadUs ?? 0,
    ...(selection?.inPointUs !== undefined ? { inPointUs: selection.inPointUs } : {}),
    ...(selection?.outPointUs !== undefined ? { outPointUs: selection.outPointUs } : {}),
  };
}

function extractTimelineContext(state: unknown, maxItems: number): TimelineContext {
  if (!isProject(state) && !isV1Project(state)) {
    return { compositions: [], totalDurationUs: 0 };
  }

  const allCompositions = Object.values(state.compositions);
  return {
    compositions: allCompositions.slice(0, maxItems).map(summarizeComposition),
    totalDurationUs: allCompositions.reduce((sum, composition) => sum + composition.durationUs, 0),
  };
}

function summarizeComposition(comp: Composition | CompositionV1): CompositionSummary {
  return {
    id: comp.id,
    name: comp.name,
    width: comp.width,
    height: comp.height,
    frameRate: { num: comp.frameRate.num, den: comp.frameRate.den },
    durationUs: comp.durationUs,
    trackCount: comp.tracks.length,
  };
}

function extractCaptionContext(
  project: JoyProjectV1 | undefined,
  _maxWords: number,
): CaptionContext | undefined {
  if (project === undefined) return undefined;
  const documents = Object.values(project.captionDocuments);
  if (documents.length === 0) return undefined;

  return {
    documentCount: documents.length,
    languages: [...new Set(documents.map((document) => document.language))],
    totalWordCount: documents.reduce(
      (sum, document) => sum + Object.keys(document.words).length,
      0,
    ),
    lowConfidenceSegments: documents.reduce(
      (sum, document) =>
        sum +
        document.segments.filter((segment) =>
          segment.wordIds.some((id) => {
            const confidence = document.words[id]?.confidence;
            return confidence !== undefined && confidence < 0.7;
          }),
        ).length,
      0,
    ),
  };
}

function extractAudioContext(
  liveAudio: AudioState | undefined,
  project: JoyProjectV1 | undefined,
): AudioContext {
  const clips = liveAudio?.clips ?? project?.audio?.clips ?? {};
  const buses = liveAudio?.buses ?? project?.audio?.buses ?? [];
  const clipCount = Object.keys(clips).length;
  return { clipCount, busCount: buses.length, hasDialogue: clipCount > 0 };
}

function audioClipCount(
  liveAudio: AudioState | undefined,
  project: JoyProjectV1 | undefined,
): number {
  return Object.keys(liveAudio?.clips ?? project?.audio?.clips ?? {}).length;
}

function extractProviderContext(_includeDetails: boolean): ProviderContext {
  return { availableProviders: [], localOnly: true };
}

function extractQueryContext(
  state: unknown,
  creativeProject: JoyProjectV1 | undefined,
  audioRegions: readonly QueryAudioRegion[] | undefined,
): QueryContext {
  const clips = extractClipSummaries(state, creativeProject);
  const captionSegments = extractCaptionSegments(creativeProject);
  const entities = extractEntities(state, creativeProject, clips, captionSegments);
  return {
    clips,
    captionSegments,
    entities,
    ...(audioRegions !== undefined ? { audioRegions } : {}),
  };
}

function extractClipSummaries(
  state: unknown,
  creativeProject: JoyProjectV1 | undefined,
): readonly QueryClipSummary[] {
  if (!isProject(state) && !isV1Project(state)) return [];
  const assets = creativeProject?.assets ?? (isV1Project(state) ? state.assets : {});
  const compositions: readonly (Composition | CompositionV1)[] = Object.values(state.compositions);
  return compositions.flatMap((composition) => {
    const tracks: readonly (Track | TrackV1)[] = composition.tracks;
    return tracks.flatMap((track) => {
      const trackClips: readonly (Clip | ClipV1)[] = track.clips;
      return trackClips.map((clip) => {
        const source =
          clip.kind === 'video'
            ? clip.assetId
            : clip.kind === 'composition'
              ? clip.compositionId
              : clip.captionDocumentId;
        const name = clip.kind === 'video' ? assets[source]?.displayName : undefined;
        return {
          id: clip.id,
          compositionId: composition.id,
          trackId: track.id,
          kind: clip.kind,
          startUs: clip.startUs,
          durationUs: clip.durationUs,
          source,
          ...(name !== undefined ? { name } : {}),
        };
      });
    });
  });
}

function extractCaptionSegments(project: JoyProjectV1 | undefined): readonly QueryCaptionSegment[] {
  if (project === undefined) return [];
  return Object.values(project.captionDocuments).flatMap((document) =>
    document.segments.map((segment) => ({
      id: segment.id,
      documentId: document.id,
      language: document.language,
      text:
        segment.textOverride ??
        segment.wordIds
          .map((wordId) => document.words[wordId]?.text)
          .filter((word): word is string => word !== undefined)
          .join(' '),
      startUs: segment.startUs,
      endUs: segment.endUs,
    })),
  );
}

function extractEntities(
  state: unknown,
  creativeProject: JoyProjectV1 | undefined,
  clips: readonly QueryClipSummary[],
  captionSegments: readonly QueryCaptionSegment[],
): readonly QueryEntity[] {
  const entities: QueryEntity[] = clips.map((clip) => ({
    id: clip.id,
    kind: `clip.${clip.kind}`,
    properties: {
      compositionId: clip.compositionId,
      trackId: clip.trackId,
      startUs: clip.startUs,
      durationUs: clip.durationUs,
      ...(clip.source !== undefined ? { source: clip.source } : {}),
      ...(clip.name !== undefined ? { name: clip.name } : {}),
    },
  }));

  if (isProject(state) || isV1Project(state)) {
    for (const composition of Object.values(state.compositions)) {
      entities.push({
        id: composition.id,
        kind: 'composition',
        properties: {
          name: composition.name,
          width: composition.width,
          height: composition.height,
          durationUs: composition.durationUs,
          trackCount: composition.tracks.length,
        },
      });
      for (const track of composition.tracks) {
        entities.push({
          id: track.id,
          kind: 'track',
          properties: {
            compositionId: composition.id,
            kind: track.kind,
            order: track.order,
            enabled: track.enabled,
            clipCount: track.clips.length,
            ...('locked' in track ? { locked: track.locked } : {}),
          },
        });
      }
    }
  }

  if (creativeProject !== undefined) {
    for (const asset of Object.values(creativeProject.assets)) {
      entities.push({
        id: asset.id,
        kind: 'asset',
        properties: { kind: asset.kind, displayName: asset.displayName },
      });
    }
    for (const object of Object.values(creativeProject.visualObjects)) {
      entities.push({
        id: object.id,
        kind: `visual.${object.kind}`,
        properties: {
          objectKind: object.kind,
          x: object.transform.x,
          y: object.transform.y,
          scaleX: object.transform.scaleX,
          scaleY: object.transform.scaleY,
          rotationDeg: object.transform.rotationDeg,
          opacity: object.transform.opacity,
          ...(object.assetId !== undefined ? { assetId: object.assetId } : {}),
          ...(object.text !== undefined ? { text: object.text } : {}),
          ...(object.parentId !== undefined ? { parentId: object.parentId } : {}),
        },
      });
    }
  }

  entities.push(
    ...captionSegments.map((segment) => ({
      id: segment.id,
      kind: 'caption.segment',
      properties: {
        documentId: segment.documentId,
        language: segment.language,
        text: segment.text,
        startUs: segment.startUs,
        endUs: segment.endUs,
      },
    })),
  );
  return entities;
}

function isProject(value: unknown): value is SpikeProject {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    (value as { schemaVersion: unknown }).schemaVersion === 0
  );
}

function isV1Project(value: unknown): value is JoyProjectV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    (value as { schemaVersion: unknown }).schemaVersion === 1
  );
}
