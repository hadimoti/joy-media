import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ComponentProps } from 'react';
import { DockviewReact } from 'dockview';
import type { DockviewApi, DockviewReadyEvent, IDockviewPanelProps } from 'dockview';
import { PanelTab } from './PanelTab.js';
import { LazyPanel } from './LazyPanel.js';
import { AppMenuBar } from './AppMenuBar.js';
import { panelIdFromMenuAction, type AppMenuActionId } from './app-menu.js';
import {
  createHtmlMediaDecoder,
  createHtmlVideoMediaClock,
  PlaybackScheduler,
  videoFrameNodeFromDecoded,
  withVideoFrameNode,
  type HtmlMediaDecoder,
  type ImageDataLike,
  type MediaClock,
  type VideoClipSpec,
} from '@joy-media/playback-engine';
import type { VideoFrameNode } from '@joy-media/render-ir';
import type { RenderBundleV2, CompositionPlanV2 } from '@joy-media/render-planner';
import { createCompositionPlanV2 } from '../../../packages/render-planner/src/v2.js';
import { createRenderBundle } from '../../../packages/render-planner/src/render-bundle.js';
const CAPTION_BURN_IN_KEY = 'joy.captions.burnIn' as const;
import { duplicateClipCommand, rippleDelete, toggleSelection } from '@joy-media/timeline-engine';
import type { TimelineTrackView, TimelineViewport } from '@joy-media/timeline-engine';
import type {
  CommandTransaction,
  GraphTransaction,
  ArtifactStore,
  ArtifactTransaction,
} from '@joy-media/commands';
import type { CommandDispatcher, EditorContext } from '@joy-media/agent-tools';
import type { HistoryEntry } from './editor-session.js';
import type { AudioClip, JoyProjectV1, SpikeProject, VideoClip } from '@joy-media/project-schema';
import { normalizePlaybackRate } from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import type { ProductionRunAuthority } from '@joy-media/workflow-engine';
import type { createVerifiedDeliverySnapshot } from './verified-delivery-snapshot.js';
import type { deliveryPromiseForManifest } from '@joy-media/export-core/browser';
import type { transcribeReferenceCaption } from './caption-transcription-runner.js';
import type { ProjectDocumentSpine } from './project-document-spine.js';

/**
 * Secondary panels are intentionally separate entry points. Dockview creates
 * their component only after a panel is selected, so these imports do not add
 * motion/AI/workflow/3D code to the editor shell's initial request.
 */
const LazyAgentPanel = lazy(() =>
  import('./AgentPanel.js').then(({ AgentPanel }) => ({ default: AgentPanel })),
);
const LazyCameraPanel = lazy(() =>
  import('./CameraPanel.js').then(({ CameraPanel }) => ({ default: CameraPanel })),
);
const LazyDualLensPanel = lazy(() =>
  import('./DualLensPanel.js').then(({ DualLensPanel }) => ({ default: DualLensPanel })),
);
const LazyInspectorPanel = lazy(() =>
  import('./InspectorPanel.js').then(({ InspectorPanel }) => ({ default: InspectorPanel })),
);
const LazyEffectsPanel = lazy(() =>
  import('./EffectsPanel.js').then(({ EffectsPanel }) => ({ default: EffectsPanel })),
);
const LazyAudioPanel = lazy(() =>
  import('./AudioPanel.js').then(({ AudioPanel }) => ({ default: AudioPanel })),
);
const LazyCaptionsPanel = lazy(() =>
  import('./CaptionsPanel.js').then(({ CaptionsPanel }) => ({ default: CaptionsPanel })),
);
const LazyColorPanel = lazy(() =>
  import('./ColorPanel.js').then(({ ColorPanel }) => ({ default: ColorPanel })),
);
const LazyTransitionsPanel = lazy(() =>
  import('./TransitionsPanel.js').then(({ TransitionsPanel }) => ({ default: TransitionsPanel })),
);
const LazyHistoryPanel = lazy(() =>
  import('./HistoryPanel.js').then(({ HistoryPanel }) => ({ default: HistoryPanel })),
);
const LazyJobsPanel = lazy(() =>
  import('./JobsPanel.js').then(({ JobsPanel }) => ({ default: JobsPanel })),
);
const LazyMotionPanel = lazy(() =>
  import('./MotionPanel.js').then(({ MotionPanel }) => ({ default: MotionPanel })),
);
const LazyMotionStudioShell = lazy(() =>
  import('./motion-studio/index.js').then(({ MotionStudioShell }) => ({
    default: MotionStudioShell,
  })),
);
const LazyEffectStudioShell = lazy(() =>
  import('./effect-studio/index.js').then(({ EffectStudioShell }) => ({
    default: EffectStudioShell,
  })),
);
const LazyPluginsPanel = lazy(() =>
  import('./PluginsPanel.js').then(({ PluginsPanel }) => ({ default: PluginsPanel })),
);
const LazyProductionBoardPanel = lazy(() =>
  import('./ProductionBoardPanel.js').then(({ ProductionBoardPanel }) => ({
    default: ProductionBoardPanel,
  })),
);
const LazySpecialistReviewPanel = lazy(() =>
  import('./SpecialistReviewPanel.js').then(({ SpecialistReviewPanel }) => ({
    default: SpecialistReviewPanel,
  })),
);
const LazyTemplatesPanel = lazy(() =>
  import('./TemplatesPanel.js').then(({ TemplatesPanel }) => ({ default: TemplatesPanel })),
);
const LazyWorkflowsPanel = lazy(() =>
  import('./WorkflowsPanel.js').then(({ WorkflowsPanel }) => ({ default: WorkflowsPanel })),
);
const LazyAssetLibraryPanel = lazy(() =>
  import('./AssetLibraryPanel.js').then(({ AssetLibraryPanel }) => ({
    default: AssetLibraryPanel,
  })),
);
const LazyDeliveryReportPanel = lazy(() =>
  import('./DeliveryReportPanel.js').then(({ DeliveryReportPanel }) => ({
    default: DeliveryReportPanel,
  })),
);
const LazyProjectLibrary = lazy(() =>
  import('./ProjectLibrary.js').then(({ ProjectLibrary }) => ({ default: ProjectLibrary })),
);
const LazyAgentSettingsDialog = lazy(() =>
  import('./AgentSettingsDialog.js').then(({ AgentSettingsDialog }) => ({
    default: AgentSettingsDialog,
  })),
);

type AgentPanelProps = ComponentProps<typeof LazyAgentPanel>;

async function createVerifiedDeliverySnapshotDeferred(
  ...args: Parameters<typeof createVerifiedDeliverySnapshot>
): Promise<RenderBundleV2> {
  const { createVerifiedDeliverySnapshot } = await import('./verified-delivery-snapshot.js');
  return createVerifiedDeliverySnapshot(...args);
}

async function deliveryPromiseForManifestDeferred(
  ...args: Parameters<typeof deliveryPromiseForManifest>
) {
  const { deliveryPromiseForManifest } = await import('@joy-media/export-core/browser');
  return deliveryPromiseForManifest(...args);
}

async function transcribeReferenceCaptionDeferred(
  ...args: Parameters<typeof transcribeReferenceCaption>
) {
  const { transcribeReferenceCaption } = await import('./caption-transcription-runner.js');
  return transcribeReferenceCaption(...args);
}

