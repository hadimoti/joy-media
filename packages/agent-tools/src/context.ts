import type { Composition, JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import type { SpikeCommand } from '@joy-media/commands';

/**
 * The live seam between an edit tool and the real, undoable command bus the
 * human editor uses (WP-15.1). When bound, `EditTool.execute` dispatches a
 * genuine `SpikeCommand` transaction instead of fabricating a preview diff;
 * a real validation failure (unknown target, overlap, duplicate id, …) comes
 * back as `success: false` with the underlying command's own error. When
 * absent — planning/estimation/test contexts that never had a live project —
 * tools fall back to their historical preview-shaped result.
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
  /** Live mixer graph when the editor binds one (Phase 3). */
  readonly liveAudio?: import('@joy-media/commands').AudioState;
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

export function buildEditorContext(
  projectState: unknown,
  options?: ContextOptions,
  dispatch?: CommandDispatcher,
  extras?: { readonly liveAudio?: import('@joy-media/commands').AudioState },
): EditorContext {
  const opts = {
    maxTimelineSummaryItems: 10,
    maxHistoryItems: 5,
    maxCaptionExcerptWords: 50,
    includeProviderDetails: true,
    ...options,
  };

  const project = extractProjectSummary(projectState);
  const selection = extractSelectionContext(projectState);
  const timeline = extractTimelineContext(projectState, opts.maxTimelineSummaryItems);
  const captions = extractCaptionContext(projectState, opts.maxCaptionExcerptWords);
  const audio = extractAudioContext(projectState);
  const providers = extractProviderContext(projectState, opts.includeProviderDetails);

  return {
    project,
    selection,
    timeline,
    ...(captions && { captions }),
    audio,
    ...(extras?.liveAudio !== undefined ? { liveAudio: extras.liveAudio } : {}),
    providers,
    availableTools: [],
    recentHistory: [],
    constraints: [],
    ...(dispatch && { dispatch }),
  };
}

function extractProjectSummary(state: unknown): ProjectSummary {
  if (!isProject(state)) {
    return {
      id: 'unknown',
      name: 'Unknown Project',
      durationUs: 0,
      compositionCount: 0,
      trackCount: 0,
      clipCount: 0,
      hasCaptions: false,
      hasAudio: false,
      missingAssets: [],
    };
  }

  const compositions = Object.values(state.compositions);
  const tracks = compositions.flatMap((c) => c.tracks);
  const clips = tracks.flatMap((t) => t.clips);

  const rootComp = state.compositions[state.rootCompositionId];
  const durationUs = rootComp?.durationUs ?? 0;

  // A SpikeProject's `Track.kind` is `'video'` only (P00 spike, model.ts) —
  // captions/audio live in the separate JoyProjectV1 document instead, so
  // these are always false here rather than a dead cross-schema comparison.
  const hasCaptions = false;
  const hasAudio = false;

  // SpikeProject has no declared asset catalog to check against (opaque
  // `assetId` strings only), so nothing can be reported missing from it.
  const assetIds = new Set(clips.filter((c) => c.kind === 'video').map((c) => c.assetId));
  const missingAssets = [...assetIds];

  return {
    id: state.id,
    name: state.id,
    durationUs,
    compositionCount: compositions.length,
    trackCount: tracks.length,
    clipCount: clips.length,
    hasCaptions,
    hasAudio,
    missingAssets,
  };
}

function extractSelectionContext(_state: unknown): SelectionContext {
  return {
    selectedClipIds: [],
    selectedTrackIds: [],
    playheadUs: 0,
  };
}

function extractTimelineContext(state: unknown, maxItems: number): TimelineContext {
  if (!isProject(state)) {
    return {
      compositions: [],
      totalDurationUs: 0,
    };
  }

  const compositions = Object.values(state.compositions)
    .slice(0, maxItems)
    .map((comp) => summarizeComposition(comp));

  const totalDurationUs = Object.values(state.compositions).reduce(
    (sum, comp) => sum + comp.durationUs,
    0,
  );

  return {
    compositions,
    totalDurationUs,
  };
}

function summarizeComposition(comp: Composition): CompositionSummary {
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

function extractCaptionContext(state: unknown, _maxWords: number): CaptionContext | undefined {
  if (!isV1Project(state)) {
    return undefined;
  }

  const docs = Object.values(state.captionDocuments ?? {});
  if (docs.length === 0) {
    return undefined;
  }

  const languages = [...new Set(docs.map((d) => d.language))];
  const totalWordCount = docs.reduce((sum, doc) => sum + Object.keys(doc.words).length, 0);
  const lowConfidenceSegments = docs.reduce((sum, doc) => {
    return (
      sum +
      doc.segments.filter((seg) => {
        const words = seg.wordIds.map((id) => doc.words[id]).filter((w) => w !== undefined);
        return words.some((w) => w.confidence !== undefined && w.confidence < 0.7);
      }).length
    );
  }, 0);

  return {
    documentCount: docs.length,
    languages,
    totalWordCount,
    lowConfidenceSegments,
  };
}

function extractAudioContext(_state: unknown): AudioContext {
  return {
    clipCount: 0,
    busCount: 0,
    hasDialogue: false,
  };
}

function extractProviderContext(_state: unknown, _includeDetails: boolean): ProviderContext {
  return {
    availableProviders: [],
    localOnly: true,
  };
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