/** Load the agent-tools context only when the (non-shell) Agent panel mounts. */
function AgentPanelGate({
  project,
  commandBus,
  audioState,
  ...props
}: Omit<AgentPanelProps, 'agentContext' | 'project'> & {
  readonly project: SpikeProject;
  readonly commandBus: CommandDispatcher;
  readonly audioState: AudioState;
}) {
  const [agentContext, setAgentContext] = useState<EditorContext>();
  useEffect(() => {
    let cancelled = false;
    void import('@joy-media/agent-tools')
      .then(({ buildEditorContext }) => {
        if (!cancelled) {
          setAgentContext(
            buildEditorContext(project, undefined, commandBus, { liveAudio: audioState }),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setAgentContext(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [audioState, commandBus, project]);

  if (agentContext === undefined) {
    return (
      <section className="panel-loading" role="status" aria-label="Loading Agent">
        Loading Agent…
      </section>
    );
  }
  return <LazyAgentPanel {...props} project={project} agentContext={agentContext} />;
}

type ProductionBoardPanelProps = ComponentProps<typeof LazyProductionBoardPanel>;
type ProductionRuntime = {
  readonly store: BrowserProductionRunStore;
  readonly runner: typeof WorkflowRunner;
  readonly handlers: typeof FirstPartyHandlers;
};

function ProductionBoardPanelGate({
  loadRuntime,
  ...props
}: Omit<ProductionBoardPanelProps, 'store'> & {
  readonly loadRuntime: () => Promise<ProductionRuntime>;
}) {
  const [runtime, setRuntime] = useState<ProductionRuntime>();
  useEffect(() => {
    let cancelled = false;
    void loadRuntime().then((next) => {
      if (!cancelled) setRuntime(next);
    });
    return () => {
      cancelled = true;
    };
  }, [loadRuntime]);
  if (runtime === undefined) {
    return (
      <section className="panel-loading" role="status" aria-label="Loading Production">
        Loading Production…
      </section>
    );
  }
  return <LazyProductionBoardPanel {...props} store={runtime.store} />;
}

function PluginsPanelGate({
  loadPluginHost,
  onChange,
}: {
  readonly loadPluginHost: () => Promise<EditorPluginHost>;
  readonly onChange: () => void;
}) {
  const [pluginHost, setPluginHost] = useState<EditorPluginHost>();
  useEffect(() => {
    let cancelled = false;
    void loadPluginHost().then((next) => {
      if (!cancelled) setPluginHost(next);
    });
    return () => {
      cancelled = true;
    };
  }, [loadPluginHost]);
  if (pluginHost === undefined) {
    return (
      <section className="panel-loading" role="status" aria-label="Loading Plugins">
        Loading Plugins…
      </section>
    );
  }
  return <LazyPluginsPanel pluginHost={pluginHost} onChange={onChange} />;
}

const CLIP_FRAME_CACHE_LIMIT = 120;
const BROWSER_MP4_MIME_TYPE = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';
import type { HtmlSceneSurfaceCache } from './html-scene-surfaces.js';
import type { MotionSceneSurfaceCache } from './motion-scene-surfaces.js';

import type { BrowserPixiRenderer } from '@joy-media/renderer-pixi/browser';
import type {
  BrowserExportManifest,
  BrowserExportResult,
} from '@joy-media/renderer-pixi/browser-export';
import { EMPTY_EDITOR_STATE, searchActions } from './editor-state.js';
import { EditorSession } from './editor-session.js';
import {
  buildTimelineFileImportTransactions,
  buildTimelineAssetInsertTransaction,
  importAssetKind,
  TimelinePanel,
} from './TimelinePanel.js';
import { buildDualLensProjection, type DualLensProjection } from './dual-lens-model.js';
import {
  primaryNodeIdForClip,
  provenanceRibbon,
  type LensRevealRequest,
} from './dual-lens-reveal.js';
import { buildDataLanes, type DataLane } from './data-lanes.js';
import { useAccessibleDialog } from './dialog-a11y.js';
import {
  clearActiveProjectId,
  getCatalogProject,
  loadActiveProjectId,
  saveActiveProjectId,
  TIMELINE_LOG_KEY,
  VISUAL_LOG_KEY,
  upsertCatalogProject,
  type ProjectCatalogEntry,
} from './project-catalog.js';
import { createBlankProjectDocuments, seedsForCatalogEntry } from './project-factory.js';
import { buildMotionScenePlacementPlan } from './motion-studio/motionScenePlacement.js';
import {
  type BrowserAsset,
  type BrowserAssetRegistration,
  type BrowserDerivative,
  type BrowserWorker,
} from './control-plane-client.js';
import { BrowserControlPlaneError } from './control-plane-errors.js';
import { createDeferredControlPlaneClient } from './deferred-control-plane-client.js';
import { bindClipToObject, resolveObjectIdForSelection } from './sticker-bindings.js';
import { isSingleVideoClipSelected } from './effects-apply-state.js';
import { StickerImageCache } from './sticker-image-cache.js';
import {
  htmlSceneCaptureTargetsForRequirements,
  plannedMotionSceneCaptureTargets,
  plannedStillBitmapTargets,
} from './render-plan-capture-targets.js';
import { openOpfsOriginalAssetCache } from './opfs-original-asset-cache.js';
import { openOpfsDerivativeCache } from './opfs-asset-cache.js';
import { createMediaSessionPlayableAssetResolver } from './media-session.js';
import {
  MonitorMediaElementBinding,
  disposeInactiveMonitorPlayback,
  monitorVideoClipSpecToken,
  releaseMonitorMediaSources,
  resolveReadyMonitorMediaSources,
  resolveMonitorMediaSource,
  type MonitorMediaSource,
} from './monitor-media-source.js';
import {
  EMPTY_AUDIO_STATE,
  ensureClipAudio,
  loadAudioState,
  saveAudioState,
  withProjectAudio,
} from './audio-session.js';
import type { AudioState } from '@joy-media/commands';
import { buildMixerBuffer } from './mixer-buffer.js';
import type {
  ExportPresetId,
  WorkflowGraphV2,
  ProjectDocumentV2,
  JsonValue,
} from '@joy-media/project-schema';
import type {
  AgentPanelCommand,
  AgentPanelCommandType,
  KiloCodeAttachedAsset,
} from './AgentPanel.js';
import { loadAgentSettings, saveAgentSettings } from './agent-settings-storage.js';
import type { AgentSettings } from './agent-settings-types.js';
import type { EditorPluginHost } from './plugin-host.js';
import { createAgentCommandBus } from './agent-command-bus.js';
import type * as WorkflowRunner from './workflow-runner.js';
import type * as FirstPartyHandlers from './first-party-handlers.js';
import type { BrowserProductionRunStore } from './browser-production-run-store.js';
import {
  getOrCreateControlPlaneProjectBinding,
  type ControlPlaneProjectBinding,
} from './project-control-plane-local.js';
import type { ProjectDocumentLegacyBackup } from './project-document-browser-journal.js';
import type { ProjectDocumentSpineFailure } from './project-document-spine.js';
import type {
  ProjectDocumentRecoveredCopy,
  ProjectDocumentSyncCoordinator,
} from './project-document-sync-coordinator.js';
import type { ProjectDocumentBrowserJournal } from './project-document-browser-journal.js';
import {
  classifyProjectDocumentSyncFailure,
  type ProjectDocumentSyncFailure,
} from './project-document-sync-diagnostics.js';
import {
  prepareCaptionTranscriptionSource,
  selectedOrCurrentTranscriptionCandidate,
  type CaptionTranscriptionAvailability,
  type CaptionTranscriptionSource,
  type CaptionTranscriptionTarget,
} from './local-transcription.js';
import { DeliveryBlockedStatus } from './DeliveryBlockedStatus.js';
import { RecoveredCopyStatus } from './RecoveredCopyStatus.js';
import { DEFAULT_WORKSPACE } from './workspace.js';
import {
  DOCK_LAYOUT_KEY,
  DOCK_PANEL_MINIMUM_HEIGHT,
  DOCK_PANEL_MINIMUM_WIDTH,
  SUPERSEDED_DOCK_LAYOUT_KEYS,
  type EditorViewMode,
  dockLayoutKey,
  loadViewMode,
  migrateLegacyDockLayout,
  normalizeDockLayoutConstraints,
  saveViewMode,
  seedDockLayout,
} from './dock-layout.js';
import { panelLabel, panelTabIconUrl } from './panel-tab-icons.js';
import { PanelShell } from './PanelShell.js';
import { isEditableTarget, resolveShortcut } from './keyboard-shortcuts.js';
import {
  CloseIcon,
  CommandIcon,
  DownloadIcon,
  ExportIcon,
  FullscreenIcon,
  HighBitrateIcon,
  LogoutIcon,
  PauseIcon,
  PlayIcon,
  PngMaskIcon,
  RedoIcon,
  ReelsIcon,
  SkipBackIcon,
  SkipForwardIcon,
  UndoIcon,
  UserIcon,
  VerticalViewIcon,
  WideViewIcon,
  YoutubeIcon,
  ZoomInIcon,
} from './icons.js';
import { logoutJoySession, probeJoySession, type JoySessionState } from './identity.js';
import {
  deliveryGate,
  loadExportHistory,
  recentProcessLabel,
  reconcileDeliveryInspections,
  saveExportHistory,
  upsertEntry,
  type ExportProcessEntry,
} from './export-history.js';

import { createMonoAudioBuffer } from './export-audio.js';
import { nextVideoClipAtOrAfter } from './timeline-playback.js';
import { useAuthLocked } from './LoginGate.js';
import {
  deliveryMediaStateFromEvidence,
  deliveryTimelineClipsFromProject,
  deliveryPreflight,
  type DeliveryCapability,
  type DeliveryMediaState,
  type DeliveryTimelineClip,
  type VerifiedRenderEnvelope,
} from './delivery-preflight.js';
import { workerPresence } from './jobs-panel-state.js';
import './app.css';
import 'dockview/dist/styles/dockview.css';
import { JOY_COLORS } from './theme.js';

const loadPlanRenderFrame = () =>
  import('../../../packages/render-planner/src/plan-frame.js').then(
    ({ planRenderFrame }) => planRenderFrame,
  );
type PlanRenderFrame = Awaited<ReturnType<typeof loadPlanRenderFrame>>;

const stickerImageCache = new StickerImageCache();
const originalAssetCachePromise = openOpfsOriginalAssetCache();

function userFacingDeliveryError(error: unknown, action: string): string {
  if (error instanceof BrowserControlPlaneError) {
    if (error.code === 'ARTIFACT_NOT_FOUND' || error.code === 'ARTIFACT_UNAVAILABLE')
      return `${action} is waiting for a retained render artifact. Please retry.`;
    if (error.code === 'WORKER_UNAVAILABLE' || error.code === 'WORKER_SESSION_REQUIRED')
      return `${action} needs an available paired worker.`;
    if (error.code === 'RESULT_INVALID')
      return `${action} returned invalid verification evidence. Please retry.`;
  }
  return `${action} could not be completed. Please try again.`;
}

async function loadStickerAssetBlob(assetId: string): Promise<Blob | undefined> {
  const cache = await originalAssetCachePromise;
  return cache.get(assetId);
}

function imageSizesFromCache(): Readonly<
  Record<string, { readonly width: number; readonly height: number }>
> {
  const sizes: Record<string, { width: number; height: number }> = {};
  for (const [id, bitmap] of stickerImageCache.bitmaps()) {
    sizes[id] = { width: bitmap.width, height: bitmap.height };
  }
  return sizes;
}

/** Check the old per-domain logs before EditorSession can seed a new project. */
function hasLegacyProjectData(storage: Storage, projectId: string): boolean {
  for (const key of [TIMELINE_LOG_KEY, VISUAL_LOG_KEY]) {
    try {
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const parsed = JSON.parse(raw) as {
        readonly projects?: Record<
          string,
          { readonly snapshots?: readonly unknown[]; readonly transactions?: readonly unknown[] }
        >;
      };
      const project = parsed.projects?.[projectId];
      if ((project?.snapshots?.length ?? 0) > 0 || (project?.transactions?.length ?? 0) > 0)
        return true;
    } catch {
      // A malformed legacy log is still not permission to migrate/overwrite;
      // the journal lifecycle will surface its own recoverable error.
    }
  }
  return false;
}

function opaqueRenderRef(value: string | undefined, fallback: string): string {
  const normalized = (value ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
  return /^[A-Za-z0-9]/.test(normalized) ? normalized : fallback;
}

async function syncStickerBitmapTargets(
  targets: ReturnType<typeof plannedStillBitmapTargets>,
): Promise<void> {
  const activeStickerIds = new Set(targets.map((target) => target.objectId));
  stickerImageCache.clearMissing(activeStickerIds);
  await Promise.all(
    targets.map((target) =>
      stickerImageCache.syncObject({
        objectId: target.objectId,
        assetId: target.assetId,
        ...(target.matteAssetId !== undefined ? { matteAssetId: target.matteAssetId } : {}),
        crop: target.crop,
        loadBlob: loadStickerAssetBlob,
      }),
    ),
  );
}

function activeVideoClipAt(project: SpikeProject, playheadUs: number) {
  const composition = project.compositions.root;
  return composition?.tracks
    .flatMap((track) => track.clips)
    .find(
      (clip) =>
        clip.kind === 'video' &&
        playheadUs >= clip.startUs &&
        playheadUs < clip.startUs + clip.durationUs,
    );
}

function videoClipSpec(clip: VideoClip): VideoClipSpec {
  return {
    // IR / bitmap map key — must match TransitionV1 left/right clip ids.
    id: clip.id,
    originalToken: monitorVideoClipSpecToken(clip),
    startUs: clip.startUs,
    durationUs: clip.durationUs,
    sourceInUs: clip.sourceInUs,
    transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
    opacity: 1,
    zIndex: 0,
  };
}

function findVideoClipById(project: SpikeProject, clipId: string): VideoClip | undefined {
  const clip = project.compositions.root?.tracks
    .flatMap((track) => track.clips)
    .find((item) => item.id === clipId);
  return clip?.kind === 'video' ? clip : undefined;
}

/** Source media time → composition playhead (freeze holds last mapped start). */
function playheadForSourceTime(
  clip: VideoClip,
  sourceTimeUs: number,
  freezePlayheadUs: number,
): number {
  const rate = normalizePlaybackRate(clip.playbackRate);
  if (rate === 0) return freezePlayheadUs;
  return clip.startUs + (sourceTimeUs - clip.sourceInUs) / rate;
}

function loadDetachedVideo(video: HTMLVideoElement, sourceUrl: string): Promise<void> {
  video.preload = 'auto';
  video.playsInline = true;
  video.muted = true;
  video.src = sourceUrl;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Unable to load export media ${sourceUrl}`));
    };
    video.addEventListener('loadeddata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.load();
  });
}

function seekDetachedVideo(video: HTMLVideoElement, timeUs: number): Promise<void> {
  const seconds = timeUs / 1_000_000;
  if (Math.abs(video.currentTime - seconds) < 0.001) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Unable to seek export media to ${seconds}s`));
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = seconds;
  });
}

interface EditorRuntimeState {
  readonly selectedIds: readonly string[];
  readonly playheadUs: number;
  readonly playing: boolean;
}

/** A decoded browser frame kept outside the serializable RenderFrameIR. */
interface DecodedPreviewFrame {
  readonly node: VideoFrameNode;
  readonly bitmap: ImageDataLike;
}

interface EditorPanelContextValue {
  readonly state: EditorRuntimeState;
  readonly previewVideoFrame: DecodedPreviewFrame | undefined;
  readonly monitorMediaStatus: MonitorMediaSource | undefined;
  /** Last decoded RGBA per timeline clip id (dual-texture transitions). */
  readonly clipFrameCache: ReadonlyMap<string, ImageDataLike>;
  readonly clipFrameTick: number;
  readonly timelineProject: SpikeProject;
  readonly visualProject: JoyProjectV1;
  readonly controlPlaneProject: ControlPlaneProjectBinding;
  readonly playback: PlaybackScheduler['metrics'];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly historyEntries: readonly HistoryEntry[];
  /**
   * ADR-0022: Time and Flow are two lenses on one document, so they read one
   * projection built here rather than each deriving its own.
   */
  readonly dualLensProjection: DualLensProjection;
  /** A pending `Reveal in Flow`, consumed by the Dual Lens panel. */
  readonly lensReveal: LensRevealRequest | undefined;
  readonly revealInFlow: (clipId: string) => void;
  readonly revealNodeInFlow: (nodeId: string) => void;
  readonly revealOnTimeline: (clipIds: readonly string[]) => void;
  /** The authored workflow graph — undefined unless the Dual Lens flag is on. */
  readonly workflowGraph: WorkflowGraphV2 | undefined;
  readonly dispatchGraph: (transaction: GraphTransaction) => void;
  /** Data lanes and their artifacts — undefined unless the flag is on. */
  readonly dataLanes: readonly DataLane[] | undefined;
  readonly artifacts: ArtifactStore | undefined;
  readonly dispatchArtifacts: (transaction: ArtifactTransaction) => void;
  readonly togglePlayback: () => void;
  readonly seek: (timeUs: number) => void;
  readonly toggleSelection: (id: string) => void;
  readonly selectClips: (clipIds: readonly string[]) => void;
  readonly clearSelection: () => void;
  readonly dispatchTimeline: (transaction: CommandTransaction) => void;
  readonly updateVisualProperty: (
    objectId: string,
    key: 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotationDeg' | 'opacity',
    value: number,
  ) => void;
  readonly dispatchProject: (transaction: VisualObjectTransaction) => void;
  readonly replaceVisualProject: (next: JoyProjectV1) => void;
  readonly addStickerFromAsset: (asset: {
    readonly assetId: string;
    readonly displayName?: string;
    readonly blob?: Blob;
  }) => Promise<void>;
  readonly addHtmlSceneToSelectedClip: (scenePackageId: string) => void;
  readonly addMotionSceneToSelectedClip: (motionSceneId: string) => void;
  readonly stickerTick: number;
  readonly audioState: AudioState;
  readonly setAudioState: (next: AudioState, label?: string) => void;
  readonly transcribe: (
    documentId: string,
    language: 'fa-IR' | 'en-US',
    source: CaptionTranscriptionSource,
    target: CaptionTranscriptionTarget,
  ) => Promise<void>;
  readonly transcriptionAvailability: CaptionTranscriptionAvailability;
  readonly transcriptionError: string | undefined;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly jumpToHistory: (sequence: number) => void;
  /**
   * Dockview keeps panel component instances alive, so panel-only runtime
   * bindings live in context rather than in a renderer closure.
   */
  readonly session: EditorSession;
  readonly activatePanel: (panelId: string) => void;
  readonly agentContext: EditorContext | undefined;
  readonly agentCommandBus: CommandDispatcher;
  readonly agentSettings: AgentSettings;
  readonly agentPanelCommand: AgentPanelCommand | undefined;
  readonly kiloCodeAttachedAssets: readonly KiloCodeAttachedAsset[];
  readonly attachKiloCodeAsset: (asset: KiloCodeAttachedAsset) => void;
  readonly detachKiloCodeAsset: (assetId: string) => void;
  readonly pluginHost: EditorPluginHost | undefined;
  readonly bumpProjectRevision: () => void;
  readonly bumpPluginRevision: () => void;
  readonly showToast: (message: string, kind: 'info' | 'success' | 'error') => void;
  readonly motionStudioOpen: boolean;
  readonly openMotionStudio: (sceneId: string) => void;
  readonly closeMotionStudio: () => void;
  readonly effectStudioOpen: boolean;
  readonly openEffectStudio: (recipeId: string, objectId?: string) => void;
  readonly closeEffectStudio: () => void;
  /** Shared Timeline + Dual Lens zoom/scroll viewport (must live in context — dockview caches Panel). */
  readonly timelineViewport: TimelineViewport;
  readonly onTimelineViewportChange: (next: TimelineViewport) => void;
  readonly timelineTrackFlags: readonly TimelineTrackView[];
  readonly onTimelineTrackFlagsChange: (next: readonly TimelineTrackView[]) => void;
  readonly timelineAutoFit: boolean;
  readonly onTimelineAutoFitChange: (next: boolean) => void;
}
export const EditorPanelContext = createContext<EditorPanelContextValue | undefined>(undefined);

export function App() {
  const storage = window.localStorage;
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    const id = loadActiveProjectId(storage);
    if (id === null) return null;
    if (getCatalogProject(storage, id) === undefined) {
      clearActiveProjectId(storage);
      return null;
    }
    return id;
  });

  const openProject = useCallback(
    (entry: ProjectCatalogEntry) => {
      const now = new Date().toISOString();
      upsertCatalogProject(storage, { ...entry, updatedAt: now });
      saveActiveProjectId(storage, entry.id);
      setActiveProjectId(entry.id);
    },
    [storage],
  );

  const createProject = useCallback(
    (title: string) => {
      const id =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `project-${Date.now()}`;
      const now = new Date().toISOString();
      const seeds = createBlankProjectDocuments(id, title, now);
      // Materialize durable empty docs via recover-or-initialize.
      new EditorSession(storage, seeds.timeline, seeds.visual);
      const entry: ProjectCatalogEntry = {
        id,
        title,
        createdAt: now,
        updatedAt: now,
        timelineProjectId: id,
        visualProjectId: id,
      };
      upsertCatalogProject(storage, entry);
      saveActiveProjectId(storage, id);
      setActiveProjectId(id);
    },
    [storage],
  );

  const openRecoveredCopy = useCallback(
    async (copy: ProjectDocumentRecoveredCopy, ownerKey: string) => {
      // The recovered document is loaded by EditorWorkspace's normal
      // authenticated bootstrap. This step only creates the local catalog
      // entry and records the server-selected project id without touching the
      // original project's local files or binding.
      if (ownerKey.trim().length === 0) return;
      const { createAndActivateRecoveredCopyProject } = await import('./recovered-copy-flow.js');
      const { entry } = createAndActivateRecoveredCopyProject(storage, copy, ownerKey);
      setActiveProjectId(entry.id);
    },
    [storage],
  );

  const backToLibrary = useCallback(() => {
    clearActiveProjectId(storage);
    setActiveProjectId(null);
  }, [storage]);

  if (activeProjectId === null) {
    return (
      <LazyPanel label="Project library">
        <LazyProjectLibrary storage={storage} onOpen={openProject} onCreate={createProject} />
      </LazyPanel>
    );
  }

  return (
    <EditorWorkspace
      key={activeProjectId}
      projectId={activeProjectId}
      onBackToLibrary={backToLibrary}
      onOpenRecoveredCopy={openRecoveredCopy}
    />
  );
}

function EditorWorkspace({
  projectId,
  onBackToLibrary,
  onOpenRecoveredCopy,
}: {
  readonly projectId: string;
  readonly onBackToLibrary: () => void;
  readonly onOpenRecoveredCopy: (copy: ProjectDocumentRecoveredCopy, ownerKey: string) => void;
}) {
  const authLocked = useAuthLocked();
  const [state, setState] = useState<EditorRuntimeState>({ ...EMPTY_EDITOR_STATE, playing: false });
  /** Shared by Timeline + Dual Lens Time View so clip widths stay one layout. */
  const [timelineViewport, setTimelineViewport] = useState<TimelineViewport>({
    originUs: 0,
    pixelsPerSecond: 20,
  });
  const [timelineTrackFlags, setTimelineTrackFlags] = useState<readonly TimelineTrackView[]>([]);
  const [timelineAutoFit, setTimelineAutoFit] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [transcriptionError, setTranscriptionError] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | undefined>(undefined);
  const [exportProgress, setExportProgress] = useState<number | undefined>(undefined);
  const [exportHistory, setExportHistory] = useState<readonly ExportProcessEntry[]>(() =>
    loadExportHistory(window.localStorage),
  );
  const [exportPreset, setExportPreset] = useState<ExportPresetId>('reels-1080');
  const [audioState, setAudioStateRaw] = useState<AudioState>(() => loadAudioState(projectId));
  const audioStateRef = useRef(audioState);
  audioStateRef.current = audioState;
  const [processesOpen, setProcessesOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [exportPresetOpen, setExportPresetOpen] = useState(false);
  const [stickerTick, setStickerTick] = useState(0);
  const [kiloCodeAttachedAssets, setKiloCodeAttachedAssets] = useState<
    readonly KiloCodeAttachedAsset[]
  >([]);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(() =>
    loadAgentSettings(window.localStorage),
  );
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false);
  const [agentPanelCommand, setAgentPanelCommand] = useState<AgentPanelCommand>();
  const [joySession, setJoySession] = useState<JoySessionState>({ kind: 'unknown' });
  const joySessionRefreshSeqRef = useRef(0);
  const [toasts, setToasts] = useState<
    readonly { id: string; message: string; kind: 'info' | 'success' | 'error' }[]
  >([]);
  const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false);
  const shortcutsDialogRef = useRef<HTMLDivElement | null>(null);
  const [viewMode, setViewMode] = useState<EditorViewMode>(() => loadViewMode(window.localStorage));
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const paletteRef = useRef<HTMLElement | null>(null);
  const accountDropdownRef = useRef<HTMLElement | null>(null);
  const [motionStudioSceneId, setMotionStudioSceneId] = useState<string | undefined>(undefined);
  const [effectStudioSession, setEffectStudioSession] = useState<
    { readonly recipeId: string; readonly objectId?: string } | undefined
  >(undefined);
  useEffect(() => {
    return () => {
      stickerImageCache.clear();
      partnerMediaBindingRef.current.dispose(partnerVideoRef.current);
    };
  }, []);
  const lastExportRef = useRef<{ readonly entryId: string; readonly url: string } | null>(null);
  const exportToastTimerRef = useRef<number | undefined>(undefined);
  const toastTimersRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    return () => {
      window.clearTimeout(exportToastTimerRef.current);
      for (const timer of toastTimersRef.current.values()) window.clearTimeout(timer);
      toastTimersRef.current.clear();
    };
  }, []);
  useEffect(() => {
    saveAgentSettings(window.localStorage, agentSettings);
  }, [agentSettings]);
  const [previewVideoFrame, setPreviewVideoFrame] = useState<DecodedPreviewFrame | undefined>(
    undefined,
  );
  const [monitorMediaStatus, setMonitorMediaStatus] = useState<MonitorMediaSource | undefined>(
    undefined,
  );
  const [, setRevision] = useState(0);
  const [, setPluginRevision] = useState(0);
  const sessionRef = useRef<EditorSession | null>(null);
  // Recovery/hydration may replace the opening baseline. Mutating actions are
  // gated until that decision is complete so a click cannot be overwritten by
  // a later deferred hydrate.
  const hydrationReadyRef = useRef(false);
  const dockviewApiRef = useRef<DockviewApi | null>(null);
  const dockviewComponentsRef = useRef<{ readonly 'editor-panel': typeof Panel } | null>(null);
  const legacyStorageHadDataRef = useRef<boolean | undefined>(undefined);
  const scheduler = useRef(new PlaybackScheduler());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const decoderRef = useRef<HtmlMediaDecoder | null>(null);
  const clockRef = useRef<MediaClock | null>(null);
  /** Last decoded RGBA per timeline clip id — feeds dual-texture transitions. */
  const clipFrameCacheRef = useRef<Map<string, ImageDataLike>>(new Map());
  const verifiedDeliverySnapshotCacheRef = useRef(new Map<string, RenderBundleV2>());
  const [clipFrameTick, setClipFrameTick] = useState(0);
  const partnerVideoRef = useRef<HTMLVideoElement | null>(null);
  const partnerDecoderRef = useRef<HtmlMediaDecoder | null>(null);
  const partnerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeMonitorClipIdRef = useRef<string | undefined>(undefined);
  const monitorMediaBindingRef = useRef(new MonitorMediaElementBinding());
  const partnerMediaBindingRef = useRef(new MonitorMediaElementBinding());
  const audioContextRef = useRef<AudioContext | null>(null);
  const previewAudioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const previewGainNodeRef = useRef<GainNode | null>(null);
  const previewPanNodeRef = useRef<StereoPannerNode | null>(null);
  const mediaClient = useMemo(() => createDeferredControlPlaneClient(), []);
  const [monitorAssetCatalog, setMonitorAssetCatalog] = useState<{
    readonly assets: Readonly<Record<string, BrowserAsset>>;
    readonly derivativesByAssetId: Readonly<Record<string, readonly BrowserDerivative[]>>;
  }>(() => ({ assets: {}, derivativesByAssetId: {} }));
  const [deliveryWorkers, setDeliveryWorkers] = useState<readonly BrowserWorker[]>([]);
  const [documentSyncState, setDocumentSyncState] = useState<
    'local' | 'syncing' | 'server-unavailable' | 'conflict-recovered'
  >('local');
  const [documentSyncFailure, setDocumentSyncFailure] = useState<ProjectDocumentSyncFailure>();
  const [recoveredCopy, setRecoveredCopy] = useState<ProjectDocumentRecoveredCopy>();
  const [legacyBackupAvailable, setLegacyBackupAvailable] = useState(false);
  const legacyBackupJournalRef = useRef<ProjectDocumentBrowserJournal | null>(null);

  useAccessibleDialog({
    open: keyboardShortcutsOpen,
    containerRef: shortcutsDialogRef,
    onClose: () => setKeyboardShortcutsOpen(false),
    initialFocusSelector: 'button[aria-label="Close shortcuts"]',
  });
  const playableAssetResolver = useMemo(
    () =>
      Promise.all([originalAssetCachePromise, openOpfsDerivativeCache()]).then(
        ([originalCache, derivativeCache]) =>
          createMediaSessionPlayableAssetResolver({
            originalCache,
            derivativeCache,
            fetchDerivative: ({ projectId: requestedProjectId, assetId, derivative }) =>
              mediaClient.derivativeBytes(requestedProjectId, assetId, derivative.derivativeId),
          }),
      ),
    [mediaClient],
  );

  const ensurePreviewAudioGraph = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (audioContextRef.current === null) {
      audioContextRef.current = new AudioContext();
    }
    const audioContext = audioContextRef.current;
    if (previewAudioSourceRef.current === null) {
      previewAudioSourceRef.current = audioContext.createMediaElementSource(video);
      previewGainNodeRef.current = audioContext.createGain();
      previewPanNodeRef.current = audioContext.createStereoPanner();
      previewAudioSourceRef.current
        .connect(previewGainNodeRef.current)
        .connect(previewPanNodeRef.current)
        .connect(audioContext.destination);
    }
  }, []);

  // Sync live preview mixer to audioState (mute/solo/gain/pan) — P14.1
  useEffect(() => {
    ensurePreviewAudioGraph();
    const gainNode = previewGainNodeRef.current;
    const panNode = previewPanNodeRef.current;
    if (!gainNode || !panNode) return;

    // Master gain from master bus
    const masterBus = audioState.buses.find((b) => b.id === 'master') ?? audioState.buses[0];
    if (masterBus) {
      gainNode.gain.value = masterBus.mute ? 0 : masterBus.gain;
      panNode.pan.value = masterBus.pan;
    }
  }, [audioState, ensurePreviewAudioGraph]);

  if (sessionRef.current === null) {
    const entry = getCatalogProject(window.localStorage, projectId);
    if (entry === undefined) throw new Error(`unknown project "${projectId}"`);
    legacyStorageHadDataRef.current = hasLegacyProjectData(window.localStorage, projectId);
    const seeds = seedsForCatalogEntry(entry);
    sessionRef.current = new EditorSession(window.localStorage, seeds.timeline, seeds.visual);
  }
  const session = sessionRef.current;
  const ensureHydrationReady = useCallback(() => {
    return hydrationReadyRef.current;
  }, []);
  const controlPlaneOwnerKey =
    joySession.kind === 'ready' ? (joySession.subject ?? 'signed-in') : undefined;
  const controlPlaneProject = useMemo(
    () =>
      getOrCreateControlPlaneProjectBinding(
        window.localStorage,
        session.visualProject,
        controlPlaneOwnerKey === undefined ? {} : { ownerKey: controlPlaneOwnerKey },
      ),
    [controlPlaneOwnerKey, session.visualProject.id, session.visualProject.title],
  );

  // The browser journal is the durable source for this lifecycle bridge. The
  // live EditorSession remains authoritative; the V2 document is a derived
  // projection attached exactly once for this opened project.
  useEffect(() => {
    let cancelled = false;
    let spine: ProjectDocumentSpine | undefined;
    let coordinator: ProjectDocumentSyncCoordinator | undefined;
    let unsubscribeCoordinator: (() => void) | undefined;
    const localCoordinator = {
      queueLocalDocument: (_document: ProjectDocumentV2) => undefined,
    };
    const reportFailure = (failure: ProjectDocumentSpineFailure) => {
      if (cancelled) return;
      if (failure.stage === 'remote-queue') {
        setDocumentSyncFailure(classifyProjectDocumentSyncFailure(failure.error));
        setDocumentSyncState('server-unavailable');
      } else {
        setDocumentSyncFailure(undefined);
        setDocumentSyncState('local');
      }
      if (failure.stage === 'remote-queue') {
        showToast(
          'Saved locally; cloud sync is unavailable. Your live project remains intact.',
          'info',
        );
      } else if (failure.stage === 'local-journal') {
        showToast('Project changes could not be saved to browser storage.', 'error');
      }
    };
    const attach = async () => {
      // Project-document recovery is post-shell hydration. Keep the journal,
      // spine, and migration implementation out of the initial editor entry;
      // EditorSession remains synchronous and authoritative while these load.
      const [
        { createProjectDocumentBrowserStorage },
        { ProjectDocumentBrowserJournal },
        { createProjectDocumentSpine },
        {
          recoverOrMigrateProjectDocument,
          shouldBootstrapFromRemoteAfterHydration,
          shouldBootstrapFromRemoteAfterOpening,
        },
      ] = await Promise.all([
        import('./project-document-browser-journal-storage.js'),
        import('./project-document-browser-journal.js'),
        import('./project-document-spine.js'),
        import('./project-document-lifecycle.js'),
      ]);
      if (cancelled) return;
      const storage = createProjectDocumentBrowserStorage({ kind: 'indexeddb' });
      const journal = new ProjectDocumentBrowserJournal(storage, projectId);
      legacyBackupJournalRef.current = journal;
      let queueCoordinator: {
        queueLocalDocument: (
          document: ProjectDocumentV2,
          options?: { label?: string; operationCount?: number },
        ) => void | Promise<void>;
      } = localCoordinator;
      let openingSaveAllowed = true;
      let localRecoveryBlockedByHydration = false;
      const openingJournal = {
        recover: () => journal.recover(),
        saveSnapshot: (document: ProjectDocumentV2, options?: unknown) =>
          journal.saveSnapshot(document, options as never),
        saveLegacyBackup: (backup: ProjectDocumentLegacyBackup) => journal.saveLegacyBackup(backup),
        hasLegacyBackup: () => journal.hasLegacyBackup(),
        loadLegacyBackup: () => journal.loadLegacyBackup(),
      };
      // Keep projection local-first even while authenticated bootstrap is in flight.
      const projectionSpine = createProjectDocumentSpine({
        session,
        journal,
        coordinator: localCoordinator,
        audioSidecar: () => audioStateRef.current as unknown as JsonValue,
        onFailure: reportFailure,
      });
      let hydratedFrom: 'local' | 'remote' | undefined;
      // A valid local V2 journal is authoritative. Only a genuinely absent
      // journal may trigger the one-time legacy migration; read/corruption/
      // quota failures must never fall through to an overwrite.
      const opening = await recoverOrMigrateProjectDocument({
        journal: openingJournal,
        projectId,
        legacyDomains:
          legacyStorageHadDataRef.current === true
            ? {
                project: session.visualProject,
                timeline: session.timelineProject,
                ...(audioStateRef.current === undefined ? {} : { audio: audioStateRef.current }),
                ...(session.graphEnabled
                  ? { workflow: session.workflowGraph, artifacts: session.artifacts }
                  : {}),
              }
            : null,
        markerStorage: window.localStorage,
      });
      // Recovery can span IndexedDB/OPFS awaits. The opener may have been
      // replaced while it was in flight; never hydrate that stale session (or
      // emit its opening toasts/state changes) after cleanup has cancelled it.
      if (cancelled) {
        projectionSpine.dispose();
        return;
      }
      if (opening.kind === 'local' || opening.kind === 'migrated') {
        const { planProjectDocumentHydration } = await import('./project-document-hydration.js');
        setLegacyBackupAvailable(opening.backupAvailable);
        if (opening.kind === 'local' && opening.backupError !== undefined)
          showToast('The local recovery backup could not be read.', 'info');
        const recovered = opening.kind === 'local' ? opening.recovery : undefined;
        const document = opening.kind === 'local' ? opening.recovery.document : opening.document;
        const hydration = planProjectDocumentHydration(document, projectId, {
          graphEnabled: session.graphEnabled,
        });
        if (hydration.ok) {
          session.hydrateProjectDocument(hydration.plan, 'Project hydrated from local V2');
          hydratedFrom = 'local';
          setRevision((revision) => revision + 1);
          const hydratedAudio = hydration.plan.audioStatePresent
            ? hydration.plan.audioState!
            : EMPTY_AUDIO_STATE;
          audioStateRef.current = hydratedAudio;
          setAudioStateRaw(hydratedAudio);
          saveAudioState(projectId, hydratedAudio);
          if (opening.kind === 'migrated') showToast('Legacy project migrated locally.', 'info');
          if (recovered?.recoveredWithWarnings)
            showToast('Recovered the latest valid local project document.', 'info');
        } else {
          openingSaveAllowed = false;
          localRecoveryBlockedByHydration = true;
          showToast(
            `Local V2 recovery was rejected: ${hydration.warnings[0] ?? 'invalid document'}`,
            'info',
          );
        }
      } else if (opening.kind === 'blocked') {
        openingSaveAllowed = false;
        showToast(
          'Local project storage needs attention; cloud recovery was skipped and the existing project was preserved.',
          'info',
        );
      }
      const localRecoveryBlocked =
        localRecoveryBlockedByHydration ||
        !shouldBootstrapFromRemoteAfterHydration(opening, !localRecoveryBlockedByHydration) ||
        !shouldBootstrapFromRemoteAfterOpening(opening);
      // A failed local read is fail-closed for this opening: do not let a
      // signed-in remote snapshot replace the legacy/live session underneath
      // a recoverable local-storage failure.
      if (joySession.kind === 'ready' && !localRecoveryBlocked) {
        const { bootstrapProjectDocument } = await import('./project-document-bootstrap.js');
        const bootstrap = await bootstrapProjectDocument({
          projectId: controlPlaneProject.controlPlaneProjectId,
          title: session.visualProject.title,
          remote: mediaClient,
          projectDocument: () => projectionSpine.projectDocument(),
        });
        if (cancelled) {
          projectionSpine.dispose();
          return;
        }
        if (bootstrap.kind === 'ready') {
          const remoteSnapshot = bootstrap.snapshot;
          if (cancelled) {
            projectionSpine.dispose();
            return;
          }
          if (hydratedFrom === undefined) {
            const { planProjectDocumentHydration } =
              await import('./project-document-hydration.js');
            const hydration = planProjectDocumentHydration(
              remoteSnapshot.document,
              controlPlaneProject.controlPlaneProjectId,
              { graphEnabled: session.graphEnabled, sessionProjectId: projectId },
            );
            if (hydration.ok) {
              session.hydrateProjectDocument(hydration.plan, 'Project hydrated from remote V2');
              hydratedFrom = 'remote';
              setRevision((revision) => revision + 1);
              const hydratedAudio = hydration.plan.audioStatePresent
                ? hydration.plan.audioState!
                : EMPTY_AUDIO_STATE;
              audioStateRef.current = hydratedAudio;
              setAudioStateRaw(hydratedAudio);
              saveAudioState(projectId, hydratedAudio);
            } else {
              showToast(
                `Remote V2 recovery was rejected: ${hydration.warnings[0] ?? 'invalid document'}`,
                'info',
              );
            }
          }
          const { ProjectDocumentSyncCoordinator: SyncCoordinator } =
            await import('./project-document-sync-coordinator.js');
          if (cancelled) {
            projectionSpine.dispose();
            return;
          }
          coordinator = new SyncCoordinator({
            initialSnapshot: remoteSnapshot,
            onFailure: (error) =>
              reportFailure({ stage: 'remote-queue', error, recoverable: true }),
            remote: {
              loadDocument: (id) => mediaClient.projectDocument(id),
              appendRevision: (id, input) => mediaClient.appendProjectRevision(id, input),
              restoreRevision: (id, input) => mediaClient.restoreProjectRevision(id, input),
              recoverStaleRevision: (input) =>
                mediaClient.recoverStaleRevision(input.projectId, {
                  baseRevision: input.baseRevision,
                  idempotencyKey: input.idempotencyKey,
                  suggestedName: input.suggestedName,
                  operation: input.operation,
                }),
            },
          });
          unsubscribeCoordinator = coordinator.subscribe((snapshot) => {
            if (cancelled) return;
            setDocumentSyncState(snapshot.state);
            if (snapshot.state !== 'server-unavailable') setDocumentSyncFailure(undefined);
            setRecoveredCopy(snapshot.lastRecoveredCopy);
          });
          // The browser creative id and control-plane record id are distinct.
          // Keep the local journal's envelope untouched, but route queued
          // remote documents under the authenticated API's project id.
          queueCoordinator = {
            queueLocalDocument: (document, options) =>
              coordinator!.queueLocalDocument(
                { ...document, projectId: controlPlaneProject.controlPlaneProjectId },
                options,
              ),
          };
        } else {
          if (!cancelled) {
            setDocumentSyncFailure({
              reason: bootstrap.reason,
              recoveryHint: bootstrap.recoveryHint,
            });
            setDocumentSyncState('server-unavailable');
            showToast(
              `Saved locally; cloud sync is unavailable. ${bootstrap.recoveryHint}`,
              'info',
            );
          }
        }
      }
      if (cancelled) {
        projectionSpine.dispose();
        unsubscribeCoordinator?.();
        coordinator?.dispose();
        return;
      }
      if (coordinator === undefined && (joySession.kind !== 'ready' || localRecoveryBlocked)) {
        setDocumentSyncFailure(undefined);
        setDocumentSyncState('local');
      }
      spine = createProjectDocumentSpine({
        session,
        journal,
        coordinator: queueCoordinator,
        audioSidecar: () => audioStateRef.current as unknown as JsonValue,
        onFailure: reportFailure,
      });
      spine.attach();
      hydrationReadyRef.current = true;
      // Persist the opening projection locally. A freshly seeded remote
      // snapshot is already the coordinator base; queueing it again would
      // create an unnecessary second revision.
      if (openingSaveAllowed && opening.kind !== 'migrated')
        try {
          await journal.saveSnapshot?.(spine.projectDocument(), {
            operationKind: 'editor-session.change',
            operationMetadata: {
              label:
                hydratedFrom === 'local'
                  ? 'Project opened (local V2 recovered)'
                  : hydratedFrom === 'remote'
                    ? 'Project opened (remote V2 recovered)'
                    : 'Project opened',
              operationCount: 1,
            },
          });
        } catch (error) {
          reportFailure({ stage: 'local-journal', error, recoverable: true });
        }
      projectionSpine.dispose();
    };
    void attach().catch((error: unknown) => {
      if (!cancelled) {
        hydrationReadyRef.current = true;
        const diagnostic = classifyProjectDocumentSyncFailure(error);
        setDocumentSyncFailure(diagnostic);
        setDocumentSyncState('local');
        showToast(`Project saved locally only. ${diagnostic.recoveryHint}`, 'info');
      }
    });
    return () => {
      cancelled = true;
      hydrationReadyRef.current = false;
      legacyBackupJournalRef.current = null;
      unsubscribeCoordinator?.();
      spine?.dispose();
      coordinator?.dispose();
    };
  }, [
    controlPlaneProject.controlPlaneProjectId,
    controlPlaneProject.title,
    joySession.kind,
    joySession.kind === 'ready' ? joySession.subject : undefined,
    mediaClient,
    projectId,
    session,
  ]);
  const workflowAuthority = useMemo<ProductionRunAuthority>(
    () => ({
      principalId:
        joySession.kind === 'ready' ? (joySession.subject ?? 'signed-in') : 'local-owner',
      role: 'owner',
      ...(joySession.kind === 'ready' && joySession.displayName !== undefined
        ? { displayName: joySession.displayName }
        : { displayName: 'Local owner' }),
    }),
    [joySession],
  );
  const workflowRuntimeLoader = useMemo(() => {
    let runtimePromise: Promise<ProductionRuntime> | undefined;
    return () => {
      runtimePromise ??= Promise.all([
        import('./browser-production-run-store.js'),
        import('./workflow-runner.js'),
        import('./first-party-handlers.js'),
      ]).then(([storeModule, runner, handlers]) => ({
        store: new storeModule.BrowserProductionRunStore(window.localStorage, {
          projectId: session.timelineProject.id,
          authority: workflowAuthority,
        }),
        runner,
        handlers,
      }));
      return runtimePromise;
    };
  }, [session.timelineProject.id, workflowAuthority]);
  const pluginHostLoader = useMemo(() => {
    let pluginHostPromise: Promise<EditorPluginHost> | undefined;
    return () => {
      pluginHostPromise ??= import('./plugin-host.js').then(({ createEditorPluginHost }) =>
        createEditorPluginHost(),
      );
      return pluginHostPromise;
    };
  }, []);
  useEffect(() => {
    if (joySession.kind !== 'ready') {
      setMonitorAssetCatalog({ assets: {}, derivativesByAssetId: {} });
      return;
    }
    let cancelled = false;
    void mediaClient
      .assets(controlPlaneProject.controlPlaneProjectId)
      .then(async (assets) => {
        const derivatives = await Promise.all(
          assets
            .filter((asset) => asset.kind === 'video' || asset.kind === 'audio')
            .map(async (asset) => {
              try {
                return [
                  asset.id,
                  await mediaClient.derivatives(
                    asset.projectId || controlPlaneProject.controlPlaneProjectId,
                    asset.id,
                  ),
                ] as const;
              } catch {
                return [asset.id, []] as const;
              }
            }),
        );
        if (cancelled) return;
        setMonitorAssetCatalog({
          assets: Object.fromEntries(assets.map((asset) => [asset.id, asset])),
          derivativesByAssetId: Object.fromEntries(derivatives),
        });
      })
      .catch(() => {
        if (cancelled) return;
        setMonitorAssetCatalog({ assets: {}, derivativesByAssetId: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [controlPlaneProject.controlPlaneProjectId, joySession.kind, mediaClient]);
  const transcriptionCandidate = useMemo(
    () =>
      selectedOrCurrentTranscriptionCandidate(
        session.timelineProject,
        state.selectedIds,
        state.playheadUs,
        monitorAssetCatalog.assets,
      ),
    [monitorAssetCatalog.assets, session.timelineProject, state.playheadUs, state.selectedIds],
  );
  const [preparedTranscription, setPreparedTranscription] =
    useState<CaptionTranscriptionAvailability>({
      state: 'unavailable',
      reason: 'Checking source media…',
    });
  useEffect(() => {
    let cancelled = false;
    if (transcriptionCandidate.state === 'unavailable') {
      setPreparedTranscription(transcriptionCandidate);
      return () => {
        cancelled = true;
      };
    }
    void prepareCaptionTranscriptionSource(transcriptionCandidate, loadStickerAssetBlob)
      .then((availability) => {
        if (!cancelled) setPreparedTranscription(availability);
      })
      .catch(() => {
        if (!cancelled) {
          setPreparedTranscription({
            state: 'unavailable',
            candidateKey: transcriptionCandidate.source.candidateKey,
            reason: 'Original media could not be read. Re-import the source and try again.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [transcriptionCandidate]);
  const transcriptionAvailability: CaptionTranscriptionAvailability =
    transcriptionCandidate.state === 'unavailable'
      ? transcriptionCandidate
      : preparedTranscription.state === 'ready' &&
          preparedTranscription.source.candidateKey === transcriptionCandidate.source.candidateKey
        ? preparedTranscription
        : preparedTranscription.state === 'unavailable' &&
            preparedTranscription.candidateKey === transcriptionCandidate.source.candidateKey
          ? preparedTranscription
          : {
              state: 'unavailable',
              candidateKey: transcriptionCandidate.source.candidateKey,
              reason: 'Checking source media…',
            };
  useEffect(() => {
    let cancelled = false;
    const refreshWorkers = (): void => {
      void mediaClient
        .workers()
        .then((workers) => {
          if (!cancelled) setDeliveryWorkers(workers);
        })
        .catch(() => {
          // A failed capability probe is intentionally treated as unavailable.
          if (!cancelled) setDeliveryWorkers([]);
        });
    };
    refreshWorkers();
    const interval = window.setInterval(refreshWorkers, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [mediaClient]);
  const agentCommandBusRef = useRef<ReturnType<typeof createAgentCommandBus> | null>(null);
  if (agentCommandBusRef.current === null)
    agentCommandBusRef.current = createAgentCommandBus(session, () =>
      setRevision((revision) => revision + 1),
    );
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastMediaTimeUsRef = useRef<number | undefined>(undefined);
  const freezeWallStartRef = useRef<{ wallMs: number; playheadUs: number } | undefined>(undefined);
  const playbackFrameRef = useRef<number | undefined>(undefined);

  const rememberClipFrame = useCallback((clipId: string, bitmap: ImageDataLike) => {
    const cache = clipFrameCacheRef.current;
    if (cache.has(clipId)) cache.delete(clipId);
    cache.set(clipId, bitmap);
    if (cache.size > CLIP_FRAME_CACHE_LIMIT) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest !== undefined) cache.delete(oldest);
    }
    setClipFrameTick((tick) => tick + 1);
  }, []);

  const resolveClipMonitorMediaSource = useCallback(
    async (clip: VideoClip | AudioClip): Promise<MonitorMediaSource> => {
      if (clip.assetId.startsWith('motion-scene:')) {
        return {
          state: 'unavailable',
          clipId: clip.id,
          assetId: clip.assetId,
          message:
            'Motion Studio scene media is not a browser video source; the published scene is hydrated as an RGBA surface and must be rendered by the Worker for delivery.',
          action: { kind: 'wait', label: 'Render scene media' },
        };
      }
      return resolveMonitorMediaSource({
        projectId: controlPlaneProject.controlPlaneProjectId,
        clip,
        asset:
          monitorAssetCatalog.assets[clip.assetId] ?? session.visualProject.assets[clip.assetId],
        derivatives: monitorAssetCatalog.derivativesByAssetId[clip.assetId] ?? [],
        resolver: await playableAssetResolver,
      });
    },
    [
      controlPlaneProject.controlPlaneProjectId,
      monitorAssetCatalog,
      playableAssetResolver,
      session,
    ],
  );

  const ensurePartnerDecoder = useCallback((): {
    video: HTMLVideoElement;
    decoder: HtmlMediaDecoder;
  } => {
    if (partnerVideoRef.current === null) {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      partnerVideoRef.current = video;
    }
    if (partnerCanvasRef.current === null) {
      const canvas = document.createElement('canvas');
      canvas.width = 0;
      canvas.height = 0;
      partnerCanvasRef.current = canvas;
    }
    if (partnerDecoderRef.current === null) {
      partnerDecoderRef.current = createHtmlMediaDecoder(
        partnerVideoRef.current,
        partnerCanvasRef.current,
      );
    }
    return { video: partnerVideoRef.current, decoder: partnerDecoderRef.current };
  }, []);

  const captureTransitionPartnerFrames = useCallback(
    async (playheadUs: number): Promise<void> => {
      const planRenderFrame = await loadPlanRenderFrame();
      const plan = planRenderFrame({
        bundle: createRenderBundle({
          timelineProject: session.timelineProject,
          visualProject: session.visualProject,
          seed: `preview:${session.visualProject.id}`,
        }),
        timeUs: playheadUs,
        imageSizesByObjectId: imageSizesFromCache(),
      });
      const partnerSamples = plan.videoSamples.filter((sample) => sample.role !== 'primary');
      if (partnerSamples.length === 0) {
        partnerMediaBindingRef.current.dispose(partnerVideoRef.current);
        return;
      }
      const { video, decoder } = ensurePartnerDecoder();
      for (const sample of partnerSamples) {
        const clip = findVideoClipById(session.timelineProject, sample.clipId);
        if (clip === undefined) continue;
        const source = await resolveClipMonitorMediaSource(clip);
        if (source.state !== 'ready') continue;
        const changed = partnerMediaBindingRef.current.apply(video, source);
        if (changed) {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              video.removeEventListener('loadeddata', onLoaded);
              video.removeEventListener('error', onError);
            };
            const onLoaded = () => {
              cleanup();
              resolve();
            };
            const onError = () => {
              cleanup();
              reject(new Error(`Unable to load transition partner ${clip.assetId}`));
            };
            video.addEventListener('loadeddata', onLoaded, { once: true });
            video.addEventListener('error', onError, { once: true });
          });
        }
        await seekDetachedVideo(video, sample.sourceTimeUs);
        const token = scheduler.current.requestToken();
        const frame = decoder.captureCurrentFrame(token);
        if (frame.bitmap !== undefined) rememberClipFrame(clip.id, frame.bitmap);
      }
    },
    [ensurePartnerDecoder, rememberClipFrame, resolveClipMonitorMediaSource, session],
  );

  const syncMediaToPlayhead = useCallback(
    async (playheadUs: number, play: boolean): Promise<boolean> => {
      const planRenderFrame = await loadPlanRenderFrame();
      const video = videoRef.current;
      const clock = clockRef.current;
      const decoder = decoderRef.current;
      const composition = session.timelineProject.compositions.root;
      const plan = planRenderFrame({
        bundle: createRenderBundle({
          timelineProject: session.timelineProject,
          visualProject: session.visualProject,
          seed: `preview:${session.visualProject.id}`,
        }),
        timeUs: playheadUs,
        imageSizesByObjectId: imageSizesFromCache(),
      });
      const primarySample =
        plan.videoSamples.find((sample) => sample.role === 'primary') ?? plan.videoSamples[0];
      const clip =
        primarySample === undefined
          ? undefined
          : findVideoClipById(session.timelineProject, primarySample.clipId);
      if (
        video === null ||
        clock === null ||
        composition === undefined ||
        clip === undefined ||
        clip.kind !== 'video' ||
        primarySample === undefined
      ) {
        disposeInactiveMonitorPlayback({
          video,
          binding: monitorMediaBindingRef.current,
          clearActiveClipId: () => {
            activeMonitorClipIdRef.current = undefined;
          },
          clearPreviewFrame: () => setPreviewVideoFrame(undefined),
          clearStatus: () => setMonitorMediaStatus(undefined),
        });
        return false;
      }
      const source = await resolveClipMonitorMediaSource(clip);
      setMonitorMediaStatus(source);
      if (source.state !== 'ready') {
        monitorMediaBindingRef.current.dispose(video);
        activeMonitorClipIdRef.current = undefined;
        return false;
      }
      const changed = monitorMediaBindingRef.current.apply(video, source);
      activeMonitorClipIdRef.current = clip.id;
      if (changed) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            video.removeEventListener('loadeddata', onLoaded);
            video.removeEventListener('error', onError);
          };
          const onLoaded = () => {
            cleanup();
            resolve();
          };
          const onError = () => {
            cleanup();
            reject(new Error(`Unable to load ${clip.assetId} for live playback`));
          };
          video.addEventListener('loadeddata', onLoaded, { once: true });
          video.addEventListener('error', onError, { once: true });
        });
      }
      const rate = normalizePlaybackRate(clip.playbackRate);
      const sourceTimeUs = primarySample.sourceTimeUs;
      video.currentTime = sourceTimeUs / 1_000_000;
      video.playbackRate = rate === 0 ? 1 : rate;
      scheduler.current.seek(sourceTimeUs);
      lastMediaTimeUsRef.current = undefined;
      if (play) {
        video.muted = false;
        if (rate === 0) {
          video.pause();
          freezeWallStartRef.current = {
            wallMs: performance.now(),
            playheadUs,
          };
        } else {
          freezeWallStartRef.current = undefined;
          await video.play();
        }
      } else {
        freezeWallStartRef.current = undefined;
        video.pause();
        await seekDetachedVideo(video, sourceTimeUs);
        if (decoder !== null) {
          const token = scheduler.current.requestToken();
          const frame = decoder.captureCurrentFrame(token);
          if (frame.bitmap !== undefined) {
            const node = videoFrameNodeFromDecoded(videoClipSpec(clip), frame, {
              width: video.videoWidth,
              height: video.videoHeight,
            });
            rememberClipFrame(clip.id, frame.bitmap);
            setPreviewVideoFrame({ node, bitmap: frame.bitmap });
          }
        }
        await captureTransitionPartnerFrames(playheadUs).catch(() => undefined);
      }
      return true;
    },
    [captureTransitionPartnerFrames, rememberClipFrame, resolveClipMonitorMediaSource, session],
  );

  const seek = useCallback(
    (timeUs: number) => {
      scheduler.current.seek(timeUs);
      lastMediaTimeUsRef.current = undefined;
      setState((current) => ({ ...current, playheadUs: timeUs }));
      void syncMediaToPlayhead(timeUs, stateRef.current.playing).catch(() => {
        setState((current) => ({ ...current, playing: false }));
      });
    },
    [syncMediaToPlayhead],
  );
  useEffect(() => {
    if (!state.playing) return;
    const video = videoRef.current;
    const decoder = decoderRef.current;
    const clock = clockRef.current;
    if (video === null || decoder === null || clock === null) return;
    let cancelled = false;
    const capture = (): void => {
      if (cancelled || !stateRef.current.playing) return;
      const clip =
        (activeMonitorClipIdRef.current === undefined
          ? undefined
          : findVideoClipById(session.timelineProject, activeMonitorClipIdRef.current)) ??
        activeVideoClipAt(session.timelineProject, stateRef.current.playheadUs);
      if (clip === undefined || clip.kind !== 'video') return;
      const rate = normalizePlaybackRate(clip.playbackRate);
      let compositionTimeUs: number;
      let sourceTimeUs: number;
      if (rate === 0) {
        const freeze = freezeWallStartRef.current;
        if (freeze === undefined) {
          freezeWallStartRef.current = {
            wallMs: performance.now(),
            playheadUs: stateRef.current.playheadUs,
          };
          compositionTimeUs = stateRef.current.playheadUs;
        } else {
          compositionTimeUs =
            freeze.playheadUs + Math.floor((performance.now() - freeze.wallMs) * 1_000);
        }
        sourceTimeUs = clip.sourceInUs;
      } else {
        sourceTimeUs = clock.timeUs;
        compositionTimeUs = playheadForSourceTime(clip, sourceTimeUs, stateRef.current.playheadUs);
      }
      if (compositionTimeUs >= clip.startUs + clip.durationUs) {
        const clipEndUs = clip.startUs + clip.durationUs;
        const durationUs = session.timelineProject.compositions.root?.durationUs ?? clipEndUs;
        // Advance to the next video clip on the timeline, skipping any gap.
        // The old code always synced to `clipEndUs`, which is in a gap when the
        // clips are not contiguous — syncMediaToPlayhead returns false there,
        // so playback silently stopped after the first clip.
        const nextClip = nextVideoClipAtOrAfter(session.timelineProject, clipEndUs);
        const nextPlayheadUs =
          nextClip === undefined ? clipEndUs : Math.max(clipEndUs, nextClip.startUs);
        if (nextClip === undefined) {
          video.pause();
          freezeWallStartRef.current = undefined;
          setState((active) => ({ ...active, playheadUs: durationUs, playing: false }));
          setRevision((revision) => revision + 1);
          return;
        }
        void syncMediaToPlayhead(nextPlayheadUs, true).then((ready) => {
          if (ready && !cancelled) requestFrame();
        });
        return;
      }
      const token = scheduler.current.requestToken();
      const frame = decoder.captureCurrentFrame(token);
      const clipSpec = videoClipSpec(clip);
      const node = videoFrameNodeFromDecoded(clipSpec, frame, {
        width: video.videoWidth,
        height: video.videoHeight,
      });
      if (frame.bitmap === undefined) scheduler.current.recordDecodedFrame(token, false, false);
      else {
        rememberClipFrame(clip.id, frame.bitmap);
        setPreviewVideoFrame({ node, bitmap: frame.bitmap });
        const previous = lastMediaTimeUsRef.current;
        if (previous === undefined) scheduler.current.recordDecodedFrame(token, true, true);
        else scheduler.current.driveTick(clock, true, Math.max(1, sourceTimeUs - previous));
        void captureTransitionPartnerFrames(compositionTimeUs).catch(() => undefined);
      }
      lastMediaTimeUsRef.current = sourceTimeUs;
      setState((active) => ({ ...active, playheadUs: compositionTimeUs }));
      setRevision((revision) => revision + 1);
      requestFrame();
    };
    const requestFrame = (): void => {
      // Freeze holds a still frame — drive with rAF. Otherwise follow media cadence.
      const clip =
        (activeMonitorClipIdRef.current === undefined
          ? undefined
          : findVideoClipById(session.timelineProject, activeMonitorClipIdRef.current)) ??
        activeVideoClipAt(session.timelineProject, stateRef.current.playheadUs);
      const freeze = clip?.kind === 'video' && normalizePlaybackRate(clip.playbackRate) === 0;
      if (!freeze && typeof video.requestVideoFrameCallback === 'function')
        playbackFrameRef.current = video.requestVideoFrameCallback(() => capture());
      else playbackFrameRef.current = window.requestAnimationFrame(capture);
    };
    requestFrame();
    return () => {
      cancelled = true;
      if (playbackFrameRef.current !== undefined) {
        if (typeof video.cancelVideoFrameCallback === 'function')
          video.cancelVideoFrameCallback(playbackFrameRef.current);
        else window.cancelAnimationFrame(playbackFrameRef.current);
      }
    };
  }, [
    captureTransitionPartnerFrames,
    rememberClipFrame,
    session,
    state.playing,
    syncMediaToPlayhead,
  ]);
  const handleMediaReady = useCallback((decoder: HtmlMediaDecoder, clock: MediaClock) => {
    decoderRef.current = decoder;
    clockRef.current = clock;
  }, []);
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    let cancelled = false;
    const captureCanvas = document.createElement('canvas');
    // A zero-sized canvas asks the decoder to size it to the decoded media on
    // first use; this avoids treating the DOM default 300×150 as a proxy size.
    captureCanvas.width = 0;
    captureCanvas.height = 0;
    const decoder = createHtmlMediaDecoder(video, captureCanvas);
    handleMediaReady(decoder, createHtmlVideoMediaClock(video));
    const firstClip = activeVideoClipAt(session.timelineProject, 0);
    if (firstClip !== undefined && firstClip.kind === 'video') {
      void resolveClipMonitorMediaSource(firstClip).then((source) => {
        if (cancelled) {
          if (source.state === 'ready') source.release();
          return;
        }
        setMonitorMediaStatus(source);
        monitorMediaBindingRef.current.apply(video, source);
        activeMonitorClipIdRef.current = source.state === 'ready' ? firstClip.id : undefined;
      });
    }
    return () => {
      cancelled = true;
      video.pause();
      decoderRef.current = null;
      clockRef.current = null;
      activeMonitorClipIdRef.current = undefined;
      monitorMediaBindingRef.current.dispose(video);
    };
  }, [handleMediaReady, resolveClipMonitorMediaSource, session]);
  const togglePlayback = useCallback(() => {
    const current = stateRef.current;
    if (current.playing) {
      videoRef.current?.pause();
      setState((active) => ({ ...active, playing: false }));
      return;
    }
    ensurePreviewAudioGraph();
    void syncMediaToPlayhead(current.playheadUs, true)
      .then((ready) => setState((active) => ({ ...active, playing: ready })))
      .catch(() => setState((active) => ({ ...active, playing: false })));
  }, [syncMediaToPlayhead]);
  const dispatchTimeline = useCallback(
    (transaction: CommandTransaction) => {
      if (!ensureHydrationReady()) return;
      session.dispatchTimeline(transaction);
      setRevision((revision) => revision + 1);
    },
    [ensureHydrationReady, session],
  );
  const dispatchGraph = useCallback(
    (transaction: GraphTransaction) => {
      if (!ensureHydrationReady()) return;
      session.dispatchGraph(transaction);
      setRevision((revision) => revision + 1);
    },
    [ensureHydrationReady, session],
  );
  const dispatchArtifacts = useCallback(
    (transaction: ArtifactTransaction) => {
      if (!ensureHydrationReady()) return;
      session.dispatchArtifacts(transaction);
      setRevision((revision) => revision + 1);
    },
    [ensureHydrationReady, session],
  );
  // Recomputed per render rather than memoized: the session exposes stable
  // references and signals change through `setRevision`, so a memo keyed on
  // those references would go stale. It walks artifacts and nodes once.
  const dataLanes = session.graphEnabled
    ? buildDataLanes({
        artifacts: session.artifacts,
        graph: session.workflowGraph,
        creative: session.visualProject,
      })
    : undefined;
  const updateVisualProperty = useCallback(
    (
      objectId: string,
      key: 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotationDeg' | 'opacity',
      value: number,
    ) => {
      if (!ensureHydrationReady()) return;
      const transaction: VisualObjectTransaction = {
        label: `Set ${key}`,
        commands: [{ type: 'object.setTransformProperty', payload: { objectId, key, value } }],
      };
      session.dispatchVisualObjects(transaction);
      setRevision((revision) => revision + 1);
    },
    [ensureHydrationReady, session],
  );
  const dispatchProject = useCallback(
    (transaction: VisualObjectTransaction) => {
      if (!ensureHydrationReady()) return;
      session.dispatchVisualObjects(transaction);
      setRevision((revision) => revision + 1);
    },
    [ensureHydrationReady, session],
  );

  const replaceVisualProject = useCallback(
    (next: JoyProjectV1) => {
      if (!ensureHydrationReady()) return;
      session.replaceVisualProject(next);
      setRevision((revision) => revision + 1);
    },
    [ensureHydrationReady, session],
  );

  const syncStickerBitmaps = useCallback(async () => {
    const planRenderFrame = await loadPlanRenderFrame();
    const plan = planRenderFrame({
      bundle: createRenderBundle({
        timelineProject: session.timelineProject,
        visualProject: session.visualProject,
        seed: `preview:${session.visualProject.id}`,
      }),
      timeUs: state.playheadUs,
    });
    await syncStickerBitmapTargets(
      plannedStillBitmapTargets(session.visualProject, plan.captureRequirements),
    );
    setStickerTick((tick) => tick + 1);
  }, [session, state.playheadUs]);

  const addStickerFromAsset = useCallback(
    async (asset: {
      readonly assetId: string;
      readonly displayName?: string;
      readonly blob?: Blob;
    }) => {
      if (!ensureHydrationReady()) return;
      if (asset.blob !== undefined) stickerImageCache.rememberBlob(asset.assetId, asset.blob);
      const objectId = `sticker-${asset.assetId}-${Date.now().toString(36)}`;
      const clipId = `clip-${objectId}`;
      const composition = session.timelineProject.compositions.root;
      if (composition === undefined) return;
      const track =
        composition.tracks.find((item) => item.kind === 'video' && item.enabled) ??
        composition.tracks[0];
      if (track === undefined) return;
      const durationUs = 5_000_000;
      let startUs = 0;
      const sorted = [...track.clips].sort((a, b) => a.startUs - b.startUs);
      for (const existing of sorted) {
        const end = existing.startUs + existing.durationUs;
        if (startUs < end && startUs + durationUs > existing.startUs) startUs = end;
      }
      const stickerCount = Object.values(session.visualProject.visualObjects).filter(
        (item) => item.kind === 'image',
      ).length;
      session.dispatchVisualObjects({
        label: `Add sticker ${asset.displayName ?? asset.assetId}`,
        commands: [
          {
            type: 'image.create',
            payload: {
              object: {
                id: objectId,
                kind: 'image',
                assetId: asset.assetId,
                transform: {
                  x: 120 + stickerCount * 40,
                  y: 120 + stickerCount * 40,
                  scaleX: 1,
                  scaleY: 1,
                  rotationDeg: 0,
                  opacity: 1,
                  crop: { left: 0, top: 0, right: 0, bottom: 0 },
                },
              },
            },
          },
        ],
      });
      session.dispatchTimeline({
        label: `Place sticker ${asset.displayName ?? asset.assetId}`,
        commands: [
          {
            type: 'timeline.insertClip',
            payload: {
              compositionId: composition.id,
              trackId: track.id,
              clip: {
                id: clipId,
                kind: 'video',
                assetId: asset.assetId,
                startUs,
                durationUs,
                sourceInUs: 0,
              },
            },
          },
        ],
      });
      session.replaceVisualProject(bindClipToObject(session.visualProject, clipId, objectId));
      await syncStickerBitmaps();
      setState((current) => ({ ...current, selectedIds: [clipId] }));
      setRevision((revision) => revision + 1);
    },
    [ensureHydrationReady, session, syncStickerBitmaps],
  );

  const addHtmlSceneToSelectedClip = useCallback(
    (scenePackageId: string) => {
      if (!ensureHydrationReady()) return;
      const composition = session.timelineProject.compositions.root;
      if (composition === undefined) return;
      const selectedClipId = state.selectedIds[0];
      if (selectedClipId === undefined) return;
      const selection = composition.tracks
        .flatMap((track) => track.clips.map((clip) => ({ clip, track })))
        .find((item) => item.clip.id === selectedClipId);
      if (selection === undefined) return;

      const objectId = `scene-${scenePackageId.split('.').pop()}-${Date.now().toString(36)}`;
      const clipId = `clip-${objectId}`;
      const startUs = selection.clip.startUs;
      const durationUs = selection.clip.durationUs;
      const sceneCount = Object.values(session.visualProject.visualObjects).filter(
        (item) => item.kind === 'html-scene',
      ).length;

      const overlaps = (
        track: (typeof composition.tracks)[number],
        spanStart: number,
        spanDuration: number,
      ): boolean => {
        const spanEnd = spanStart + spanDuration;
        return track.clips.some((clip) => {
          const clipEnd = clip.startUs + clip.durationUs;
          return spanStart < clipEnd && spanEnd > clip.startUs;
        });
      };

      const aboveTracks = composition.tracks
        .filter(
          (track) =>
            track.kind === 'video' &&
            track.enabled &&
            track.order > selection.track.order &&
            !overlaps(track, startUs, durationUs),
        )
        .sort((a, b) => a.order - b.order);
      const targetExisting = aboveTracks[0];
      const order = composition.tracks.reduce((max, track) => Math.max(max, track.order), -1) + 1;
      const targetTrackId = targetExisting?.id ?? `V${order + 1}`;
      const insertClipCommand = {
        type: 'timeline.insertClip' as const,
        payload: {
          compositionId: composition.id,
          trackId: targetTrackId,
          clip: {
            id: clipId,
            kind: 'video' as const,
            assetId: `html-scene:${scenePackageId}`,
            startUs,
            durationUs,
            sourceInUs: 0,
          },
        },
      };
      const timelineCommands =
        targetExisting === undefined
          ? [
              {
                type: 'timeline.addTrack' as const,
                payload: {
                  compositionId: composition.id,
                  track: {
                    id: targetTrackId,
                    kind: 'video' as const,
                    order,
                    enabled: true,
                    clips: [],
                  },
                },
              },
              insertClipCommand,
            ]
          : [insertClipCommand];

      session.dispatchVisualObjects({
        label: `Add HTML scene ${scenePackageId}`,
        commands: [
          {
            type: 'htmlScene.create',
            payload: {
              object: {
                id: objectId,
                kind: 'html-scene',
                scenePackageId,
                transform: {
                  x: 80 + sceneCount * 40,
                  y: 120,
                  scaleX: 1,
                  scaleY: 1,
                  rotationDeg: 0,
                  opacity: 1,
                  crop: { left: 0, top: 0, right: 0, bottom: 0 },
                },
              },
            },
          },
        ],
      });
      session.dispatchTimeline({
        label: `Place HTML scene ${scenePackageId}`,
        commands: timelineCommands,
      });
      session.replaceVisualProject(bindClipToObject(session.visualProject, clipId, objectId));
      setState((current) => ({ ...current, selectedIds: [clipId] }));
      setRevision((revision) => revision + 1);
    },
    [ensureHydrationReady, session, state.selectedIds],
  );

  const addMotionSceneToSelectedClip = useCallback(
    (motionSceneId: string) => {
      if (!ensureHydrationReady()) return;
      const composition = session.timelineProject.compositions.root;
      if (composition === undefined) return;
      const plan = buildMotionScenePlacementPlan({
        composition,
        visualProject: session.visualProject,
        selectedClipId: state.selectedIds[0],
        motionSceneId,
        nowMs: Date.now(),
      });
      if (plan === undefined) return;
      // A placed scene changes both lenses. Apply the object command first as
      // a pure calculation, bind the new object to its clip, then commit both
      // slices through the session's compound snapshot. This keeps Place
      // Motion Scene to one durable undo step (and avoids a dangling binding
      // if a later timeline command rejects).
      void import('@joy-media/property-system')
        .then(({ applyVisualObjectProjectTransaction }) => {
          const created = applyVisualObjectProjectTransaction(
            session.visualProject,
            plan.visualTransaction,
          );
          session.dispatchCompound(`Place Motion scene ${motionSceneId}`, {
            document: bindClipToObject(created, plan.clipId, plan.objectId),
            timeline: plan.timelineTransaction,
          });
          setState((current) => ({ ...current, selectedIds: [plan.clipId] }));
          setRevision((revision) => revision + 1);
        })
        .catch(() => {
          // Optional motion-scene support fails closed if its runtime chunk is unavailable.
        });
    },
    [ensureHydrationReady, session, state.selectedIds],
  );

  const setAudioState = useCallback(
    (next: AudioState) => {
      if (!ensureHydrationReady()) return;
      setAudioStateRaw(next);
      saveAudioState(projectId, next);
      session.replaceVisualProject(withProjectAudio(session.visualProject, next));
      setRevision((revision) => revision + 1);
    },
    [ensureHydrationReady, projectId, session],
  );

  const timelineClipIds =
    session.timelineProject.compositions.root?.tracks.flatMap((track) =>
      track.clips.map((clip) => clip.id),
    ) ?? [];
  useEffect(() => {
    setAudioStateRaw((current) => ensureClipAudio(current, timelineClipIds));
  }, [timelineClipIds.join('|')]);

  const transcribe = useCallback(
    async (
      documentId: string,
      language: 'fa-IR' | 'en-US',
      source: CaptionTranscriptionSource,
      target: CaptionTranscriptionTarget,
    ) => {
      if (!ensureHydrationReady()) return;
      try {
        const document = await transcribeReferenceCaptionDeferred(documentId, language, source);
        session.dispatchVisualObjects({
          label: `Transcribe ${language}`,
          commands: [
            { type: 'caption.replaceDocument', payload: { documentId, document } },
            {
              type: 'caption.setClipTiming',
              payload: {
                documentId,
                clipId: target.clipId,
                startUs: source.timelineStartUs,
                durationUs: source.timelineDurationUs,
              },
            },
          ],
        });
        setTranscriptionError(undefined);
        setRevision((revision) => revision + 1);
      } catch {
        setTranscriptionError(
          'Caption transcription failed. Check the selected media and try again.',
        );
      }
    },
    [ensureHydrationReady, session],
  );
  const undo = useCallback(() => {
    if (!ensureHydrationReady()) return;
    session.undo();
    setRevision((revision) => revision + 1);
  }, [ensureHydrationReady, session]);
  const redo = useCallback(() => {
    if (!ensureHydrationReady()) return;
    session.redo();
    setRevision((revision) => revision + 1);
  }, [ensureHydrationReady, session]);
  const jumpToHistory = useCallback(
    (sequence: number) => {
      if (!ensureHydrationReady()) return;
      session.jumpToHistory(sequence);
      setRevision((revision) => revision + 1);
    },
    [ensureHydrationReady, session],
  );
  const executeAction = useCallback(
    (id: string) => {
      if (id === 'history.undo') undo();
      if (id === 'history.redo') redo();
      setPaletteOpen(false);
    },
    [redo, undo],
  );
  const activatePanel = useCallback((panelId: string) => {
    dockviewApiRef.current?.getPanel(panelId)?.api.setActive();
  }, []);

  const dualLensProjection = useMemo(
    () =>
      buildDualLensProjection(
        session.timelineProject,
        session.visualProject,
        state.playheadUs,
        session.historyEntries,
      ),
    [session.timelineProject, session.visualProject, session.historyEntries, state.playheadUs],
  );
  // The projection changes on every playhead tick, so reveal callbacks read it
  // through a ref instead of a dependency — otherwise every panel that takes
  // one would re-render at playback rate.
  const dualLensProjectionRef = useRef(dualLensProjection);
  dualLensProjectionRef.current = dualLensProjection;

  const [lensReveal, setLensReveal] = useState<LensRevealRequest | undefined>(undefined);
  const selectClips = useCallback((clipIds: readonly string[]) => {
    setState((current) => ({ ...current, selectedIds: [...clipIds] }));
  }, []);
  const revealNodeInFlow = useCallback(
    (nodeId: string) => {
      setLensReveal({ mode: 'flow', nodeId, token: Date.now() });
      activatePanel('flow');
    },
    [activatePanel],
  );
  const revealInFlow = useCallback(
    (clipId: string) => {
      selectClips([clipId]);
      const nodeId = primaryNodeIdForClip(dualLensProjectionRef.current, clipId);
      setLensReveal({
        mode: 'flow',
        token: Date.now(),
        ...(nodeId === undefined ? {} : { nodeId }),
      });
      activatePanel('flow');
    },
    [activatePanel, selectClips],
  );
  const revealOnTimeline = useCallback(
    (clipIds: readonly string[]) => {
      if (clipIds.length === 0) return;
      selectClips(clipIds);
      activatePanel('timeline');
    },
    [activatePanel, selectClips],
  );
  const refreshJoySession = useCallback(() => {
    const requestId = ++joySessionRefreshSeqRef.current;
    void probeJoySession(window.localStorage)
      .then((next) => {
        if (requestId !== joySessionRefreshSeqRef.current) {
          if (next.kind === 'ready' && next.avatarObjectUrl !== undefined) {
            URL.revokeObjectURL(next.avatarObjectUrl);
          }
          return;
        }
        setJoySession((prev) => {
          if (prev.kind === 'ready' && prev.avatarObjectUrl !== undefined) {
            URL.revokeObjectURL(prev.avatarObjectUrl);
          }
          return next;
        });
      })
      .catch(() => undefined);
  }, []);
  const showToast = useCallback((message: string, kind: 'info' | 'success' | 'error' = 'info') => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev, { id, message, kind }]);
    const timer = window.setTimeout(() => {
      toastTimersRef.current.delete(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
    toastTimersRef.current.set(id, timer);
  }, []);
  const downloadLegacyBackup = useCallback(() => {
    const journal = legacyBackupJournalRef.current;
    if (journal === null) {
      showToast('The local recovery backup is not currently available.', 'info');
      return;
    }
    void journal
      .loadLegacyBackup()
      .then((backup) => {
        if (backup === null) {
          setLegacyBackupAvailable(false);
          showToast('The local recovery backup could not be found.', 'info');
          return;
        }
        void import('./project-document-lifecycle.js').then(({ legacyBackupBlob }) => {
          const blob = legacyBackupBlob(backup);
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = backup.filename;
          anchor.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 0);
        });
      })
      .catch(() => showToast('The local recovery backup could not be read.', 'info'));
  }, [showToast]);
  const attachKiloCodeAsset = useCallback((asset: KiloCodeAttachedAsset) => {
    setKiloCodeAttachedAssets((current) => {
      if (current.some((entry) => entry.assetId === asset.assetId)) return current;
      return [...current, asset];
    });
  }, []);
  const detachKiloCodeAsset = useCallback(
    (assetId: string) => {
      const entry = kiloCodeAttachedAssets.find((item) => item.assetId === assetId);
      setKiloCodeAttachedAssets((current) => current.filter((item) => item.assetId !== assetId));
      if (entry?.source === 'joycode-folder') {
        void import('./joycode-opfs-assets.js')
          .then(({ openJoyCodeOpfsAssetCache }) => openJoyCodeOpfsAssetCache())
          .then((cache) => cache.remove(assetId))
          .catch(() => {
            /* OPFS cleanup is best-effort */
          });
      }
    },
    [kiloCodeAttachedAssets],
  );
  const bumpProjectRevision = useCallback(() => {
    setRevision((revision) => revision + 1);
  }, []);
  const bumpPluginRevision = useCallback(() => {
    setPluginRevision((revision) => revision + 1);
  }, []);
  const toggleKeyboardShortcuts = useCallback(() => {
    setKeyboardShortcutsOpen((open) => !open);
  }, []);

  const ensureDockPanels = useCallback((api: DockviewApi) => {
    const addPanel = (
      id: string,
      options: {
        readonly inactive?: boolean;
        readonly position?: {
          readonly referencePanel: string;
          readonly direction: 'left' | 'right' | 'above' | 'below' | 'within';
        };
      } = {},
    ) => {
      if (api.getPanel(id) !== undefined) return;
      api.addPanel({
        id,
        component: 'editor-panel',
        title: panelLabel(id),
        inactive: options.inactive ?? true,
        minimumWidth: DOCK_PANEL_MINIMUM_WIDTH,
        minimumHeight: DOCK_PANEL_MINIMUM_HEIGHT,
        ...(options.position !== undefined ? { position: options.position } : {}),
      });
    };

    for (const panel of DEFAULT_WORKSPACE.panels) {
      addPanel(panel, {
        inactive: true,
        ...(panel === 'flow' && api.getPanel('timeline') !== undefined
          ? { position: { referencePanel: 'timeline', direction: 'within' as const } }
          : {}),
      });
    }
  }, []);

  const applyDockLayout = useCallback(
    (api: DockviewApi, mode: EditorViewMode) => {
      const layoutKey = dockLayoutKey(mode);
      const saved = window.localStorage.getItem(layoutKey);
      let restored = false;
      if (saved !== null) {
        try {
          api.fromJSON(normalizeDockLayoutConstraints(JSON.parse(saved)) as never, {
            reuseExistingPanels: false,
          });
          restored = true;
        } catch {
          window.localStorage.removeItem(layoutKey);
        }
      }
      if (!restored) {
        try {
          api.fromJSON(seedDockLayout(mode) as never, { reuseExistingPanels: false });
        } catch (error) {
          console.warn('default dock layout rejected, falling back to a stack', error);
        }
      }
      ensureDockPanels(api);
      api.getPanel('monitor')?.api.setActive();
      window.localStorage.setItem(layoutKey, JSON.stringify(api.toJSON()));
    },
    [ensureDockPanels],
  );

  const switchEditorView = useCallback(() => {
    const api = dockviewApiRef.current;
    if (api === null) return;
    const current = viewModeRef.current;
    window.localStorage.setItem(dockLayoutKey(current), JSON.stringify(api.toJSON()));
    const next: EditorViewMode = current === 'vertical' ? 'widescreen' : 'vertical';
    saveViewMode(window.localStorage, next);
    setViewMode(next);
    applyDockLayout(api, next);
  }, [applyDockLayout]);

  useEffect(() => {
    if (!paletteOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = paletteRef.current;
      if (root === null || root.contains(event.target as Node)) return;
      setPaletteOpen(false);
    };
    // Capture so we close before other UI consumes the event; skip the same
    // gesture that opened the palette by listening only after mount.
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [paletteOpen]);
  useEffect(() => {
    if (!accountOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = accountDropdownRef.current;
      if (root === null || root.contains(event.target as Node)) return;
      setAccountOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [accountOpen]);
  useEffect(() => {
    refreshJoySession();
  }, [refreshJoySession]);
  const signOut = useCallback(async () => {
    setAccountOpen(false);
    await logoutJoySession(window.localStorage);
    refreshJoySession();
  }, [refreshJoySession]);
  const recordExportEntry = useCallback((entry: ExportProcessEntry) => {
    setExportHistory((entries) => {
      const next = upsertEntry(entries, entry);
      saveExportHistory(window.localStorage, next);
      return next;
    });
  }, []);
  const blockedDeliveryEntry = useMemo(
    () => exportHistory.find((entry) => deliveryGate(entry).status === 'blocked'),
    [exportHistory],
  );
  const deliveryTimelineClips = useMemo<readonly DeliveryTimelineClip[]>(
    () => deliveryTimelineClipsFromProject(session.timelineProject),
    [session.timelineProject],
  );
  const deliveryMediaClips = useMemo<readonly (VideoClip | AudioClip)[]>(
    () =>
      session.timelineProject.compositions.root?.tracks.flatMap((track) =>
        track.clips.flatMap((clip) =>
          clip.kind === 'video' || clip.kind === 'audio' ? [clip] : [],
        ),
      ) ?? [],
    [session.timelineProject],
  );
  const verifiedRenderEnvelope = useMemo<VerifiedRenderEnvelope>(() => {
    const timeline = session.timelineProject.compositions.root;
    const allClips =
      timeline?.tracks.filter((track) => track.enabled).flatMap((track) => track.clips) ?? [];
    const videoClips = allClips
      .filter((clip): clip is VideoClip => clip.kind === 'video')
      .sort((left, right) => left.startUs - right.startUs);
    let cursorUs = 0;
    const nonContiguous =
      timeline === undefined ||
      videoClips.some((clip) => {
        const gap = clip.startUs !== cursorUs;
        cursorUs += clip.durationUs;
        return gap;
      }) ||
      cursorUs !== (timeline?.durationUs ?? 0);
    const nonOneXPlaybackCount = videoClips.filter((clip) => (clip.playbackRate ?? 1) !== 1).length;
    const audio = session.visualProject.audio;
    const audioFadeCount = Object.values(audio?.clips ?? {}).filter(
      (clip) => clip.fadeInUs !== undefined || clip.fadeOutUs !== undefined,
    ).length;
    const unsupportedAssetCount = allClips.filter((clip) => {
      if (clip.kind !== 'video' && clip.kind !== 'audio') return false;
      return session.visualProject.assets[clip.assetId]?.kind !== clip.kind;
    }).length;
    const captionBurnIn = session.visualProject.pluginData[CAPTION_BURN_IN_KEY] === true;
    const supportedTransitionCount = session.visualProject.transitions?.length ?? 0;
    let verifiedRenderPlan: CompositionPlanV2 | undefined;
    let verifiedRenderPlanError: string | undefined;
    try {
      // Use the exact normalized intent that the verified-delivery snapshot
      // mints. This keeps the editor gate and Worker on one contract.
      verifiedRenderPlan = createCompositionPlanV2({
        timelineProject: session.timelineProject,
        visualProject: { ...session.visualProject, exportPreset },
      });
    } catch (error) {
      verifiedRenderPlanError =
        error instanceof Error
          ? error.message
          : 'This project is not eligible for verified delivery yet.';
    }
    return {
      visualObjectCount: Object.keys(session.visualProject.visualObjects).length,
      transitionCount: session.visualProject.transitions?.length ?? 0,
      supportedTransitionCount,
      captionBurnIn,
      ...(verifiedRenderPlan?.captionBurnIn === undefined
        ? {}
        : { captionBurnInPayload: verifiedRenderPlan.captionBurnIn }),
      ...(verifiedRenderPlan === undefined ? {} : { verifiedRenderPlan }),
      ...(verifiedRenderPlanError === undefined ? {} : { verifiedRenderPlanError }),
      audioEffectCount: audio?.effects.length ?? 0,
      audioBusCount: audio?.buses.length ?? 0,
      audioFadeCount,
      unsupportedClipCount: allClips.filter(
        (clip) => clip.kind !== 'video' && clip.kind !== 'audio',
      ).length,
      nonContiguous,
      nonOneXPlaybackCount,
      unsupportedAssetCount,
    };
  }, [exportPreset, session.timelineProject, session.visualProject]);
  const [deliveryMediaStates, setDeliveryMediaStates] = useState<
    ReadonlyMap<string, DeliveryMediaState>
  >(() => new Map());
  useEffect(() => {
    let cancelled = false;
    if (deliveryMediaClips.length === 0) {
      setDeliveryMediaStates(new Map());
      return () => {
        cancelled = true;
      };
    }
    void Promise.all(
      deliveryMediaClips.map(async (clip) => {
        try {
          const source = await resolveClipMonitorMediaSource(clip);
          const state: DeliveryMediaState = deliveryMediaStateFromEvidence(source);
          if (source.state === 'ready') source.release();
          return { id: clip.id, state };
        } catch {
          return { id: clip.id, state: 'unavailable' as const };
        }
      }),
    ).then((resolved) => {
      if (cancelled) return;
      setDeliveryMediaStates(new Map(resolved.map(({ id, state }) => [id, state])));
    });
    return () => {
      cancelled = true;
    };
  }, [deliveryMediaClips, resolveClipMonitorMediaSource]);
  const deliveryCapabilities = useMemo<readonly DeliveryCapability[]>(() => {
    const capabilities: DeliveryCapability[] = [];
    if (
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported(BROWSER_MP4_MIME_TYPE)
    ) {
      capabilities.push('browser-mp4');
    }
    const connectedRenderWorker = deliveryWorkers.some(
      (worker) =>
        workerPresence(worker) === 'connected' && worker.capabilities.includes('render.export'),
    );
    if (connectedRenderWorker) capabilities.push('worker-render-export');
    return capabilities;
  }, [deliveryWorkers]);
  const quickExportPreflight = useMemo(
    () =>
      deliveryPreflight({
        channel: 'quick-browser-export',
        clips: deliveryTimelineClips,
        mediaStates: deliveryMediaStates,
        capabilities: deliveryCapabilities,
      }),
    [deliveryCapabilities, deliveryMediaStates, deliveryTimelineClips],
  );
  const verifiedDeliveryPreflight = useMemo(
    () =>
      deliveryPreflight({
        channel: 'verified-delivery',
        clips: deliveryTimelineClips,
        mediaStates: deliveryMediaStates,
        capabilities: deliveryCapabilities,
        verifiedRenderEnvelope,
      }),
    [deliveryCapabilities, deliveryMediaStates, deliveryTimelineClips, verifiedRenderEnvelope],
  );
  const deliverBlockedReason = exporting
    ? 'Deliver is unavailable while another export is running.'
    : blockedDeliveryEntry !== undefined
      ? `Deliver blocked: ${blockedDeliveryEntry.filename} has failing inspection evidence without a waiver.`
      : verifiedDeliveryPreflight.allowed
        ? undefined
        : `Deliver blocked: ${verifiedDeliveryPreflight.reason}`;
  const deliveryBlockedFailures: readonly {
    readonly channel: 'Quick export' | 'Verified delivery';
    readonly detail: string;
  }[] = [
    ...(!quickExportPreflight.allowed
      ? [
          {
            channel: 'Quick export' as const,
            detail: `Quick export blocked: ${quickExportPreflight.reason ?? 'Delivery is unavailable.'}`,
          },
        ]
      : []),
    ...(deliverBlockedReason === undefined
      ? []
      : [{ channel: 'Verified delivery' as const, detail: deliverBlockedReason }]),
  ];
  const deliveryHistoryNeedsReconcile = useMemo(
    () => exportHistory.some((entry) => deliveryGate(entry).status === 'pending'),
    [exportHistory],
  );
  const reconcileDeliveryHistory = useCallback(async () => {
    if (!deliveryHistoryNeedsReconcile) return;
    try {
      const jobs = await mediaClient.jobs(projectId);
      const currentEntries = exportHistory;
      setExportHistory((entries) => {
        const next = reconcileDeliveryInspections(entries, jobs);
        if (next !== entries) saveExportHistory(window.localStorage, next);
        return next;
      });
      // Export completion only unlocks inspection. Queue it against the
      // concrete API artifact; inline export QA is never promoted to verified.
      for (const entry of currentEntries) {
        if (
          entry.channel !== 'verified-delivery' ||
          entry.exportJobId === undefined ||
          entry.inspectJobId !== undefined ||
          entry.inspectionPromise === undefined
        )
          continue;
        const exportJob = jobs.find((job) => job.id === entry.exportJobId);
        const outputRef = exportJob?.derivative?.outputRef;
        const sha256 = exportJob?.derivative?.sha256;
        if (exportJob?.state !== 'completed' || outputRef === undefined || sha256 === undefined)
          continue;
        const inspectJobId = `${entry.id}-inspect`;
        const artifactId = `artifact-${entry.exportJobId}-${sha256.slice(0, 16)}`;
        try {
          const inspection = await mediaClient.enqueueRenderInspection(projectId, inspectJobId, {
            projectRef: `project-${projectId}`,
            compositionId: `composition-${projectId}`,
            presetId: `preset-${projectId}`,
            reportRef: entry.reportRef ?? `report-${inspectJobId}`,
            artifactId,
            outputRef,
            promise: entry.inspectionPromise,
            mode: 'sampled',
          });
          recordExportEntry({
            ...entry,
            inspectJobId: inspection.id,
            inspection: {
              state: 'queued',
              ...(entry.reportRef === undefined ? {} : { reportRef: entry.reportRef }),
            },
          });
        } catch {
          // Keep the export pending; the next poll retries the same idempotent
          // inspect job after a transient API/Worker failure.
        }
      }
    } catch {
      // JobsPanel already owns user-facing connection errors; delivery history
      // remains fail-closed until a report projection is available.
    }
  }, [deliveryHistoryNeedsReconcile, exportHistory, mediaClient, projectId, recordExportEntry]);
  useEffect(() => {
    if (!deliveryHistoryNeedsReconcile) return;
    void reconcileDeliveryHistory();
    const interval = window.setInterval(() => void reconcileDeliveryHistory(), 2_000);
    return () => window.clearInterval(interval);
  }, [deliveryHistoryNeedsReconcile, reconcileDeliveryHistory]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (authLocked) return;
      const action = resolveShortcut(event);
      if (action === undefined) return;
      // Escape must close the palette even while its search input has focus.
      if (action !== 'palette.close' && isEditableTarget(event.target)) return;
      const current = stateRef.current;
      const composition = session.timelineProject.compositions.root;
      const durationUs = composition?.durationUs ?? 0;
      const selection = composition?.tracks
        .flatMap((track) => track.clips.map((clip) => ({ track, clip })))
        .find((item) => current.selectedIds.includes(item.clip.id));
      switch (action) {
        case 'playback.toggle':
          togglePlayback();
          break;
        case 'history.undo':
          undo();
          break;
        case 'history.redo':
          redo();
          break;
        case 'palette.toggle':
          setPaletteOpen((open) => !open);
          break;
        case 'palette.close':
          setPaletteOpen(false);
          setProcessesOpen(false);
          setAccountOpen(false);
          break;
        case 'playhead.back':
          seek(Math.max(0, current.playheadUs - 1_000_000));
          break;
        case 'playhead.forward':
          seek(Math.min(durationUs, current.playheadUs + 1_000_000));
          break;
        case 'playhead.backFine':
          seek(Math.max(0, current.playheadUs - 100_000));
          break;
        case 'playhead.forwardFine':
          seek(Math.min(durationUs, current.playheadUs + 100_000));
          break;
        case 'playhead.start':
          seek(0);
          break;
        case 'playhead.end':
          seek(durationUs);
          break;
        case 'shortcuts.toggle':
          setKeyboardShortcutsOpen((open) => !open);
          break;
        case 'clip.split': {
          if (composition === undefined || selection === undefined) return;
          const endUs = selection.clip.startUs + selection.clip.durationUs;
          if (current.playheadUs <= selection.clip.startUs || current.playheadUs >= endUs) return;
          dispatchTimeline({
            label: `Split ${selection.clip.id}`,
            commands: [
              {
                type: 'timeline.splitClip',
                payload: {
                  compositionId: composition.id,
                  trackId: selection.track.id,
                  clipId: selection.clip.id,
                  atUs: current.playheadUs,
                  newClipId: `${selection.clip.id}-split-${current.playheadUs}`,
                },
              },
            ],
          });
          break;
        }
        case 'clip.delete': {
          if (composition === undefined || selection === undefined) return;
          dispatchTimeline(
            rippleDelete(
              composition.id,
              selection.track.id,
              selection.track.clips.map((clip) => ({
                id: clip.id,
                startUs: clip.startUs,
                durationUs: clip.durationUs,
              })),
              selection.clip.id,
            ),
          );
          setState((active) => ({
            ...active,
            selectedIds: active.selectedIds.filter((id) => id !== selection.clip.id),
          }));
          break;
        }
        case 'clip.duplicate': {
          if (composition === undefined || selection === undefined) return;
          dispatchTimeline({
            label: `Duplicate ${selection.clip.id}`,
            commands: [
              duplicateClipCommand(
                composition.id,
                selection.track.id,
                selection.clip,
                selection.track.clips.map((clip) => ({
                  id: clip.id,
                  startUs: clip.startUs,
                  durationUs: clip.durationUs,
                })),
                `${selection.clip.id}-copy-${Date.now()}`,
              ),
            ],
          });
          break;
        }
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [authLocked, dispatchTimeline, redo, seek, session, togglePlayback, undo]);

  const runSelectedClipAction = useCallback(
    (kind: 'split' | 'duplicate' | 'delete') => {
      const current = stateRef.current;
      const composition = session.timelineProject.compositions.root;
      if (composition === undefined) return;
      const selection = composition.tracks
        .flatMap((track) => track.clips.map((clip) => ({ track, clip })))
        .find((item) => current.selectedIds.includes(item.clip.id));
      if (selection === undefined) return;
      if (kind === 'split') {
        const endUs = selection.clip.startUs + selection.clip.durationUs;
        if (current.playheadUs <= selection.clip.startUs || current.playheadUs >= endUs) return;
        dispatchTimeline({
          label: `Split ${selection.clip.id}`,
          commands: [
            {
              type: 'timeline.splitClip',
              payload: {
                compositionId: composition.id,
                trackId: selection.track.id,
                clipId: selection.clip.id,
                atUs: current.playheadUs,
                newClipId: `${selection.clip.id}-split-${current.playheadUs}`,
              },
            },
          ],
        });
        return;
      }
      if (kind === 'duplicate') {
        dispatchTimeline({
          label: `Duplicate ${selection.clip.id}`,
          commands: [
            duplicateClipCommand(
              composition.id,
              selection.track.id,
              selection.clip,
              selection.track.clips.map((clip) => ({
                id: clip.id,
                startUs: clip.startUs,
                durationUs: clip.durationUs,
              })),
              `${selection.clip.id}-copy-${Date.now()}`,
            ),
          ],
        });
        return;
      }
      dispatchTimeline(
        rippleDelete(
          composition.id,
          selection.track.id,
          selection.track.clips.map((clip) => ({
            id: clip.id,
            startUs: clip.startUs,
            durationUs: clip.durationUs,
          })),
          selection.clip.id,
        ),
      );
      setState((active) => ({
        ...active,
        selectedIds: active.selectedIds.filter((id) => id !== selection.clip.id),
      }));
    },
    [dispatchTimeline, session],
  );

  const handleExport = useCallback(async () => {
    if (!ensureHydrationReady()) return;
    if (exporting) return;
    if (!quickExportPreflight.allowed) {
      setExportStatus(
        `Quick export blocked: ${quickExportPreflight.reason ?? 'Delivery is unavailable.'}`,
      );
      setExportProgress(undefined);
      return;
    }
    setExporting(true);
    window.clearTimeout(exportToastTimerRef.current);
    setExportStatus('Building render manifest…');
    setExportProgress(0.02);
    const entryId = `export-${Date.now()}`;
    const startedAt = new Date().toISOString();
    const exportFilename = `joy-media-export-${Date.now()}.mp4`;
    recordExportEntry({
      id: entryId,
      filename: exportFilename,
      status: 'running',
      startedAt,
      channel: 'quick-browser-export',
      inspection: { state: 'not-requested' },
    });
    try {
      await syncStickerBitmaps();
      const compositionV1 =
        session.visualProject.compositions[session.visualProject.rootCompositionId];
      const baseWidth = compositionV1?.width ?? 1080;
      const baseHeight = compositionV1?.height ?? 1920;
      const { width, height } = (() => {
        switch (exportPreset) {
          case 'reels-1080':
          case 'shorts-1080':
            return { width: 1080, height: 1920 };
          case 'youtube-1080':
            return { width: 1920, height: 1080 };
          case 'high-bitrate':
            return { width: Math.max(baseWidth, 1920), height: Math.max(baseHeight, 1080) };
          default:
            return { width: baseWidth, height: baseHeight };
        }
      })();
      const compositionTimeline = session.timelineProject.compositions.root;
      const durationUs = compositionTimeline?.durationUs ?? 30_000_000;
      const frameRate = 30;
      const totalFrames = Math.max(1, Math.round((durationUs / 1_000_000) * frameRate));
      const manifest: BrowserExportManifest = Object.freeze({
        width,
        height,
        frameRate,
        durationUs,
      });
      session.replaceVisualProject({
        ...session.visualProject,
        exportPreset,
        updatedAt: new Date().toISOString(),
      });
      const planRenderFrame = await loadPlanRenderFrame();
      const frameTimeUs = (index: number): number =>
        Math.min(durationUs - 1, Math.floor((index * 1_000_000) / frameRate));
      const buildFramePlan = (timeUs: number) =>
        planRenderFrame({
          bundle: createRenderBundle({
            timelineProject: session.timelineProject,
            visualProject: session.visualProject,
            ...(compositionV1 !== undefined ? { compositionId: compositionV1.id } : {}),
            outputPreset: exportPreset,
            seed: `export:${entryId}`,
          }),
          timeUs,
          viewport: { width, height },
          imageSizesByObjectId: imageSizesFromCache(),
        });
      const plannedExportClipIds = new Set<string>();
      const plannedExportStillTargets = new Map<
        string,
        ReturnType<typeof plannedStillBitmapTargets>[number]
      >();
      for (let index = 0; index < totalFrames; index++) {
        const plan = buildFramePlan(frameTimeUs(index));
        for (const sample of plan.videoSamples) plannedExportClipIds.add(sample.clipId);
        for (const target of plannedStillBitmapTargets(
          session.visualProject,
          plan.captureRequirements,
        )) {
          plannedExportStillTargets.set(target.objectId, target);
        }
      }
      const exportClips = [...plannedExportClipIds]
        .map((clipId) => findVideoClipById(session.timelineProject, clipId))
        .filter((clip): clip is VideoClip => clip !== undefined);
      if (exportClips.length === 0)
        throw new Error('No playable video clips are available for export');
      await syncStickerBitmapTargets([...plannedExportStillTargets.values()]);
      setStickerTick((tick) => tick + 1);

      setExportStatus('Preloading preview-equivalent video and audio…');
      setExportProgress(0.05);
      const audioContext = new AudioContext();
      const audioDestination = audioContext.createMediaStreamDestination();
      const exportSources = await resolveReadyMonitorMediaSources(
        exportClips,
        resolveClipMonitorMediaSource,
      );
      const sourcesByClipId = new Map(exportSources.map((source) => [source.clipId, source]));
      const preparedExportMedia = await Promise.allSettled(
        exportClips.map(async (clip) => {
          const source = sourcesByClipId.get(clip.id);
          if (source === undefined)
            throw new Error(`Export source for ${clip.assetId} was not prepared`);
          const video = document.createElement('video');
          await loadDetachedVideo(video, source.url);
          await seekDetachedVideo(video, clip.sourceInUs);
          const captureCanvas = document.createElement('canvas');
          captureCanvas.width = 0;
          captureCanvas.height = 0;
          const audioResponse = await fetch(source.url);
          if (!audioResponse.ok)
            throw new Error(`Unable to fetch export audio for ${clip.assetId}`);
          const audioBuffer = await audioContext.decodeAudioData(await audioResponse.arrayBuffer());
          if (audioBuffer === null)
            throw new Error(`Unable to decode export audio for ${clip.assetId}`);
          const clipAudioConfig = audioState.clips[clip.id] ?? {
            gain: 1,
            pan: 0,
            mute: false,
            solo: false,
          };
          const channels = audioBuffer.numberOfChannels;
          const length = audioBuffer.length;
          const samples = new Float32Array(length);
          const monoChannel = new Float32Array(length);
          for (let channel = 0; channel < channels; channel++) {
            audioBuffer.copyFromChannel(monoChannel, channel);
            let index = 0;
            for (const value of monoChannel) {
              samples[index] = samples[index]! + value / channels;
              index++;
            }
          }
          return {
            clip,
            source,
            video,
            decoder: createHtmlMediaDecoder(video, captureCanvas),
            audio: {
              samples,
              sampleRate: audioBuffer.sampleRate,
              config: clipAudioConfig,
            },
          };
        }),
      );
      const failedExportMedia = preparedExportMedia.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failedExportMedia !== undefined) {
        for (const result of preparedExportMedia) {
          if (result.status === 'fulfilled') result.value.video.pause();
        }
        releaseMonitorMediaSources(exportSources);
        throw failedExportMedia.reason;
      }
      const exportMedia = preparedExportMedia.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      const mediaForClip = new Map(exportMedia.map((media) => [media.clip.id, media]));
      const mixedAudio = buildMixerBuffer(
        exportMedia.map((media) => ({ clipId: media.clip.id, samples: media.audio.samples })),
        audioState.clips,
        audioState.buses,
        durationUs,
        exportMedia[0]?.audio.sampleRate ?? 48000,
      );
      const mixedAudioBuffer = createMonoAudioBuffer(
        audioContext,
        mixedAudio,
        exportMedia[0]?.audio.sampleRate ?? 48000,
      );
      const mixedChannel = mixedAudioBuffer.getChannelData(0);
      for (let i = 0; i < mixedAudio.length; i++) mixedChannel[i] = mixedAudio[i]!;
      const mixedAudioSource = audioContext.createBufferSource();
      mixedAudioSource.buffer = mixedAudioBuffer;
      mixedAudioSource.connect(audioDestination);
      const exportAudioTrack = audioDestination.stream.getAudioTracks()[0];
      if (exportAudioTrack === undefined)
        throw new Error('Export audio mix did not produce a track');
      const [rendererModule, exportModule, htmlSceneModule, motionSceneModule] = await Promise.all([
        import('@joy-media/renderer-pixi/browser'),
        import('@joy-media/renderer-pixi/browser-export'),
        import('./html-scene-surfaces.js'),
        import('./motion-scene-surfaces.js'),
      ]);
      const renderer = await rendererModule.createBrowserPixiRenderer({
        width,
        height,
        resolution: 1,
      });
      const sceneFrameSource = htmlSceneModule.createDeliverySceneFrameSource(
        new htmlSceneModule.HtmlSceneSurfaceCache(),
      );
      const motionSceneFrameSource = new motionSceneModule.MotionSceneSurfaceCache(
        window.localStorage,
      );
      const startTimers: number[] = [];
      const audioSources: AudioBufferSourceNode[] = [];
      try {
        await audioContext.resume();
        setExportStatus(`Encoding ${totalFrames} preview-equivalent H.264/AAC frames…`);
        const exportResult: BrowserExportResult = await exportModule.downloadBrowserMp4({
          manifest,
          frameCount: totalFrames,
          canvas: renderer.canvas,
          audioTrack: exportAudioTrack,
          onRecordingStart: () => {
            const startAt = audioContext.currentTime;
            for (const media of exportMedia) {
              const audioSource = audioContext.createBufferSource();
              const playbackBuffer = createMonoAudioBuffer(
                audioContext,
                media.audio.samples,
                media.audio.sampleRate,
              );
              playbackBuffer.copyToChannel(media.audio.samples, 0);
              audioSource.buffer = playbackBuffer;
              audioSource.connect(audioDestination);
              audioSource.start(
                startAt + media.clip.startUs / 1_000_000,
                media.clip.sourceInUs / 1_000_000,
                media.clip.durationUs / 1_000_000,
              );
              audioSources.push(audioSource);
              const startVideo = () => void media.video.play();
              if (media.clip.startUs === 0) startVideo();
              else startTimers.push(window.setTimeout(startVideo, media.clip.startUs / 1_000));
            }
          },
          paintFrame: async (index) => {
            const timeUs = frameTimeUs(index);
            const plan = buildFramePlan(timeUs);
            const primarySample =
              plan.videoSamples.find((sample) => sample.role === 'primary') ?? plan.videoSamples[0];
            const bitmaps = new Map<string, ImageDataLike>();
            const captureExportSample = async (
              sample: (typeof plan.videoSamples)[number],
            ): Promise<VideoFrameNode> => {
              const target = findVideoClipById(session.timelineProject, sample.clipId);
              if (target === undefined)
                throw new Error(`Export clip ${sample.clipId} was not found`);
              const media = mediaForClip.get(sample.clipId);
              if (media === undefined)
                throw new Error(`Export media for ${sample.clipId} was not prepared`);
              await seekDetachedVideo(media.video, sample.sourceTimeUs);
              const token = index + 1;
              const decoded = media.decoder.captureCurrentFrame(token);
              if (decoded.bitmap === undefined)
                throw new Error(
                  `Export media frame ${index} for ${target.assetId} is not drawable`,
                );
              bitmaps.set(target.id, decoded.bitmap);
              return videoFrameNodeFromDecoded(videoClipSpec(target), decoded, {
                width: media.video.videoWidth,
                height: media.video.videoHeight,
              });
            };
            let node: VideoFrameNode | undefined;
            if (primarySample !== undefined) {
              node = await captureExportSample(primarySample);
              for (const sample of plan.videoSamples) {
                if (bitmaps.has(sample.clipId)) continue;
                await captureExportSample(sample);
              }
            }
            await sceneFrameSource.captureInto(
              bitmaps,
              htmlSceneCaptureTargetsForRequirements(
                session.visualProject,
                plan.captureRequirements,
              ),
            );
            const motionSceneTargets = plannedMotionSceneCaptureTargets(
              session.visualProject,
              plan.captureRequirements,
            );
            const motionSceneBitmaps = await motionSceneFrameSource.captureFull(motionSceneTargets);
            const motionSceneDiagnostic = motionSceneFrameSource.diagnostics()[0];
            if (motionSceneDiagnostic !== undefined) throw new Error(motionSceneDiagnostic.message);
            for (const [objectId, bitmap] of motionSceneBitmaps) bitmaps.set(objectId, bitmap);
            for (const target of plannedStillBitmapTargets(
              session.visualProject,
              plan.captureRequirements,
            )) {
              const bitmap = stickerImageCache.get(target.objectId);
              if (bitmap !== undefined) bitmaps.set(target.objectId, bitmap);
            }
            renderer.render(
              node === undefined ? plan.frame : withVideoFrameNode(plan.frame, node),
              bitmaps,
            );
          },
          onProgress: (completed, total) => {
            setExportProgress(0.05 + 0.93 * (completed / total));
            if (completed === total || completed % frameRate === 0)
              setExportStatus(
                `Encoding preview-equivalent H.264/AAC… ${completed}/${total} frames`,
              );
          },
          filename: exportFilename,
        });
        setExportProgress(1);
        // Retain only the newest export's bytes for re-download.
        if (lastExportRef.current !== null) URL.revokeObjectURL(lastExportRef.current.url);
        lastExportRef.current =
          exportResult.blob !== undefined
            ? { entryId, url: URL.createObjectURL(exportResult.blob) }
            : null;
        recordExportEntry({
          id: entryId,
          filename: exportResult.filename,
          status: 'completed',
          startedAt,
          finishedAt: new Date().toISOString(),
          totalBytes: exportResult.totalBytes,
          frameCount: exportResult.frameCount,
          channel: 'quick-browser-export',
          inspection: { state: 'not-requested' },
        });
        // File has already downloaded via the browser save prompt — drop the
        // toast immediately and clear the full bar after a short settle so the
        // processes menu (not the icon row) remains the durable record.
        setExportStatus(undefined);
        exportToastTimerRef.current = window.setTimeout(() => {
          setExportProgress(undefined);
        }, 450);
      } finally {
        for (const timer of startTimers) window.clearTimeout(timer);
        for (const source of audioSources) source.stop();
        for (const media of exportMedia) {
          media.video.pause();
          media.source.release();
        }
        sceneFrameSource.destroy();
        motionSceneFrameSource.destroy();
        renderer.destroy();
        await audioContext.close();
      }
    } catch (error) {
      const message = userFacingDeliveryError(error, 'Quick export');
      setExportStatus(`Export failed: ${message}`);
      recordExportEntry({
        id: entryId,
        filename: exportFilename,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        error: message,
        channel: 'quick-browser-export',
        inspection: { state: 'not-requested' },
      });
      setExportProgress(undefined);
      exportToastTimerRef.current = window.setTimeout(() => {
        setExportStatus(undefined);
      }, 8_000);
    } finally {
      setExporting(false);
    }
  }, [
    ensureHydrationReady,
    quickExportPreflight,
    exportPreset,
    exporting,
    recordExportEntry,
    resolveClipMonitorMediaSource,
    session,
    syncStickerBitmaps,
  ]);

  const handleVerifiedDelivery = useCallback(async () => {
    if (!ensureHydrationReady()) return;
    if (exporting) return;
    if (!verifiedDeliveryPreflight.allowed) {
      setExportStatus(
        `Deliver blocked: ${verifiedDeliveryPreflight.reason ?? 'Delivery is unavailable.'}`,
      );
      setExportProgress(undefined);
      return;
    }
    if (blockedDeliveryEntry !== undefined) {
      setExportStatus(
        `Deliver blocked: ${blockedDeliveryEntry.filename} has failing inspection evidence without a waiver.`,
      );
      setExportProgress(undefined);
      window.clearTimeout(exportToastTimerRef.current);
      exportToastTimerRef.current = window.setTimeout(() => {
        setExportStatus(undefined);
      }, 8_000);
      return;
    }

    setExporting(true);
    window.clearTimeout(exportToastTimerRef.current);
    setExportStatus('Queueing verified delivery render…');
    setExportProgress(0.05);
    const createdAt = Date.now();
    const entryId = `delivery-${createdAt}`;
    const exportJobId = `${entryId}-export`;
    const reportRef = `report-${entryId}`;
    const filename = `joy-media-delivery-${createdAt}.mp4`;
    const startedAt = new Date().toISOString();
    const compositionV1 =
      session.visualProject.compositions[session.visualProject.rootCompositionId];
    const baseWidth = compositionV1?.width ?? 1080;
    const baseHeight = compositionV1?.height ?? 1920;
    const { width, height } = (() => {
      switch (exportPreset) {
        case 'reels-1080':
        case 'shorts-1080':
          return { width: 1080, height: 1920 };
        case 'youtube-1080':
          return { width: 1920, height: 1080 };
        case 'high-bitrate':
          return { width: Math.max(baseWidth, 1920), height: Math.max(baseHeight, 1080) };
        default:
          return { width: baseWidth, height: baseHeight };
      }
    })();
    const durationUs = session.timelineProject.compositions.root?.durationUs ?? 30_000_000;
    const timelineFrameRate = session.timelineProject.compositions.root?.frameRate;
    const frameRate =
      timelineFrameRate === undefined
        ? compositionV1?.frameRate.num !== undefined && compositionV1.frameRate.den !== 0
          ? compositionV1.frameRate.num / compositionV1.frameRate.den
          : 30
        : timelineFrameRate.num / timelineFrameRate.den;
    const snapshotKey = `${projectId}:${session.projectRevisionId}:${exportPreset}:${durationUs}:${width}x${height}`;
    const cachedBundle = verifiedDeliverySnapshotCacheRef.current.get(snapshotKey);
    const bundle =
      cachedBundle ??
      (await createVerifiedDeliverySnapshotDeferred({
        timelineProject: session.timelineProject,
        visualProject: { ...session.visualProject, exportPreset },
        ...(compositionV1 === undefined ? {} : { compositionId: compositionV1.id }),
        projectRef: opaqueRenderRef(projectId, 'project'),
        viewport: { width, height },
        assets: Object.fromEntries(
          Object.entries(monitorAssetCatalog.assets).map(([id, asset]) => [
            id,
            {
              id,
              sha256: asset.sha256,
              bytes: asset.bytes,
              mimeType: asset.descriptor.mimeType,
              opaqueRef: `asset:${id}`,
            },
          ]),
        ),
      }));
    if (cachedBundle === undefined)
      verifiedDeliverySnapshotCacheRef.current.set(snapshotKey, bundle);
    const payload = {
      projectRef: opaqueRenderRef(projectId, 'project'),
      compositionId: opaqueRenderRef(compositionV1?.id, 'root-composition'),
      presetId: opaqueRenderRef(`${exportPreset}-${width}x${height}-${durationUs}`, 'preset'),
      reportRef,
      bundle,
    };
    const baseInspectionPromise = await deliveryPromiseForManifestDeferred({
      projectId,
      revision: 0,
      width,
      height,
      frameRate,
      durationUs,
      preset: exportPreset,
    });
    const inspectionPromise =
      bundle.plan.captionBurnIn === undefined
        ? baseInspectionPromise
        : {
            ...baseInspectionPromise,
            captions: {
              mode: 'burned-in' as const,
              required: true,
              burnIn: {
                styleRef: bundle.plan.captionBurnIn.styleRef,
                segments: bundle.plan.captionBurnIn.segments.map((segment) => ({
                  startUs: segment.startUs,
                  endUs: segment.endUs,
                  text: segment.text,
                  direction: segment.direction,
                })),
              },
            },
          };
    const queuedEntry: ExportProcessEntry = {
      id: entryId,
      filename,
      status: 'running',
      startedAt,
      channel: 'verified-delivery',
      exportJobId,
      reportRef,
      inspection: { state: 'queued', reportRef },
      inspectionPromise,
    };
    recordExportEntry(queuedEntry);
    try {
      await mediaClient.ensureProject(projectId, projectId);
      await mediaClient.enqueueRenderExport(projectId, exportJobId, payload);
      recordExportEntry(queuedEntry);
      setExportStatus('Verified delivery queued. Watch Jobs for render export evidence.');
      setExportProgress(1);
      exportToastTimerRef.current = window.setTimeout(() => {
        setExportStatus(undefined);
        setExportProgress(undefined);
      }, 4_000);
    } catch (error) {
      const message = userFacingDeliveryError(error, 'Verified delivery');
      recordExportEntry({
        ...queuedEntry,
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: message,
        inspection: { state: 'failed', reportRef, error: message },
      });
      setExportStatus(`Deliver failed: ${message}`);
      setExportProgress(undefined);
      exportToastTimerRef.current = window.setTimeout(() => {
        setExportStatus(undefined);
      }, 8_000);
    } finally {
      setExporting(false);
    }
  }, [
    blockedDeliveryEntry,
    exportPreset,
    exporting,
    ensureHydrationReady,
    mediaClient,
    projectId,
    recordExportEntry,
    session,
    monitorAssetCatalog.assets,
    verifiedDeliveryPreflight,
  ]);
  const issueAgentPanelCommand = useCallback((type: AgentPanelCommandType) => {
    setAgentPanelCommand((current) => ({
      serial: (current?.serial ?? 0) + 1,
      type,
    }));
  }, []);
  const runMenuAction = useCallback(
    (id: AppMenuActionId) => {
      const panelId = panelIdFromMenuAction(id);
      if (panelId !== undefined) {
        activatePanel(panelId);
        return;
      }
      switch (id) {
        case 'file.projects':
          onBackToLibrary();
          break;
        case 'file.export':
          void handleExport();
          break;
        case 'file.signOut':
          void signOut();
          break;
        case 'edit.undo':
          undo();
          break;
        case 'edit.redo':
          redo();
          break;
        case 'edit.delete':
          runSelectedClipAction('delete');
          break;
        case 'edit.duplicate':
          runSelectedClipAction('duplicate');
          break;
        case 'edit.commandPalette':
        case 'view.commandPalette':
          setPaletteOpen(true);
          break;
        case 'clip.split':
          runSelectedClipAction('split');
          break;
        case 'agent.open':
          activatePanel('agent');
          break;
        case 'agent.newTask':
          activatePanel('agent');
          issueAgentPanelCommand('new-task');
          break;
        case 'agent.executionMode':
        case 'agent.settings':
          setAgentSettingsOpen(true);
          break;
        case 'agent.stop':
          activatePanel('agent');
          issueAgentPanelCommand('stop');
          break;
        case 'agent.activity':
          activatePanel('agent');
          issueAgentPanelCommand('activity');
          break;
        case 'agent.active':
          break;
        default:
          break;
      }
    },
    [
      activatePanel,
      handleExport,
      issueAgentPanelCommand,
      onBackToLibrary,
      redo,
      runSelectedClipAction,
      signOut,
      undo,
    ],
  );
  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      dockviewApiRef.current = event.api;
      migrateLegacyDockLayout(window.localStorage);
      for (const stale of SUPERSEDED_DOCK_LAYOUT_KEYS) {
        window.localStorage.removeItem(stale);
      }
      // Drop the legacy single-key after migration copy.
      window.localStorage.removeItem(DOCK_LAYOUT_KEY);

      const mode = loadViewMode(window.localStorage);
      setViewMode(mode);
      applyDockLayout(event.api, mode);

      const persistDockLayout = () => {
        window.localStorage.setItem(
          dockLayoutKey(viewModeRef.current),
          JSON.stringify(event.api.toJSON()),
        );
      };
      event.api.onDidLayoutChange(persistDockLayout);
    },
    [applyDockLayout],
  );

  function Panel({ api }: IDockviewPanelProps) {
    const context = useContext(EditorPanelContext);
    if (context === undefined) throw new Error('editor panel context is unavailable');
    const { state, visualProject, controlPlaneProject, updateVisualProperty } = context;
    const importTimelineFiles = async (files: readonly File[]): Promise<void> => {
      const composition = context.timelineProject.compositions.root;
      if (composition === undefined) {
        context.showToast('The main timeline composition is unavailable.', 'error');
        return;
      }
      try {
        const cache = await originalAssetCachePromise;
        const registered: Array<{ readonly asset: BrowserAsset; readonly file: File }> = [];
        for (const [index, file] of files.entries()) {
          const assetId = timelineImportAssetId(file, index);
          const mimeType = file.type;
          if (mimeType.length === 0)
            throw new Error(`Unable to determine a media type for ${file.name}`);
          const bytes = await file.arrayBuffer();
          const sha256 = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
          const registration: BrowserAssetRegistration = {
            id: assetId,
            kind: importAssetKind(file),
            displayName: file.name,
            sha256,
            bytes: file.size,
            descriptor: { mimeType },
            locations: [{ kind: 'opfs-cache', ref: `opfs-${sha256.slice(0, 32)}` }],
          };
          await cache.put(
            {
              assetId,
              sha256,
              bytes: file.size,
              mimeType,
            },
            file,
          );
          try {
            const asset = await mediaClient.registerAsset(
              controlPlaneProject.controlPlaneProjectId,
              registration,
            );
            registered.push({ asset, file });
          } catch (error) {
            await cache.remove(assetId);
            throw error;
          }
        }

        const transactions = buildTimelineFileImportTransactions({
          composition,
          trackFlags: context.timelineTrackFlags,
          playheadUs: state.playheadUs,
          files,
          createAssetId: (_, index) =>
            registered[index]?.asset.id ?? timelineImportAssetId(files[index]!, index),
        });
        for (const transaction of transactions) context.dispatchTimeline(transaction);
        setMonitorAssetCatalog((previous) => ({
          assets: {
            ...previous.assets,
            ...Object.fromEntries(registered.map(({ asset }) => [asset.id, asset])),
          },
          derivativesByAssetId: previous.derivativesByAssetId,
        }));
        const imageCount = files.filter((file) => importAssetKind(file) === 'image').length;
        const timelineCount = transactions.length;
        context.showToast(
          imageCount > 0
            ? `${timelineCount} media file${timelineCount === 1 ? '' : 's'} added to the timeline. ${imageCount} still image${imageCount === 1 ? '' : 's'} registered in Assets only; use Add as sticker to place an overlay.`
            : `${registered.length} media file${registered.length === 1 ? '' : 's'} registered and added to the timeline.`,
          'success',
        );
      } catch (error) {
        context.showToast(
          `Media import failed: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    };
    if (api.id === 'inspector') {
      const objectId = resolveObjectIdForSelection(visualProject, state.selectedIds);
      const object = objectId === undefined ? undefined : visualProject.visualObjects[objectId];
      return (
        <LazyPanel label="Inspector">
          <LazyInspectorPanel
            object={object}
            {...(state.selectedIds[0] !== undefined
              ? { selectedClipId: state.selectedIds[0] }
              : {})}
            allObjects={visualProject.visualObjects}
            playheadUs={state.playheadUs}
            audioState={context.audioState}
            onAudioChange={(next) => context.setAudioState(next)}
            onSetStatic={updateVisualProperty}
            onDispatch={context.dispatchProject}
          />
        </LazyPanel>
      );
    }
    if (api.id === 'motion') {
      const objectId = resolveObjectIdForSelection(visualProject, state.selectedIds);
      const object = objectId === undefined ? undefined : visualProject.visualObjects[objectId];
      return (
        <LazyPanel label="Motion">
          <LazyMotionPanel
            object={object}
            allObjects={visualProject.visualObjects}
            compositionDurationUs={
              context.timelineProject.compositions.root?.durationUs ?? 30_000_000
            }
            playheadUs={state.playheadUs}
            onSeek={context.seek}
            onDispatch={context.dispatchProject}
            {...(state.selectedIds[0] !== undefined
              ? { selectedClipId: state.selectedIds[0] }
              : {})}
            onAddHtmlSceneToSelection={context.addHtmlSceneToSelectedClip}
            onAddMotionSceneToSelection={context.addMotionSceneToSelectedClip}
          />
        </LazyPanel>
      );
    }
    if (api.id === 'camera') {
      const composition = visualProject.compositions[visualProject.rootCompositionId];
      if (composition === undefined) return <p>Main composition is missing.</p>;
      return (
        <LazyPanel label="Camera">
          <LazyCameraPanel
            allObjects={visualProject.visualObjects}
            composition={composition}
            onDispatch={context.dispatchProject}
          />
        </LazyPanel>
      );
    }
    if (api.id === 'audio') {
      const clipIds =
        context.timelineProject.compositions.root?.tracks.flatMap((track) =>
          track.clips.map((clip) => clip.id),
        ) ?? [];
      return (
        <LazyPanel label="Audio">
          <LazyAudioPanel
            clipIds={clipIds}
            audioState={context.audioState}
            onAudioChange={(next) => context.setAudioState(next)}
          />
        </LazyPanel>
      );
    }
    if (api.id === 'effects') {
      const objectId = resolveObjectIdForSelection(visualProject, state.selectedIds);
      const canApplyEffects =
        objectId !== undefined &&
        isSingleVideoClipSelected(context.timelineProject, state.selectedIds);
      return (
        <LazyPanel label="Effects">
          <LazyEffectsPanel
            project={visualProject}
            objectId={objectId}
            canApplyEffects={canApplyEffects}
            onDispatch={(command) => {
              context.dispatchProject({
                label: `Effect: ${(command.payload as { effectId: string }).effectId}`,
                commands: [command],
              } as unknown as VisualObjectTransaction);
            }}
            showToast={context.showToast}
          />
        </LazyPanel>
      );
    }
    if (api.id === 'transitions') {
      return (
        <LazyPanel label="Transitions">
          <LazyTransitionsPanel
            project={visualProject}
            selectedClipIds={state.selectedIds}
            onAddTransition={(t) =>
              context.replaceVisualProject({
                ...visualProject,
                transitions: [
                  ...(visualProject.transitions ?? []),
                  { ...t, id: `transition-${Date.now()}` },
                ],
              })
            }
            onRemoveTransition={(transitionId) =>
              context.replaceVisualProject({
                ...visualProject,
                transitions: (visualProject.transitions ?? []).filter((t) => t.id !== transitionId),
              })
            }
            onUpdateTransition={(transitionId, updates) =>
              context.replaceVisualProject({
                ...visualProject,
                transitions: (visualProject.transitions ?? []).map((t) =>
                  t.id === transitionId ? { ...t, ...updates } : t,
                ),
              })
            }
            showToast={context.showToast}
          />
        </LazyPanel>
      );
    }
    if (api.id === 'color')
      return (
        <LazyPanel label="Color">
          <LazyColorPanel project={visualProject} onChange={context.replaceVisualProject} />
        </LazyPanel>
      );
    if (api.id === 'captions')
      return (
        <LazyPanel label="Captions">
          <LazyCaptionsPanel
            project={visualProject}
            playheadUs={state.playheadUs}
            onSeek={context.seek}
            onDispatch={context.dispatchProject}
            onTranscribe={context.transcribe}
            transcriptionAvailability={context.transcriptionAvailability}
            transcriptionError={context.transcriptionError}
            onProjectChange={(next) => context.replaceVisualProject(next)}
          />
        </LazyPanel>
      );
    if (api.id === 'timeline')
      return (
        <TimelinePanel
          project={context.timelineProject}
          playheadUs={state.playheadUs}
          playing={state.playing}
          selectedIds={state.selectedIds}
          viewport={context.timelineViewport}
          onViewportChange={context.onTimelineViewportChange}
          trackFlags={context.timelineTrackFlags}
          onTrackFlagsChange={context.onTimelineTrackFlagsChange}
          autoFit={context.timelineAutoFit}
          onAutoFitChange={context.onTimelineAutoFitChange}
          markers={visualProject.markers}
          provenance={
            state.selectedIds[0] === undefined
              ? []
              : provenanceRibbon(context.dualLensProjection, state.selectedIds[0])
          }
          onRevealInFlow={context.revealInFlow}
          onRevealNode={context.revealNodeInFlow}
          {...(context.dataLanes === undefined || context.artifacts === undefined
            ? {}
            : {
                dataLanes: context.dataLanes,
                artifacts: context.artifacts,
                onDispatchArtifacts: context.dispatchArtifacts,
              })}
          onTogglePlayback={context.togglePlayback}
          onSeek={context.seek}
          onToggleSelection={context.toggleSelection}
          onClearSelection={context.clearSelection}
          onDispatch={context.dispatchTimeline}
          onAddMarker={(timeUs, label) =>
            context.dispatchProject({
              label: `Add ${label}`,
              commands: [
                {
                  type: 'marker.add',
                  payload: {
                    marker: {
                      id: `marker-${timeUs}`,
                      timeUs,
                      label,
                      kind: 'marker',
                      color: JOY_COLORS.accent,
                    },
                  },
                },
              ],
            })
          }
          onRemoveMarker={(id) =>
            context.dispatchProject({
              label: `Remove marker ${id}`,
              commands: [{ type: 'marker.remove', payload: { markerId: id } }],
            })
          }
          onOpenAssetLibrary={() => context.activatePanel('media')}
          onImportFiles={importTimelineFiles}
          onEffectDrop={(effectId, clipId, _trackId) => {
            context.selectClips([clipId]);
            const objectId = resolveObjectIdForSelection(visualProject, [clipId]);
            if (!objectId) {
              context.showToast("Could not find this clip's target.", 'error');
              return;
            }
            void import('@joy-media/visual-effects').then(
              ({ effectRegistry, registerBuiltins }) => {
                registerBuiltins();
                const descriptor = effectRegistry.getEffect(effectId);
                if (!descriptor) return;
                const defaults: Record<string, unknown> = {};
                for (const p of descriptor.params) defaults[p.key] = p.defaultValue;
                context.dispatchProject({
                  label: `Effect: ${effectId}`,
                  commands: [
                    { type: 'effect.add', payload: { objectId, effectId, params: defaults } },
                  ],
                } as unknown as VisualObjectTransaction);
              },
            );
          }}
          onTransitionDrop={(transitionId, leftClipId, rightClipId, trackId) => {
            context.selectClips([leftClipId, rightClipId]);
            context.replaceVisualProject({
              ...visualProject,
              transitions: [
                ...(visualProject.transitions ?? []),
                {
                  id: `transition-${Date.now()}`,
                  trackId,
                  leftClipId,
                  rightClipId,
                  type: transitionId,
                  durationUs: 500_000,
                },
              ],
            });
          }}
          showToast={context.showToast}
        />
      );
    if (api.id === 'flow')
      return (
        <LazyPanel label="Flow">
          <LazyDualLensPanel
            projection={context.dualLensProjection}
            playheadUs={state.playheadUs}
            playing={state.playing}
            selectedClipIds={state.selectedIds}
            timelineViewport={context.timelineViewport}
            onTimelineViewportChange={context.onTimelineViewportChange}
            trackFlags={context.timelineTrackFlags}
            onTrackFlagsChange={context.onTimelineTrackFlagsChange}
            compositionId={context.timelineProject.rootCompositionId}
            onDispatch={context.dispatchTimeline}
            onTogglePlayback={context.togglePlayback}
            onSeek={context.seek}
            onSelectClips={context.selectClips}
            onRevealOnTimeline={context.revealOnTimeline}
            markers={visualProject.markers}
            onAddMarker={(timeUs, label) =>
              context.dispatchProject({
                label: `Add ${label}`,
                commands: [
                  {
                    type: 'marker.add',
                    payload: {
                      marker: {
                        id: `marker-${timeUs}-${Date.now()}`,
                        timeUs,
                        label,
                        kind: 'marker',
                        color: JOY_COLORS.accent,
                      },
                    },
                  },
                ],
              })
            }
            onRemoveMarker={(id) =>
              context.dispatchProject({
                label: `Remove marker ${id}`,
                commands: [{ type: 'marker.remove', payload: { markerId: id } }],
              })
            }
            {...(context.lensReveal === undefined ? {} : { reveal: context.lensReveal })}
            {...(context.workflowGraph === undefined
              ? {}
              : {
                  workflowGraph: context.workflowGraph,
                  onDispatchGraph: context.dispatchGraph,
                  specialistReview: (
                    <LazySpecialistReviewPanel
                      timeline={context.timelineProject}
                      creative={visualProject}
                      compositionId={context.timelineProject.rootCompositionId}
                      selectedClipIds={state.selectedIds}
                      projectId={context.timelineProject.id}
                      revisionId={() => context.session.projectRevisionId}
                      onApplyChangeSet={(label, document, artifacts, timelineTransaction) => {
                        if (!ensureHydrationReady()) return;
                        context.session.dispatchCompound(label, {
                          document,
                          artifacts,
                          ...(timelineTransaction === undefined
                            ? {}
                            : { timeline: timelineTransaction }),
                        });
                        context.bumpProjectRevision();
                      }}
                    />
                  ),
                })}
          />
        </LazyPanel>
      );
    if (api.id === 'jobs')
      return (
        <LazyPanel label="Jobs">
          <LazyJobsPanel
            projectId={controlPlaneProject.controlPlaneProjectId}
            projectTitle={controlPlaneProject.title}
          />
        </LazyPanel>
      );
    if (api.id === 'media')
      return (
        <LazyPanel label="Media">
          <LazyAssetLibraryPanel
            projectId={controlPlaneProject.controlPlaneProjectId}
            projectTitle={controlPlaneProject.title}
            onAddSticker={(asset) => void context.addStickerFromAsset(asset)}
            onEditWithAi={(asset) => {
              context.attachKiloCodeAsset(asset);
              context.activatePanel('agent');
            }}
            onInsertToTimeline={(asset) => {
              const composition = context.timelineProject.compositions.root;
              if (composition === undefined) {
                context.showToast('The main timeline composition is unavailable.', 'error');
                return;
              }
              context.dispatchTimeline(
                buildTimelineAssetInsertTransaction({
                  composition,
                  trackFlags: context.timelineTrackFlags,
                  playheadUs: state.playheadUs,
                  asset,
                }),
              );
              context.showToast(`${asset.displayName} added to the timeline.`, 'success');
            }}
            {...(context.artifacts === undefined ? {} : { artifacts: context.artifacts })}
            {...(context.dispatchArtifacts === undefined
              ? {}
              : { onDispatchArtifacts: context.dispatchArtifacts })}
          />
        </LazyPanel>
      );
    if (api.id === 'agent') {
      return (
        <LazyPanel label="Agent">
          <AgentPanelGate
            project={context.timelineProject}
            commandBus={context.agentCommandBus}
            audioState={context.audioState}
            selectedClipIds={state.selectedIds}
            playheadUs={state.playheadUs}
            onUndo={context.undo}
            session={context.session}
            settings={context.agentSettings}
            {...(context.agentPanelCommand === undefined
              ? {}
              : { command: context.agentPanelCommand })}
            attachedAssets={context.kiloCodeAttachedAssets}
            onDetachAsset={context.detachKiloCodeAsset}
            onAttachAsset={context.attachKiloCodeAsset}
          />
        </LazyPanel>
      );
    }
    if (api.id === 'history') {
      return (
        <LazyPanel label="History">
          <LazyHistoryPanel entries={context.historyEntries} onJumpTo={context.jumpToHistory} />
        </LazyPanel>
      );
    }
    if (api.id === 'diagnostics')
      return (
        <PanelShell
          title="Diagnostics"
          iconUrl={panelTabIconUrl('diagnostics')}
          className="diagnostics-panel"
        >
          <p>Proxy preview at quality {context.playback.quality}</p>
          <p>
            {context.playback.decodedFrames} frames decoded / {context.playback.droppedFrames}{' '}
            frames dropped
          </p>
          <p>Max media drift: {context.playback.maxDriftUs} µs</p>
        </PanelShell>
      );
    if (api.id === 'monitor') return <MonitorPanel />;
    if (api.id === 'workflows') {
      return (
        <LazyPanel label="Workflows">
          <LazyWorkflowsPanel
            session={context.session}
            selectedClipIds={state.selectedIds}
            playheadUs={state.playheadUs}
            onRun={async (workflowId, inputs) => {
              try {
                const runtime = await workflowRuntimeLoader();
                const outcome = await runtime.runner.runWorkflow(
                  context.session,
                  workflowId,
                  inputs,
                  {
                    productionRunStore: runtime.store,
                    authority: workflowAuthority,
                    firstPartyLibrary:
                      workflowId === 'joy.first-party.reference-social-cutdown.slice'
                        ? runtime.handlers.createEditorSessionFirstPartyLibrary(context.session)
                        : runtime.handlers.createProductionFirstPartyLibrary(),
                  },
                );
                context.bumpProjectRevision();
                return outcome;
              } catch (error) {
                console.error('Failed to run workflow:', error);
                return {
                  status: 'failed' as const,
                  workflowId,
                  runId: 'error',
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            }}
            onResume={async (runId, humanInputs, approval) => {
              try {
                const runtime = await workflowRuntimeLoader();
                const storedRun = await runtime.store.load(runId);
                const outcome = await runtime.runner.resumeWorkflow(
                  context.session,
                  runId,
                  humanInputs,
                  {
                    productionRunStore: runtime.store,
                    authority: workflowAuthority,
                    firstPartyLibrary:
                      storedRun?.workflowId === 'joy.first-party.reference-social-cutdown.slice'
                        ? runtime.handlers.createEditorSessionFirstPartyLibrary(context.session)
                        : runtime.handlers.createProductionFirstPartyLibrary(),
                    ...(approval.approvalId === undefined
                      ? {}
                      : { approvalId: approval.approvalId }),
                    ...(approval.approvalRequestedSeq === undefined
                      ? {}
                      : { approvalRequestedSeq: approval.approvalRequestedSeq }),
                    ...(approval.approvalExpiresAtSeq === undefined
                      ? {}
                      : { approvalExpiresAtSeq: approval.approvalExpiresAtSeq }),
                  },
                );
                context.bumpProjectRevision();
                return outcome;
              } catch (error) {
                console.error('Failed to resume workflow:', error);
                return {
                  status: 'failed' as const,
                  workflowId: 'unknown',
                  runId,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            }}
          />
        </LazyPanel>
      );
    }
    if (api.id === 'production') {
      return (
        <LazyPanel label="Production">
          <ProductionBoardPanelGate
            loadRuntime={workflowRuntimeLoader}
            authority={workflowAuthority}
            currentProjectRevision={context.session.projectRevisionId}
            artifacts={context.artifacts ?? { artifacts: {}, versions: {} }}
            dataLanes={context.dataLanes ?? []}
            assets={Object.values(monitorAssetCatalog.assets)}
            onOpenLink={(href) => {
              if (href.startsWith('#data-lane:') || href.startsWith('#artifact:')) {
                context.activatePanel('timeline');
                return;
              }
              if (href.startsWith('#asset:')) {
                context.activatePanel('media');
                return;
              }
              if (
                href.startsWith('#job:') ||
                href.startsWith('#provider:') ||
                href.startsWith('#report:')
              ) {
                context.activatePanel('jobs');
              }
            }}
          />
        </LazyPanel>
      );
    }
    if (api.id === 'plugins') {
      return (
        <LazyPanel label="Plugins">
          <PluginsPanelGate
            loadPluginHost={pluginHostLoader}
            onChange={context.bumpPluginRevision}
          />
        </LazyPanel>
      );
    }
    if (api.id === 'templates') {
      return (
        <LazyPanel label="Templates">
          <LazyTemplatesPanel
            session={context.session}
            selectedClipIds={state.selectedIds}
            playheadUs={state.playheadUs}
            onApplyTemplate={(seeded) => {
              if (!ensureHydrationReady()) return;
              void import('./content-template-transaction.js')
                .then(({ buildContentTemplateTransaction }) => {
                  buildContentTemplateTransaction(seeded, {
                    session: context.session,
                    selectedClipIds: state.selectedIds,
                    playheadUs: state.playheadUs,
                  });
                  setRevision((r) => r + 1);
                })
                .catch(() => {
                  context.showToast('Templates are unavailable in this session.', 'error');
                });
            }}
            showToast={(message, kind) => {
              console.log(`[Templates] ${kind}: ${message}`);
            }}
          />
        </LazyPanel>
      );
    }
    return (
      <article>
        <p>{`Panel ${panelLabel(api.id)}`}</p>
      </article>
    );
  }

  // Dockview forces a grid layout whenever this registry changes. Keeping it
  // stable prevents responsive panel rerenders from restoring old proportions
  // while a parent sash is being dragged.
  if (dockviewComponentsRef.current === null) {
    dockviewComponentsRef.current = { 'editor-panel': Panel };
  }
  const dockviewComponents = dockviewComponentsRef.current;

  return (
    <main
      data-document-sync-state={documentSyncState}
      data-document-sync-reason={documentSyncFailure?.reason}
      data-document-sync-recovery-hint={documentSyncFailure?.recoveryHint}
    >
      {legacyBackupAvailable && (
        <p className="local-recovery-banner" role="status" aria-live="polite">
          A local recovery backup is available.
          <button type="button" className="text-button" onClick={downloadLegacyBackup}>
            Download backup
          </button>
        </p>
      )}
      {documentSyncState === 'server-unavailable' && (
        <p className="export-toast" role="status" aria-live="polite">
          Saved locally; cloud sync is unavailable.{' '}
          {documentSyncFailure?.recoveryHint ?? 'Try again shortly; your local work is safe.'}
        </p>
      )}
      {documentSyncState === 'conflict-recovered' && recoveredCopy !== undefined && (
        <RecoveredCopyStatus
          copy={recoveredCopy}
          onOpen={() => {
            if (joySession.kind !== 'ready') return;
            onOpenRecoveredCopy(recoveredCopy, joySession.subject?.trim() || 'signed-in');
          }}
        />
      )}
      <header className="app-header">
        {exportProgress !== undefined && (
          <div
            className="export-progress"
            role="progressbar"
            aria-label="Export encoding progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(exportProgress * 100)}
          >
            <span style={{ width: `${Math.min(100, exportProgress * 100).toFixed(1)}%` }} />
          </div>
        )}
        {exportStatus !== undefined && (
          <div className="export-toast" role="status" aria-live="polite" dir="ltr">
            {exportStatus}
          </div>
        )}
        <div className="header-group" role="group" aria-label="Brand">
          <span className="app-brand">
            <img
              className="app-brand-logo"
              src="/assets/JoyCodeNew_32x32.png"
              alt=""
              width={24}
              height={24}
              decoding="async"
            />
            <strong>JOY Studio</strong>
          </span>
          <AppMenuBar
            canUndo={session.canUndo}
            canRedo={session.canRedo}
            hasSelection={state.selectedIds.length > 0}
            exporting={exporting}
            signedIn={joySession.kind === 'ready'}
            onAction={runMenuAction}
          />
        </div>
        <div className="header-spacer" aria-hidden="true" />
        <div className="header-group" role="group" aria-label="Edit">
          <button
            className="icon-button"
            disabled={!session.canUndo}
            onClick={undo}
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
          >
            <UndoIcon />
          </button>
          <button
            className="icon-button"
            disabled={!session.canRedo}
            onClick={redo}
            aria-label="Redo"
            title="Redo (Ctrl+Y)"
          >
            <RedoIcon />
          </button>
          <button
            className="icon-button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Command palette"
            title="Command palette (Ctrl+K)"
          >
            <CommandIcon />
          </button>
          <button
            className="icon-button"
            onClick={switchEditorView}
            aria-label={
              viewMode === 'vertical' ? 'Switch to Widescreen layout' : 'Switch to Vertical layout'
            }
            title={
              viewMode === 'vertical' ? 'Switch to Widescreen layout' : 'Switch to Vertical layout'
            }
            aria-pressed={viewMode === 'widescreen'}
          >
            {viewMode === 'vertical' ? <VerticalViewIcon /> : <WideViewIcon />}
          </button>
          <button
            className="icon-button"
            onClick={toggleKeyboardShortcuts}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            <PngMaskIcon src="/assets/24_keyboard.png" size={14} />
          </button>
        </div>
        <div className="header-group" role="group" aria-label="Deliver">
          <div className="header-menu">
            <button
              type="button"
              className="icon-button"
              disabled={exporting}
              aria-label="Export preset"
              aria-expanded={exportPresetOpen}
              data-guide="Export preset"
              onClick={() => {
                setExportPresetOpen((open) => !open);
                setProcessesOpen(false);
                setAccountOpen(false);
              }}
            >
              <PngMaskIcon src="/assets/24_export-presets.png" size={14} />
            </button>
            {exportPresetOpen && (
              <section className="header-dropdown" aria-label="Export preset">
                <h3>Export preset</h3>
                <ul className="export-preset-list">
                  {(
                    [
                      ['social-h264-aac', ExportIcon, 'Social H.264'],
                      ['reels-1080', ReelsIcon, 'Reels 1080×1920'],
                      ['shorts-1080', ReelsIcon, 'Shorts 1080×1920'],
                      ['youtube-1080', YoutubeIcon, 'YouTube 1920×1080'],
                      ['high-bitrate', HighBitrateIcon, 'High bitrate'],
                    ] as const
                  ).map(([id, Icon, label]) => (
                    <li key={id}>
                      <button
                        type="button"
                        className="icon-button icon-button-labeled"
                        disabled={exporting}
                        aria-pressed={exportPreset === id}
                        aria-label={label}
                        data-guide={label}
                        onClick={() => {
                          setExportPreset(id);
                          setExportPresetOpen(false);
                        }}
                      >
                        <Icon />
                        {label}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          <button
            type="button"
            className="header-export-btn"
            onClick={handleExport}
            disabled={exporting || !quickExportPreflight.allowed}
            aria-describedby={
              quickExportPreflight.allowed ? undefined : 'delivery-blocked-announcement'
            }
            aria-label={
              exporting
                ? 'Exporting…'
                : quickExportPreflight.allowed
                  ? 'Quick browser export MP4'
                  : 'Quick export unavailable'
            }
            data-guide={exporting ? 'Exporting…' : 'Quick export'}
            aria-busy={exporting}
          >
            <ExportIcon />
          </button>
          <button
            type="button"
            className="header-deliver-btn"
            onClick={handleVerifiedDelivery}
            disabled={
              exporting || blockedDeliveryEntry !== undefined || !verifiedDeliveryPreflight.allowed
            }
            aria-describedby={
              deliverBlockedReason === undefined ? undefined : 'delivery-blocked-announcement'
            }
            aria-label={
              deliverBlockedReason === undefined
                ? 'Deliver verified render'
                : 'Verified delivery unavailable'
            }
            title={
              deliverBlockedReason === undefined
                ? 'Deliver verified render'
                : 'Verified delivery unavailable'
            }
            data-guide="Deliver"
            aria-busy={exporting}
          >
            Deliver
          </button>
          <div className="delivery-blocked-reasons">
            {deliveryBlockedFailures.length > 0 && (
              <DeliveryBlockedStatus id="delivery-blocked" failures={deliveryBlockedFailures} />
            )}
          </div>
          <div className="header-menu">
            <button
              className="icon-button"
              aria-label="Recent processes"
              aria-expanded={processesOpen}
              title="Recent processes"
              onClick={() => {
                setProcessesOpen((open) => !open);
                setAccountOpen(false);
                setExportPresetOpen(false);
              }}
            >
              <PngMaskIcon src="/assets/24_recent-exports.png" size={14} />
            </button>
            {processesOpen && (
              <section className="header-dropdown" aria-label="Recent processes">
                <h3>Recent processes</h3>
                {exportHistory.length === 0 ? (
                  <p className="empty-hint">No exports yet. Use Export to create an MP4.</p>
                ) : (
                  <ul className="process-list">
                    {exportHistory.map((entry) => {
                      return (
                        <li key={entry.id} className={`process-row process-${entry.status}`}>
                          <span className="process-dot" aria-hidden="true" />
                          <span className="process-name">
                            <bdi dir="auto">{entry.filename}</bdi>
                          </span>
                          <span className="process-meta">{recentProcessLabel(entry)}</span>
                          {lastExportRef.current?.entryId === entry.id && (
                            <a
                              className="icon-button"
                              href={lastExportRef.current.url}
                              download={entry.filename}
                              aria-label={`Download ${entry.filename} again`}
                              title="Download again"
                            >
                              <DownloadIcon />
                            </a>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <LazyPanel label="Delivery report">
                  <LazyDeliveryReportPanel entries={exportHistory} />
                </LazyPanel>
              </section>
            )}
          </div>
          <div className="header-menu">
            <button
              className="icon-button"
              aria-label="Joy Studio account"
              aria-expanded={accountOpen}
              title={
                joySession.kind === 'ready'
                  ? `Signed in · ${joySession.displayName ?? joySession.subject ?? 'Joy Studio'}`
                  : joySession.kind === 'no-access'
                    ? 'Signed in, Joy Studio access not enabled'
                    : joySession.kind === 'signed-out'
                      ? 'Signed out'
                      : joySession.kind === 'unavailable'
                        ? 'Sign-in status unavailable'
                        : 'Joy Studio account'
              }
              onClick={() => {
                setAccountOpen((open) => !open);
                setProcessesOpen(false);
                setExportPresetOpen(false);
                refreshJoySession();
              }}
            >
              <UserIcon />
              <span className={`session-dot session-${joySession.kind}`} aria-hidden="true" />
            </button>
            {accountOpen && (
              <section
                ref={accountDropdownRef}
                className="header-dropdown account-dropdown"
                aria-label="Joy Studio account"
              >
                {joySession.kind === 'ready' && (
                  <>
                    <div className="account-card">
                      <div className="account-card-avatar" aria-hidden="true">
                        {joySession.avatarObjectUrl !== undefined ? (
                          <img
                            className="account-card-avatar-img"
                            src={joySession.avatarObjectUrl}
                            alt=""
                          />
                        ) : (
                          (
                            (joySession.displayName ?? joySession.subject ?? 'J')
                              .replace(/^@/, '')
                              .trim()
                              .charAt(0) || 'J'
                          ).toUpperCase()
                        )}
                      </div>
                      <div className="account-card-meta">
                        <p className="account-card-status">Signed in</p>
                        {(joySession.displayName ?? joySession.subject) !== undefined && (
                          <p className="account-card-subject">
                            <bdi>{joySession.displayName ?? joySession.subject}</bdi>
                          </p>
                        )}
                      </div>
                      <span className="account-card-dot session-ready" aria-hidden="true" />
                    </div>
                    <button
                      type="button"
                      className="account-sign-out"
                      title="Sign out of Joy Studio"
                      onClick={() => void signOut()}
                    >
                      <LogoutIcon />
                      Sign out
                    </button>
                  </>
                )}
                {joySession.kind === 'no-access' && (
                  <p className="empty-hint">Joy Studio access is not enabled for this account.</p>
                )}
                {joySession.kind === 'signed-out' && (
                  <p className="empty-hint">Returning to login…</p>
                )}
                {joySession.kind === 'unknown' && <p className="empty-hint">Checking session…</p>}
                {joySession.kind === 'unavailable' && (
                  <p className="empty-hint">
                    Sign-in status could not be verified. Try again shortly.
                  </p>
                )}
              </section>
            )}
          </div>
        </div>
      </header>

      {paletteOpen && (
        <section ref={paletteRef} className="palette" aria-label="Command palette">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands"
          />
          {searchActions(query).map((action) => (
            <button key={action.id} onClick={() => executeAction(action.id)}>
              {action.title}
              <kbd>{action.shortcut}</kbd>
            </button>
          ))}
        </section>
      )}
      <video ref={videoRef} className="playback-media" playsInline muted={false} />
      <EditorPanelContext.Provider
        value={{
          state,
          previewVideoFrame,
          monitorMediaStatus,
          clipFrameCache: clipFrameCacheRef.current,
          clipFrameTick,
          timelineProject: session.timelineProject,
          visualProject: session.visualProject,
          controlPlaneProject,
          playback: scheduler.current.metrics,
          canUndo: session.canUndo,
          canRedo: session.canRedo,
          historyEntries: session.historyEntries,
          dualLensProjection,
          lensReveal,
          revealInFlow,
          revealNodeInFlow,
          revealOnTimeline,
          workflowGraph: session.graphEnabled ? session.workflowGraph : undefined,
          dispatchGraph,
          dataLanes,
          artifacts: session.graphEnabled ? session.artifacts : undefined,
          dispatchArtifacts,
          togglePlayback,
          seek,
          toggleSelection: (id) =>
            setState((current) => ({
              ...current,
              selectedIds: toggleSelection({ clipIds: current.selectedIds }, id).clipIds,
            })),
          selectClips,
          clearSelection: () => setState((current) => ({ ...current, selectedIds: [] })),
          dispatchTimeline,
          updateVisualProperty,
          dispatchProject,
          replaceVisualProject,
          addStickerFromAsset,
          addHtmlSceneToSelectedClip,
          addMotionSceneToSelectedClip,
          stickerTick,
          audioState,
          setAudioState,
          transcribe,
          transcriptionAvailability,
          transcriptionError,
          undo,
          redo,
          jumpToHistory,
          session,
          activatePanel,
          agentContext: undefined,
          agentCommandBus: agentCommandBusRef.current,
          agentSettings,
          agentPanelCommand,
          kiloCodeAttachedAssets,
          attachKiloCodeAsset,
          detachKiloCodeAsset,
          pluginHost: undefined,
          bumpProjectRevision,
          bumpPluginRevision,
          showToast,
          motionStudioOpen: motionStudioSceneId !== undefined,
          openMotionStudio: (sceneId: string) => setMotionStudioSceneId(sceneId),
          closeMotionStudio: () => setMotionStudioSceneId(undefined),
          effectStudioOpen: effectStudioSession !== undefined,
          openEffectStudio: (recipeId: string, objectId?: string) =>
            setEffectStudioSession({
              recipeId,
              ...(objectId !== undefined ? { objectId } : {}),
            }),
          closeEffectStudio: () => setEffectStudioSession(undefined),
          timelineViewport,
          onTimelineViewportChange: setTimelineViewport,
          timelineTrackFlags,
          onTimelineTrackFlagsChange: setTimelineTrackFlags,
          timelineAutoFit,
          onTimelineAutoFitChange: setTimelineAutoFit,
        }}
      >
        <DockviewReact
          className="workspace"
          components={dockviewComponents}
          defaultTabComponent={PanelTab}
          disableTabsOverflowList
          onReady={onReady}
        />
      </EditorPanelContext.Provider>
      {motionStudioSceneId !== undefined && (
        <LazyPanel label="Motion Studio">
          <LazyMotionStudioShell
            key={motionStudioSceneId}
            sceneId={motionStudioSceneId}
            onClose={() => setMotionStudioSceneId(undefined)}
          />
        </LazyPanel>
      )}
      {effectStudioSession !== undefined && (
        <LazyPanel label="Effect Studio">
          <LazyEffectStudioShell
            key={effectStudioSession.recipeId}
            recipeId={effectStudioSession.recipeId}
            canApply={
              effectStudioSession.objectId !== undefined ||
              resolveObjectIdForSelection(session.visualProject, state.selectedIds) !== undefined
            }
            onApply={(effects) => {
              const objectId =
                effectStudioSession.objectId ??
                resolveObjectIdForSelection(session.visualProject, state.selectedIds);
              if (objectId === undefined) {
                showToast('Select a clip to apply the recipe.', 'info');
                return;
              }
              const existing = session.visualProject.visualObjects[objectId]?.effects ?? [];
              const commands = [
                ...existing.map((effect) => ({
                  type: 'effect.remove' as const,
                  payload: { objectId, effectInstanceId: effect.id },
                })),
                ...effects
                  .filter((effect) => effect.enabled)
                  .map((effect) => ({
                    type: 'effect.add' as const,
                    payload: {
                      objectId,
                      effectId: effect.effectId,
                      params: effect.params,
                    },
                  })),
              ];
              if (commands.length === 0) {
                showToast('This recipe has no active effects to apply.', 'info');
                return;
              }
              dispatchProject({
                label: 'Apply Effect Recipe',
                commands,
              } as unknown as VisualObjectTransaction);
              showToast('Effect recipe applied to the clip.', 'success');
              setEffectStudioSession(undefined);
            }}
            onClose={() => setEffectStudioSession(undefined)}
          />
        </LazyPanel>
      )}
      {agentSettingsOpen && (
        <LazyPanel label="Agent settings">
          <LazyAgentSettingsDialog
            settings={agentSettings}
            onChange={setAgentSettings}
            onClose={() => setAgentSettingsOpen(false)}
          />
        </LazyPanel>
      )}
      {toasts.length > 0 && (
        <div className="toast-container" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast toast-${toast.kind ?? 'info'}`} role="alert">
              <span className="toast-message">{toast.message}</span>
              <button
                type="button"
                className="toast-close"
                aria-label="Dismiss"
                onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
      )}
      {keyboardShortcutsOpen && (
        <div
          ref={shortcutsDialogRef}
          className="shortcuts-overlay"
          role="dialog"
          aria-label="Keyboard shortcuts"
          aria-modal="true"
          tabIndex={-1}
        >
          <div className="shortcuts-panel">
            <header className="shortcuts-header">
              <h2>Keyboard Shortcuts</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Close shortcuts"
                onClick={() => setKeyboardShortcutsOpen(false)}
              >
                <CloseIcon />
              </button>
            </header>
            <div className="shortcuts-list">
              {[
                { keys: 'Ctrl+Z', action: 'Undo' },
                { keys: 'Ctrl+Y', action: 'Redo' },
                { keys: 'Ctrl+K', action: 'Command palette' },
                { keys: 'Ctrl+D', action: 'Duplicate clip' },
                { keys: 'Space', action: 'Toggle playback' },
                { keys: '← / →', action: 'Step back / forward 1s' },
                { keys: 'Shift+← / Shift+→', action: 'Fine step 100ms' },
                { keys: 'Home / End', action: 'Go to start / end' },
                { keys: 'Delete / Backspace', action: 'Delete selected clip or marker' },
                { keys: 'S', action: 'Split clip at playhead' },
                { keys: '?', action: 'Toggle this panel' },
              ].map(({ keys, action }) => (
                <div key={keys} className="shortcut-row">
                  <span className="shortcut-action">{action}</span>
                  <kbd className="shortcut-keys">{keys}</kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function formatTimecode(timeUs: number, fps = 30): string {
  const totalFrames = Math.max(0, Math.floor((timeUs / 1_000_000) * fps));
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

function timelineImportAssetId(file: Pick<File, 'name'>, index: number): string {
  const stem = file.name
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 72);
  const prefix = stem.length > 0 ? stem : 'media';
  return `${prefix}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 128);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function MonitorPanel() {
  const context = useContext(EditorPanelContext);
  if (context === undefined) throw new Error('editor panel context is unavailable');
  const {
    state,
    previewVideoFrame,
    monitorMediaStatus,
    clipFrameCache,
    clipFrameTick,
    visualProject,
    timelineProject,
    stickerTick,
    togglePlayback,
    seek,
    dispatchProject,
    showToast,
  } = context;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [monitorDragOver, setMonitorDragOver] = useState(false);
  const rendererRef = useRef<BrowserPixiRenderer | null>(null);
  const planRenderFrameRef = useRef<PlanRenderFrame | undefined>(undefined);
  const paintRef = useRef<() => void>(() => {});
  const sceneCacheRef = useRef<HtmlSceneSurfaceCache | undefined>(undefined);
  const motionSceneCacheRef = useRef<MotionSceneSurfaceCache | undefined>(undefined);
  const [sceneTick, setSceneTick] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [viewerZoom, setViewerZoom] = useState<'fit' | '50' | '100' | '200'>('fit');
  const [fullscreen, setFullscreen] = useState(false);
  const [zoomDrawerOpen, setZoomDrawerOpen] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const transportRef = useRef<HTMLDivElement | null>(null);
  const zoomDrawerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let disposed = false;
    void loadPlanRenderFrame()
      .then((planRenderFrame) => {
        if (disposed) return;
        planRenderFrameRef.current = planRenderFrame;
        paintRef.current();
        setSceneTick((tick) => tick + 1);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      disposed = true;
      planRenderFrameRef.current = undefined;
    };
  }, []);
  useAccessibleDialog({
    open: zoomDrawerOpen,
    containerRef: zoomDrawerRef,
    onClose: () => setZoomDrawerOpen(false),
    initialFocusSelector:
      'button[aria-pressed="true"], button[aria-label="Close scale options"], button:not([disabled])',
  });

  useEffect(() => {
    let disposed = false;
    void Promise.all([import('./html-scene-surfaces.js'), import('./motion-scene-surfaces.js')])
      .then(([htmlSceneModule, motionSceneModule]) => {
        if (disposed) return;
        sceneCacheRef.current = new htmlSceneModule.HtmlSceneSurfaceCache();
        motionSceneCacheRef.current = new motionSceneModule.MotionSceneSurfaceCache(
          window.localStorage,
        );
        setSceneTick((tick) => tick + 1);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      disposed = true;
      sceneCacheRef.current?.destroy();
      motionSceneCacheRef.current?.destroy();
      sceneCacheRef.current = undefined;
      motionSceneCacheRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (!zoomDrawerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = transportRef.current;
      if (root === null || root.contains(event.target as Node)) return;
      setZoomDrawerOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [zoomDrawerOpen]);

  useEffect(() => {
    let cancelled = false;
    const planRenderFrame = planRenderFrameRef.current;
    if (planRenderFrame === undefined) return;
    const plan = planRenderFrame({
      bundle: createRenderBundle({
        timelineProject,
        visualProject,
        seed: `preview:${visualProject.id}`,
      }),
      timeUs: state.playheadUs,
      imageSizesByObjectId: imageSizesFromCache(),
    });
    void syncStickerBitmapTargets(
      plannedStillBitmapTargets(visualProject, plan.captureRequirements),
    )
      .then(() => {
        if (cancelled) return;
        setSceneTick((tick) => tick + 1);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('Failed to sync sticker bitmaps', error);
      });
    return () => {
      cancelled = true;
    };
  }, [sceneTick, state.playheadUs, stickerTick, timelineProject, visualProject]);

  paintRef.current = (): void => {
    const renderer = rendererRef.current;
    if (renderer === null) return;
    const planRenderFrame = planRenderFrameRef.current;
    if (planRenderFrame === undefined) return;
    const composition = visualProject.compositions[visualProject.rootCompositionId];
    if (composition === undefined) return;
    const plan = planRenderFrame({
      bundle: createRenderBundle({
        timelineProject,
        visualProject,
        seed: `preview:${visualProject.id}`,
      }),
      timeUs: state.playheadUs,
      viewport: { width: composition.width, height: composition.height },
      imageSizesByObjectId: imageSizesFromCache(),
    });
    const visualFrame = plan.frame;
    const frame =
      previewVideoFrame === undefined
        ? visualFrame
        : withVideoFrameNode(visualFrame, previewVideoFrame.node);
    const videoBitmaps = new Map(clipFrameCache);
    if (previewVideoFrame !== undefined) {
      videoBitmaps.set(previewVideoFrame.node.id, previewVideoFrame.bitmap);
    }
    for (const target of htmlSceneCaptureTargetsForRequirements(
      visualProject,
      plan.captureRequirements,
    )) {
      const bitmap = sceneCacheRef.current?.bitmaps().get(target.objectId);
      if (bitmap !== undefined) videoBitmaps.set(target.objectId, bitmap);
    }
    for (const target of plannedMotionSceneCaptureTargets(
      visualProject,
      plan.captureRequirements,
    )) {
      const bitmap = motionSceneCacheRef.current?.bitmaps().get(target.objectId);
      if (bitmap !== undefined) videoBitmaps.set(target.objectId, bitmap);
    }
    for (const target of plannedStillBitmapTargets(visualProject, plan.captureRequirements)) {
      const bitmap = stickerImageCache.get(target.objectId);
      if (bitmap !== undefined) videoBitmaps.set(target.objectId, bitmap);
    }
    renderer.render(frame, videoBitmaps);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let disposed = false;
    void import('@joy-media/renderer-pixi/browser')
      .then(({ createBrowserPixiRenderer }) => createBrowserPixiRenderer({ parent: container }))
      .then((created) => {
        if (disposed) {
          created.destroy();
          return;
        }
        rendererRef.current = created;
        paintRef.current();
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      disposed = true;
      const existing = rendererRef.current;
      rendererRef.current = null;
      if (existing !== null) existing.destroy();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const planRenderFrame = planRenderFrameRef.current;
    if (planRenderFrame === undefined) return;
    const plan = planRenderFrame({
      bundle: createRenderBundle({
        timelineProject,
        visualProject,
        seed: `preview:${visualProject.id}`,
      }),
      timeUs: state.playheadUs,
      imageSizesByObjectId: imageSizesFromCache(),
    });
    const sceneCache = sceneCacheRef.current;
    if (sceneCache === undefined) return;
    void sceneCache
      .sync(htmlSceneCaptureTargetsForRequirements(visualProject, plan.captureRequirements))
      .then(() => {
        if (cancelled) return;
        setSceneTick((value) => value + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [sceneTick, state.playheadUs, timelineProject, visualProject]);

  useEffect(() => {
    let cancelled = false;
    const planRenderFrame = planRenderFrameRef.current;
    if (planRenderFrame === undefined) return;
    const plan = planRenderFrame({
      bundle: createRenderBundle({
        timelineProject,
        visualProject,
        seed: `preview:${visualProject.id}`,
      }),
      timeUs: state.playheadUs,
      imageSizesByObjectId: imageSizesFromCache(),
    });
    const motionSceneCache = motionSceneCacheRef.current;
    if (motionSceneCache === undefined) return;
    void motionSceneCache
      .sync(plannedMotionSceneCaptureTargets(visualProject, plan.captureRequirements))
      .then(() => {
        if (cancelled) return;
        const diagnostic = motionSceneCache.diagnostics()[0];
        setError(diagnostic?.message);
        setSceneTick((value) => value + 1);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [sceneTick, state.playheadUs, timelineProject, visualProject]);

  useEffect(() => {
    paintRef.current();
  }, [
    clipFrameCache,
    clipFrameTick,
    previewVideoFrame,
    state.playheadUs,
    visualProject,
    sceneTick,
    viewerZoom,
  ]);

  const composition = visualProject.compositions[visualProject.rootCompositionId];
  const width = composition?.width ?? 1080;
  const height = composition?.height ?? 1920;
  const durationUs = composition?.durationUs ?? 30_000_000;
  const zoomScale =
    viewerZoom === 'fit' ? 1 : viewerZoom === '50' ? 0.5 : viewerZoom === '200' ? 2 : 1;
  const zoomLabel =
    viewerZoom === 'fit'
      ? 'Fit'
      : viewerZoom === '50'
        ? '50%'
        : viewerZoom === '200'
          ? '200%'
          : '100%';

  const toggleFullscreen = () => {
    const el = panelRef.current;
    if (el === null) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen();
      setFullscreen(false);
      return;
    }
    void el.requestFullscreen().then(() => setFullscreen(true));
  };

  const handleMonitorEffectDragOver = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes('application/x-joy-effect')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setMonitorDragOver(true);
  }, []);

  const handleMonitorEffectDragLeave = useCallback(() => {
    setMonitorDragOver(false);
  }, []);

  const handleMonitorEffectDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setMonitorDragOver(false);
      const raw = event.dataTransfer.getData('application/x-joy-effect');
      if (!raw) return;
      try {
        const payload = JSON.parse(raw) as { kind: string; effectId: string; source: string };
        const objectId = resolveObjectIdForSelection(visualProject, state.selectedIds);
        if (!objectId || !isSingleVideoClipSelected(timelineProject, state.selectedIds)) {
          showToast('Select one video clip before dropping an effect.', 'info');
          return;
        }
        void import('@joy-media/visual-effects').then(({ effectRegistry, registerBuiltins }) => {
          registerBuiltins();
          const descriptor = effectRegistry.getEffect(payload.effectId);
          if (!descriptor) return;
          const defaults: Record<string, unknown> = {};
          for (const p of descriptor.params) defaults[p.key] = p.defaultValue;
          dispatchProject({
            label: `Effect: ${payload.effectId}`,
            commands: [
              {
                type: 'effect.add',
                payload: { objectId, effectId: payload.effectId, params: defaults },
              },
            ],
          } as unknown as VisualObjectTransaction);
        });
      } catch {
        /* ignore malformed */
      }
    },
    [dispatchProject, timelineProject, visualProject, state.selectedIds, showToast],
  );

  return (
    <article className="monitor-panel" ref={panelRef}>
      {error !== undefined && <p className="monitor-error">{error}</p>}
      <div
        className={`monitor-canvas-wrap${monitorDragOver ? ' drag-over' : ''}`}
        onDragOver={handleMonitorEffectDragOver}
        onDragLeave={handleMonitorEffectDragLeave}
        onDrop={handleMonitorEffectDrop}
      >
        <div
          ref={containerRef}
          className="monitor-canvas"
          style={viewerZoom === 'fit' ? undefined : { transform: `scale(${zoomScale})` }}
        />
        {monitorMediaStatus !== undefined && monitorMediaStatus.state !== 'ready' && (
          <p className="monitor-media-state">
            {monitorMediaStatus.message} {monitorMediaStatus.action.label}.
          </p>
        )}
      </div>
      <div className="monitor-transport" ref={transportRef}>
        {zoomDrawerOpen && (
          <div
            ref={zoomDrawerRef}
            className="monitor-zoom-drawer"
            id="monitor-zoom-drawer"
            role="dialog"
            aria-label="Preview scale"
            aria-modal="true"
            tabIndex={-1}
          >
            <div className="monitor-zoom-drawer-head">
              <strong>Preview scale</strong>
              <button
                type="button"
                className="monitor-transport-btn"
                aria-label="Close scale options"
                title="Close"
                onClick={() => setZoomDrawerOpen(false)}
              >
                <CloseIcon />
              </button>
            </div>
            <div className="monitor-zoom-group" role="group" aria-label="Preview zoom">
              {(
                [
                  ['fit', 'Fit'],
                  ['50', '50%'],
                  ['100', '100%'],
                  ['200', '200%'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className="monitor-zoom-chip"
                  aria-pressed={viewerZoom === id}
                  aria-label={`Zoom ${label}`}
                  title={`Zoom ${label}`}
                  onClick={() => {
                    setViewerZoom(id);
                    setZoomDrawerOpen(false);
                  }}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                className="monitor-transport-btn"
                aria-pressed={fullscreen}
                aria-label="Fullscreen preview"
                data-guide="Full"
                onClick={() => {
                  toggleFullscreen();
                  setZoomDrawerOpen(false);
                }}
              >
                <FullscreenIcon />
              </button>
            </div>
          </div>
        )}
        <div className="monitor-transport-start">
          <span className="monitor-meta" dir="ltr">
            {width} × {height} · {formatTimecode(state.playheadUs)}
          </span>
        </div>
        <div className="monitor-transport-controls">
          <button
            type="button"
            className="monitor-transport-btn"
            aria-label="Seek back 1s"
            title="Seek back 1s (←)"
            onClick={() => seek(Math.max(0, state.playheadUs - 1_000_000))}
          >
            <SkipBackIcon />
          </button>
          <button
            type="button"
            className="monitor-transport-btn"
            aria-label={state.playing ? 'Pause' : 'Play'}
            title={state.playing ? 'Pause (Space)' : 'Play (Space)'}
            onClick={togglePlayback}
          >
            {state.playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            type="button"
            className="monitor-transport-btn"
            aria-label="Seek forward 1s"
            title="Seek forward 1s (→)"
            onClick={() => seek(Math.min(durationUs, state.playheadUs + 1_000_000))}
          >
            <SkipForwardIcon />
          </button>
        </div>
        <div className="monitor-transport-end">
          <button
            type="button"
            className="monitor-transport-btn"
            aria-label={`Preview scale (${zoomLabel})`}
            aria-expanded={zoomDrawerOpen}
            aria-controls="monitor-zoom-drawer"
            aria-pressed={zoomDrawerOpen}
            data-guide="Scale"
            onClick={() => setZoomDrawerOpen((open) => !open)}
          >
            <ZoomInIcon />
          </button>
        </div>
      </div>
    </article>
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined') {
    const buffer = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return fallbackSha256Hex(bytes);
}

void sha256Hex;

function fallbackSha256Hex(bytes: Uint8Array): string {
  // RFC 6234 SHA-256 — used only when SubtleCrypto is unavailable (e.g. older
  // test environments). The browser path is what the export UI runs in.
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const l = bytes.length;
  const padLen = ((l + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(padLen);
  padded.set(bytes);
  padded[l] = 0x80;
  const bitLen = BigInt(l) * 8n;
  for (let i = 0; i < 8; i++) padded[padLen - 1 - i] = Number((bitLen >> BigInt(i * 8)) & 0xffn);
  const w = new Uint32Array(64);
  for (let chunk = 0; chunk < padLen; chunk += 64) {
    for (let i = 0; i < 16; i++)
      w[i] =
        (padded[chunk + i * 4]! << 24) |
        (padded[chunk + i * 4 + 1]! << 16) |
        (padded[chunk + i * 4 + 2]! << 8) |
        padded[chunk + i * 4 + 3]!;
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (S0 + maj) >>> 0;
      h = g!;
      g = f!;
      f = e!;
      e = (d! + temp1) >>> 0;
      d = c!;
      c = b!;
      b = a!;
      a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0]! + a!) >>> 0;
    H[1] = (H[1]! + b!) >>> 0;
    H[2] = (H[2]! + c!) >>> 0;
    H[3] = (H[3]! + d!) >>> 0;
    H[4] = (H[4]! + e!) >>> 0;
    H[5] = (H[5]! + f!) >>> 0;
    H[6] = (H[6]! + g!) >>> 0;
    H[7] = (H[7]! + h!) >>> 0;
  }
  return Array.from(H)
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}
