import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { DockviewReact } from 'dockview';
import type { DockviewApi, DockviewReadyEvent, IDockviewPanelProps } from 'dockview';
import { PanelTab } from './PanelTab.js';
import { AppMenuBar } from './AppMenuBar.js';
import { panelIdFromMenuAction, type AppMenuActionId } from './app-menu.js';
import {
  createHtmlMediaDecoder,
  createHtmlVideoMediaClock,
  PlaybackDiagnosticsSession,
  PlaybackScheduler,
  videoFrameNodeFromDecoded,
  withVideoFrameNode,
  type HtmlMediaDecoder,
  type ImageDataLike,
  type MediaClock,
  type PlaybackDiagnosticsSnapshot,
  type VideoFramePresentationMetadata,
  type VideoClipSpec,
} from '@joy-media/playback-engine';
import type {
  ColorGradeIR,
  EffectInstanceIR,
  RenderFrameIR,
  VideoFrameNode,
} from '@joy-media/render-ir';
import { WORKER_PROTOCOL_VERSION } from '@joy-media/job-protocol';
import { toggleSelection, duplicateClipCommand } from '@joy-media/timeline-engine';
import type { TimelineTrackView, TimelineViewport } from '@joy-media/timeline-engine';
import type {
  CommandTransaction,
  GraphTransaction,
  ArtifactStore,
  ArtifactTransaction,
} from '@joy-media/commands';
import type { CreativeBriefRequestV1, CreativeBriefV1, EditorContext } from '@joy-media/agent-tools';
import { buildEditorContext } from '@joy-media/agent-tools';
import type { HistoryEntry } from './editor-session.js';
import type {
  AnimationDescriptorV1,
  AssetRecordV1,
  AnimatablePropertyV1,
  JoyProjectV1,
  ProjectRevisionId,
  SpikeProject,
  TransitionV1,
  VideoClip,
  VisualObjectV1,
} from '@joy-media/project-schema';
import { normalizePlaybackRate, sourceTimeAtVideoClipTime } from '@joy-media/project-schema';
import {
  removeClipPropertyAnimations,
  type VisualObjectTransaction,
} from '@joy-media/property-system';
import {
  evaluateCameraExpressionTransform,
  evaluateColorGradeAtTime,
  evaluateAudioBusAtTime,
  evaluateAudioClipAtTime,
  evaluateProjectAudioAtTime,
} from '@joy-media/evaluator';
import {
  buildRenderFrameIR,
  clipTimesFromTracks,
  evaluateEffectInstances,
  isTransitionActive,
  normalizeColorGrade,
  type BuildRenderFrameOptions,
  type ResolvedObject,
} from '@joy-media/visual-object-renderer';
import { registerBuiltins, effectRegistry } from '@joy-media/visual-effects';
import {
  createAnimatedImageFrameSource,
  type AnimatedImageFrameSource,
} from './animated-image-decoder.js';
import { inspectImageAnimation } from './animated-image-metadata.js';
import {
  activePreparedExportClipAt,
  hasRenderableExportMedia,
  isExportDurationTimelineClip,
  isExportVisualTimelineClip,
  missingColorLutExportDependencies,
} from './export-media-readiness.js';

registerBuiltins();

const CLIP_FRAME_CACHE_LIMIT = 120;
const MotionStudioShell = lazy(() =>
  import('./motion-studio/index.js').then((module) => ({ default: module.MotionStudioShell })),
);
const EffectStudioShell = lazy(() =>
  import('./effect-studio/index.js').then((module) => ({ default: module.EffectStudioShell })),
);
const CreativeBriefPanel = lazy(() =>
  import('./CreativeBriefPanel.js').then((module) => ({ default: module.CreativeBriefPanel })),
);

import {
  createBrowserPixiRenderer,
  type BrowserPixiRenderer,
} from '@joy-media/renderer-pixi/browser';
import { applyColorGradeToPixels } from '@joy-media/renderer-pixi';
import {
  downloadBrowserMp4,
  selectBrowserMp4MimeType,
  triggerBrowserDownload,
  type BrowserExportManifest,
  type BrowserExportResult,
} from '@joy-media/renderer-pixi/browser-export';
import { HtmlSceneSurfaceCache } from './html-scene-surfaces.js';
import { EMPTY_EDITOR_STATE, searchActions } from './editor-state.js';
import { EditorSession } from './editor-session.js';
import { updateUniversalTimelineForTransaction } from './universal-placement.js';
import { TimelinePanel } from './TimelinePanel.js';
import { buildTimelineMediaImportTransaction } from './timeline-media-import.js';
import { buildTimelineElementDocument } from './place-timeline-element.js';
import { buildTimelineDeletePlan } from './delete-timeline-elements.js';
import { DualLensPanel } from './DualLensPanel.js';
import { buildDualLensProjection, type DualLensProjection } from './dual-lens-model.js';
import { primaryNodeIdForClip, type LensRevealRequest } from './dual-lens-reveal.js';
import { buildDataLanes, type DataLane } from './data-lanes.js';
import { SpecialistReviewPanel } from './SpecialistReviewPanel.js';
import { ProjectLibrary } from './ProjectLibrary.js';
import {
  clearActiveProjectId,
  getCatalogProject,
  loadActiveProjectId,
  saveActiveProjectId,
  upsertCatalogProject,
  type ProjectCatalogEntry,
} from './project-catalog.js';
import { createBlankProjectDocuments, seedsForCatalogEntry } from './project-factory.js';
import {
  duplicateProject as duplicateProjectLifecycle,
  purgeProject as purgeProjectLifecycle,
  renameProject as renameProjectLifecycle,
  restoreProject as restoreProjectLifecycle,
  trashProject as trashProjectLifecycle,
} from './project-lifecycle.js';
import { withCaptionBurnInNodes } from './caption-burn-in.js';
import { CaptionsPanel } from './CaptionsPanel.js';
import { TextPanel } from './TextPanel.js';
import { InspectorPanel, type InspectorSpeedChange } from './InspectorPanel.js';
import {
  MonitorAspectRatioSelector,
  monitorAspectRatioDimensions,
  monitorAspectRatioForDimensions,
  type MonitorAspectRatio,
} from './MonitorAspectRatioSelector.js';
import { MotionPanel } from './MotionPanel.js';
import { CameraPanel } from './CameraPanel.js';
import { JobsPanel, workerAudioDenoiseOperationId } from './JobsPanel.js';
import type { VerifiedWorkerAudioResult } from './worker-result.js';
import { AssetLibraryPanel } from './AssetLibraryPanel.js';
import {
  BrowserControlPlaneClient,
  type BrowserGpuPreviewSession,
  type BrowserJob,
} from './control-plane-client.js';
import { importMediaFile } from './media-import.js';
import { AudioPanel, type AudioEnhanceScopeOption } from './AudioPanel.js';
import { EffectsPanel } from './EffectsPanel.js';
import { FiltersPanel } from './FiltersPanel.js';
import { ColorPanel } from './ColorPanel.js';
import { setMonitorPixelReader } from './monitor-readback.js';
import { TransitionsPanel } from './TransitionsPanel.js';
import {
  bindClipToObject,
  clearImageMatte,
  readClipMediaKindMap,
  readImageMatteMap,
  resolveObjectIdForSelection,
  writeClipMediaKind,
  writeImageMatte,
} from './sticker-bindings.js';
import {
  readMaskSettings,
  readVideoMaskSourceMap,
  writeMaskSettings,
  writeVideoMaskSource,
  type MaskSettings,
  type MaskTarget,
} from './masking.js';
import { writeUpscaleSettings, type UpscaleSettings, type UpscaleTarget } from './upscaling.js';
import { isSingleVideoClipSelected } from './effects-apply-state.js';
import { StickerImageCache } from './sticker-image-cache.js';
import { openOpfsOriginalAssetCache } from './opfs-original-asset-cache.js';
import {
  ensureClipAudio,
  loadAudioState,
  loadAudioStateFromProject,
  withProjectAudio,
} from './audio-session.js';
import type { AudioState } from '@joy-media/commands';
import { renderOfflineAudio } from '@joy-media/audio-core/offline';
import type { ExportPresetId, WorkflowGraphV2 } from '@joy-media/project-schema';
import {
  AgentPanel,
  type AgentPanelCommand,
  type AgentPanelCommandType,
  type KiloCodeAttachedAsset,
} from './AgentPanel.js';
import { openJoyCodeOpfsAssetCache } from './joycode-opfs-assets.js';
import type { JoyCode3DRenderAsset } from './JoyCode3DViewer.js';
import { AgentSettingsDialog } from './AgentSettingsDialog.js';
import { coordinateCreativeBriefOptIn } from './creative-brief-opt-in-coordinator.js';
import { createCreativeBriefPanelRunner } from './creative-brief-panel-runner.js';
import { loadAgentSettings, saveAgentSettings, type AgentSettings } from './agent-settings.js';
import { HistoryPanel } from './HistoryPanel.js';
import { WorkflowsPanel } from './WorkflowsPanel.js';
import { PluginsPanel } from './PluginsPanel.js';
import { LibraryPanel } from './LibraryPanel.js';
import { buildContentTemplateTransaction } from './content-template-transaction.js';
import { createEditorPluginHost } from './plugin-host.js';
import { createAgentCommandBus } from './agent-command-bus.js';
import { resumeWorkflow, runWorkflow } from './workflow-runner.js';
import {
  getOrCreateControlPlaneProjectBinding,
  type ControlPlaneProjectBinding,
} from './project-control-plane.js';
import { transcribeReferenceCaption } from './local-transcription.js';
import { ProjectMediaResolver } from './project-media-resolver.js';
import { CORE_WORKSPACE_PANELS } from './workspace.js';
import type { WorkspacePresetId } from './panel-metadata.js';
import {
  loadEditorUiPreferences,
  saveEditorUiPreferences,
  updateEditorUiPreferences,
  DEFAULT_EDITOR_UI_PREFERENCES,
  EDITOR_UI_PREFERENCES_KEY,
} from './ui-preferences.js';
import type { EditorUiPreferencesV2 } from './ui-preferences.js';
import {
  previewQualityLabel,
  previewQualityResolution,
  type PreviewQuality,
} from './preview-quality.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';
import { workspacePresetLayout, workspacePresetLayoutKey } from './workspace-presets.js';
import {
  DOCK_LAYOUT_KEY,
  DOCK_PANEL_MINIMUM_HEIGHT,
  DOCK_PANEL_MINIMUM_WIDTH,
  SUPERSEDED_DOCK_LAYOUT_KEYS,
  type EditorViewMode,
  dockLayoutKey,
  migrateLegacyDockLayout,
  migrateDockLayout,
  serializeDockLayout,
  saveViewMode,
  seedDockLayout,
} from './dock-layout.js';
import { panelLabel, panelTabIconUrl } from './panel-tab-icons.js';
import { PanelShell } from './PanelShell.js';
import { isEditableTarget, isInteractiveTarget, resolveShortcut } from './keyboard-shortcuts.js';
import {
  ChevronDownIcon,
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
  recoverInterruptedProjectExports,
  saveProjectExportHistory,
  upsertProjectEntry,
  type ExportRetryManifest,
  type ProjectExportProcessEntry,
} from './export-history.js';
import { openOpfsExportCache } from './opfs-export-cache.js';
import {
  loadDetachedVideo,
  runExportPreloadStage,
  seekDetachedVideo as seekExportDetachedVideo,
  type ExportPreloadStage,
} from './export-preload.js';
import { ProjectOperationLedger } from './project-operation-ledger.js';
import { createMonoAudioBuffer } from './export-audio.js';
import { PlaybackOperationGate, playMediaWhenCurrent } from './playback-operation.js';
import { playbackStartAtOrAfter, playbackTargetAfterClip } from './timeline-playback.js';
import { timelineEffectiveDurationUs } from './timeline-layout.js';
import {
  buildDerivedClipPresentation,
  buildSpeedRampPresentation,
  buildSpeedRampTransaction,
} from './speed-ramp.js';
import {
  flattenRootTimelineVideoClips,
  rootTimelineVideoClipById,
  withFlattenedRootTimeline,
} from './timeline-nested-playback.js';
import {
  timelineCompositionView,
  timelineViewLocalTime,
  timelineViewRootTime,
} from './timeline-composition-view.js';
import './app.css';
import 'dockview/dist/styles/dockview.css';
import { JOY_COLORS } from './theme.js';
import { effectsByObjectIdAt, effectInstancesForTimelineClip } from './adjustment-render.js';
import {
  buildTreatmentLayerInsertion,
  type TreatmentLayerEffectSeed,
  type TreatmentLayerKind,
} from './adjustment-layer.js';
import { buildCaptionLayerInsertion } from './caption-layer.js';
import { buildThreeDRenderLayerInsertion } from './three-d-render-layer.js';
import { FeatureHub } from './FeatureHub.js';
import { featureActivationRoute, type FeatureToolId } from './feature-architecture.js';
import { AdjustmentLayersPanel } from './AdjustmentLayersPanel.js';
import {
  isAdjustmentTargetKind,
  isControlTimelineElement,
  readEffectLayerTargetMap,
  readTimelineElementKindMap,
  timelineElementKindForClip,
  withEffectLayerTarget,
} from './timeline-element-kind.js';
import { reconcileTimelineSelection } from './timeline-selection.js';
import {
  recordPreviewResourceCreated,
  recordPreviewResourceReleased,
} from './preview-resource-audit.js';

/** IR options for preview/export: effects, grade, and clip-timed transitions. */
function renderFrameOptions(
  project: JoyProjectV1,
  timeline: SpikeProject,
  timeUs: number,
  imageSizesByObjectId?: Readonly<
    Record<string, { readonly width: number; readonly height: number }>
  >,
): BuildRenderFrameOptions {
  const composition = project.compositions[project.rootCompositionId];
  const outputGrade =
    project.colorGrade !== undefined &&
    'version' in project.colorGrade &&
    project.colorGrade.version === 2
      ? evaluateColorGradeAtTime(
          project.colorGrade,
          project.propertyAnimations,
          { scope: 'output' },
          { compositionTimeUs: timeUs, outputTimeUs: timeUs },
        )
      : project.colorGrade;
  return {
    effectsByObjectId: effectsByObjectIdAt(project, timeline, timeUs),
    propertyAnimations: project.propertyAnimations,
    ...(outputGrade !== undefined ? { colorGrade: outputGrade } : {}),
    ...(project.transitions !== undefined ? { transitions: project.transitions } : {}),
    ...(composition ? { clipTimes: clipTimesFromTracks(composition.tracks) } : {}),
    ...(imageSizesByObjectId !== undefined ? { imageSizesByObjectId } : {}),
  };
}

const stickerImageCache = new StickerImageCache();
const originalAssetCachePromise = openOpfsOriginalAssetCache();
const exportCachePromise = openOpfsExportCache();
const mediaControlPlaneClient = new BrowserControlPlaneClient();

async function loadStickerAssetBlob(assetId: string): Promise<Blob | undefined> {
  const cache = await originalAssetCachePromise;
  return cache.get(assetId);
}

function imageSizesFromCache(
  timeUs = 0,
): Readonly<Record<string, { readonly width: number; readonly height: number }>> {
  const sizes: Record<string, { width: number; height: number }> = {};
  for (const [id, bitmap] of stickerImageCache.bitmaps(timeUs)) {
    sizes[id] = { width: bitmap.width, height: bitmap.height };
  }
  return sizes;
}

function rgbaBase64(data: Uint8ClampedArray): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < data.length; offset += chunkSize)
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
  return btoa(binary);
}

/**
 * WP-11.2: resolves a timeline clip's assetId to a real, browser-fetchable
 * URL for HTMLVideoElement decode. The reference intro/product/outro clips
 * each have a committed 30 s H.264/AAC fixture under `public/media/reference`.
 */
function activeVideoClipAt(
  project: SpikeProject,
  playheadUs: number,
  preferredClipIds: readonly string[] = [],
  creative?: JoyProjectV1,
) {
  const elementKinds = creative === undefined ? {} : readTimelineElementKindMap(creative);
  const active = flattenRootTimelineVideoClips(project)
    .filter((clip) => {
      const kind = timelineElementKindForClip(clip, elementKinds);
      const assetKind = creative?.assets[clip.assetId]?.kind;
      return (
        !isControlTimelineElement(kind) &&
        kind !== 'audio' &&
        (assetKind === undefined || assetKind === 'video') &&
        playheadUs >= clip.startUs &&
        playheadUs < clip.startUs + clip.durationUs
      );
    })
    .sort((left, right) => {
      const leftKind = timelineElementKindForClip(left, elementKinds);
      const rightKind = timelineElementKindForClip(right, elementKinds);
      const leftPriority = leftKind === 'video' ? 0 : 1;
      const rightPriority = rightKind === 'video' ? 0 : 1;
      return leftPriority - rightPriority;
    });
  if (active.length === 0) return undefined;
  return (
    preferredClipIds.map((id) => active.find((clip) => clip.id === id)).find(Boolean) ?? active[0]
  );
}

function playbackAssetId(project: JoyProjectV1, clip: VideoClip): string {
  return readVideoMaskSourceMap(project)[clip.id] ?? clip.assetId;
}

function resampleMonoSamples(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || samples.length <= 1) return samples;
  const outputLength = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const output = new Float32Array(outputLength);
  const ratio = fromRate / toRate;
  for (let index = 0; index < output.length; index++) {
    const sourcePosition = index * ratio;
    const left = Math.min(samples.length - 1, Math.floor(sourcePosition));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = sourcePosition - left;
    output[index] = samples[left]! + (samples[right]! - samples[left]!) * fraction;
  }
  return output;
}

/** Resolve the currently playing timeline clip from the live media URL. */
function videoClipSpec(
  clip: VideoClip,
  transform: {
    readonly translateX: number;
    readonly translateY: number;
    readonly scaleX: number;
    readonly scaleY: number;
  } = {
    translateX: 0,
    translateY: 0,
    scaleX: 1,
    scaleY: 1,
  },
  opacity = 1,
  colorGrade?: ColorGradeIR,
  effects?: readonly EffectInstanceIR[],
): VideoClipSpec {
  return {
    // IR / bitmap map key — must match TransitionV1 left/right clip ids.
    id: clip.id,
    originalToken: clip.assetId,
    startUs: clip.startUs,
    durationUs: clip.durationUs,
    sourceInUs: clip.sourceInUs,
    transform,
    opacity,
    zIndex: 0,
    ...(colorGrade === undefined ? {} : { colorGrade }),
    ...(effects === undefined ? {} : { effects }),
  };
}

function videoClipSpecAt(
  project: JoyProjectV1,
  timeline: SpikeProject,
  clip: VideoClip,
  timeUs: number,
  height: number,
): VideoClipSpec {
  const colorGrade = colorGradeForClipAtTime(project, clip, timeUs);
  const objectId = resolveObjectIdForSelection(project, [clip.id]);
  const object = objectId === undefined ? undefined : project.visualObjects[objectId];
  const effectInstances = effectInstancesForTimelineClip(project, timeline, clip.id, timeUs);
  const effects = evaluateEffectInstances(effectInstances, timeUs, project.propertyAnimations);
  if (object === undefined) return videoClipSpec(clip, undefined, 1, colorGrade, effects);
  const composition = project.compositions[project.rootCompositionId];
  const evaluated = evaluateCameraExpressionTransform(
    object.id,
    composition?.activeCameraId,
    project.visualObjects,
    timeUs,
    height,
  ).transform;
  return videoClipSpec(
    clip,
    {
      translateX: evaluated.x,
      translateY: evaluated.y,
      scaleX: evaluated.scaleX,
      scaleY: evaluated.scaleY,
    },
    evaluated.opacity,
    colorGrade,
    effects,
  );
}

function colorGradeForClipAtTime(
  project: JoyProjectV1,
  clip: VideoClip,
  timeUs: number,
): ColorGradeIR | undefined {
  const grade = project.clipColorGrades?.[clip.id];
  if (grade === undefined) return undefined;
  const evaluated = evaluateColorGradeAtTime(
    grade,
    project.propertyAnimations,
    { scope: 'clip', clipId: clip.id },
    {
      compositionTimeUs: timeUs,
      outputTimeUs: timeUs,
      clip: { startUs: clip.startUs, durationUs: clip.durationUs },
    },
  );
  return normalizeColorGrade(evaluated);
}

/** Active transition (if any) at composition time. */
function activeTransitionAt(project: JoyProjectV1, playheadUs: number): TransitionV1 | undefined {
  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined || project.transitions === undefined) return undefined;
  const clipTimes = clipTimesFromTracks(composition.tracks);
  return project.transitions.find((transition) =>
    isTransitionActive(transition, playheadUs, clipTimes),
  );
}

/**
 * Transition inputs are uploaded as independent textures, so they do not
 * pass through the ordinary video-frame layer filters. Apply each source
 * clip's grade to a private bitmap copy before the transition blends it.
 */
function applyClipGradesToTransitionBitmaps(
  project: JoyProjectV1,
  transition: TransitionV1 | undefined,
  timeUs: number,
  bitmaps: Map<string, ImageDataLike>,
): void {
  if (transition === undefined) return;
  for (const clipId of [transition.leftClipId, transition.rightClipId]) {
    const clip = findVideoClipById(project, clipId);
    const bitmap = bitmaps.get(clipId);
    if (clip === undefined || bitmap === undefined) continue;
    const grade = colorGradeForClipAtTime(project, clip, timeUs);
    if (grade === undefined) continue;
    const data = new Uint8ClampedArray(bitmap.data);
    applyColorGradeToPixels(data, normalizeColorGrade(grade));
    bitmaps.set(clipId, { ...bitmap, data });
  }
}

function findVideoClipById(
  project: SpikeProject | JoyProjectV1,
  clipId: string,
): VideoClip | undefined {
  return rootTimelineVideoClipById(project as SpikeProject, clipId);
}

/** Timeline edits that create additional clips must retain their presentation state. */
function derivedClipPresentationTarget(transaction: CommandTransaction):
  | {
      readonly originalClipId: string;
      readonly derivedClipIds: readonly string[];
      readonly splitAtUs?: number;
    }
  | undefined {
  if (transaction.commands.length !== 1) return undefined;
  const [command] = transaction.commands;
  if (command === undefined) return undefined;
  switch (command.type) {
    case 'timeline.freezeFrame':
      return {
        originalClipId: command.payload.clipId,
        derivedClipIds: [command.payload.freezeClipId, command.payload.rightClipId],
      };
    case 'timeline.splitClip':
      return {
        originalClipId: command.payload.clipId,
        derivedClipIds: [command.payload.newClipId],
        splitAtUs: command.payload.atUs,
      };
    case 'timeline.duplicateClip':
      return {
        originalClipId: command.payload.clipId,
        derivedClipIds: [command.payload.newClipId],
      };
    default:
      return undefined;
  }
}

/** Any remove transaction orphaning a clip-owned property map gets a matching document update. */
function removedClipPresentationTarget(transaction: CommandTransaction): string | undefined {
  return transaction.commands.find((command) => command.type === 'timeline.removeClip')?.payload
    .clipId;
}

/** Composition playhead → source media time, honoring clip.playbackRate (0 = freeze). */
function sourceTimeForPlayhead(clip: VideoClip, playheadUs: number): number {
  return sourceTimeAtVideoClipTime(clip, playheadUs);
}

/**
 * Source time for a clip during an active A↔B transition. The outgoing clip
 * keeps its normal mapping; the incoming clip advances from `sourceInUs` as if
 * it began at the transition window start.
 */
function sourceTimeForTransitionSample(
  clip: VideoClip,
  playheadUs: number,
  transition: TransitionV1 | undefined,
): number {
  if (transition !== undefined && clip.id === transition.rightClipId && playheadUs < clip.startUs) {
    const rate = normalizePlaybackRate(clip.playbackRate);
    if (rate === 0) return clip.sourceInUs;
    const windowStart = clip.startUs - transition.durationUs;
    const direction = clip.reversed === true ? -1 : 1;
    return clip.sourceInUs + Math.max(0, playheadUs - windowStart) * rate * direction;
  }
  if (playheadUs < clip.startUs) return clip.sourceInUs;
  if (playheadUs >= clip.startUs + clip.durationUs) {
    const rate = normalizePlaybackRate(clip.playbackRate);
    if (rate === 0) return clip.sourceInUs;
    const direction = clip.reversed === true ? -1 : 1;
    return clip.sourceInUs + Math.max(0, Math.round((clip.durationUs - 1) * rate)) * direction;
  }
  return sourceTimeForPlayhead(clip, playheadUs);
}

/** Source media time → composition playhead (freeze holds last mapped start). */
function playheadForSourceTime(
  clip: VideoClip,
  sourceTimeUs: number,
  freezePlayheadUs: number,
): number {
  const rate = normalizePlaybackRate(clip.playbackRate);
  if (rate === 0) return freezePlayheadUs;
  const direction = clip.reversed === true ? -1 : 1;
  return clip.startUs + ((sourceTimeUs - clip.sourceInUs) * direction) / rate;
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
      reject(new Error(`Unable to seek preview media to ${seconds}s`));
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = seconds;
  });
}

async function decodeStillFrame(sourceUrl: string): Promise<ImageDataLike> {
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Unable to fetch export image ${sourceUrl}`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('2D canvas is unavailable for image export');
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
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

export interface AnimationGraphFocusRequest {
  readonly objectId: string;
  readonly channel: AnimatablePropertyV1;
  /** Makes repeat requests to an already focused channel observable. */
  readonly token: number;
}

interface EditorPanelContextValue {
  readonly state: EditorRuntimeState;
  readonly previewVideoFrame: DecodedPreviewFrame | undefined;
  /** Last decoded RGBA per timeline clip id (dual-texture transitions). */
  readonly clipFrameCache: ReadonlyMap<string, ImageDataLike>;
  readonly clipFrameTick: number;
  readonly timelineProject: SpikeProject;
  readonly visualProject: JoyProjectV1;
  readonly controlPlaneProject: ControlPlaneProjectBinding;
  readonly playback: PlaybackDiagnosticsSnapshot;
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
  /** Persists a visual/audio snapshot with a timeline transaction as one Undo step. */
  readonly dispatchTimelineAndProjectAudio: (
    label: string,
    timeline: CommandTransaction,
    visualProject: JoyProjectV1,
    audioState: AudioState,
  ) => void;
  readonly updateVisualProperty: (
    objectId: string,
    key: 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotationDeg' | 'opacity',
    value: number,
  ) => void;
  readonly dispatchProject: (transaction: VisualObjectTransaction) => void;
  readonly replaceVisualProject: (next: JoyProjectV1) => void;
  readonly replaceVisualProjectAndAudio: (next: JoyProjectV1, audio: AudioState) => void;
  readonly addStickerFromAsset: (asset: {
    readonly assetId: string;
    readonly displayName?: string;
    readonly blob?: Blob;
  }) => Promise<void>;
  /** Creates a separate Adjust controller targeting one root media clip. */
  readonly addAdjustmentLayer: (targetClipId: string) => void;
  readonly addTreatmentLayer: (
    kind: TreatmentLayerKind,
    targetClipId: string,
    effect?: TreatmentLayerEffectSeed,
  ) => void;
  readonly addCaptionLayer: () => void;
  readonly addHtmlSceneToSelectedClip: (scenePackageId: string) => void;
  readonly addJoyCode3DRender: (asset: JoyCode3DRenderAsset) => Promise<void>;
  readonly stickerTick: number;
  readonly audioState: AudioState;
  readonly setAudioState: (next: AudioState, label?: string) => void;
  readonly transcribe: (documentId: string, language: 'fa-IR' | 'en-US') => Promise<void>;
  readonly transcriptionError: string | undefined;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly jumpToHistory: (sequence: number) => void;
  /**
   * Dockview keeps panel component instances alive, so panel-only runtime
   * bindings live in context rather than in a renderer closure.
   */
  readonly session: EditorSession;
  readonly createTool: FeatureToolId;
  readonly enhanceTool: FeatureToolId;
  readonly onCreateToolChange: (tool: FeatureToolId) => void;
  readonly onEnhanceToolChange: (tool: FeatureToolId) => void;
  readonly activatePanel: (panelId: string) => void;
  /** Pending cross-panel request to show one selected object's animation curve. */
  readonly animationGraphFocus: AnimationGraphFocusRequest | undefined;
  readonly openAnimationGraph: (objectId: string, channel: AnimatablePropertyV1) => void;
  readonly agentContext: EditorContext;
  readonly agentSettings: AgentSettings;
  readonly agentPanelCommand: AgentPanelCommand | undefined;
  readonly creativeBriefOptedIn: boolean;
  readonly creativeBriefRunner: (requestText: string) => Promise<CreativeBriefV1>;
  readonly onCreativeBriefOptIn: () => Promise<void>;
  readonly kiloCodeAttachedAssets: readonly KiloCodeAttachedAsset[];
  readonly attachKiloCodeAsset: (asset: KiloCodeAttachedAsset) => void;
  readonly detachKiloCodeAsset: (assetId: string) => void;
  readonly pluginHost: ReturnType<typeof createEditorPluginHost>;
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
  /** Current editable composition shown by Timeline; context survives Dockview's cached panel renderer. */
  readonly activeTimelineCompositionId: string;
  readonly onActiveTimelineCompositionChange: (compositionId: string) => void;
}
export const EditorPanelContext = createContext<EditorPanelContextValue | undefined>(undefined);

export function App() {
  const storage = window.localStorage;
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    const id = loadActiveProjectId(storage);
    if (id === null) return null;
    if (getCatalogProject(storage, id)?.trashedAt !== undefined) {
      clearActiveProjectId(storage);
      return null;
    }
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

  const renameProject = useCallback(
    (entry: ProjectCatalogEntry, title: string) => renameProjectLifecycle(storage, entry, title),
    [storage],
  );
  const duplicateProject = useCallback(
    (entry: ProjectCatalogEntry, title: string) => duplicateProjectLifecycle(storage, entry, title),
    [storage],
  );
  const trashProject = useCallback(
    (entry: ProjectCatalogEntry) => trashProjectLifecycle(storage, entry),
    [storage],
  );
  const restoreProject = useCallback(
    (entry: ProjectCatalogEntry) => restoreProjectLifecycle(storage, entry),
    [storage],
  );
  const purgeProject = useCallback(
    (entry: ProjectCatalogEntry) => purgeProjectLifecycle(storage, entry),
    [storage],
  );

  const backToLibrary = useCallback(() => {
    clearActiveProjectId(storage);
    setActiveProjectId(null);
  }, [storage]);

  if (activeProjectId === null) {
    return (
      <ProjectLibrary
        storage={storage}
        onOpen={openProject}
        onCreate={createProject}
        onRename={renameProject}
        onDuplicate={duplicateProject}
        onTrash={trashProject}
        onRestore={restoreProject}
        onPurge={purgeProject}
      />
    );
  }

  return (
    <EditorWorkspace
      key={activeProjectId}
      projectId={activeProjectId}
      onBackToLibrary={backToLibrary}
    />
  );
}

function EditorWorkspace({
  projectId,
  onBackToLibrary,
}: {
  readonly projectId: string;
  readonly onBackToLibrary: () => void;
}) {
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
  const [exportHistory, setExportHistory] = useState<readonly ProjectExportProcessEntry[]>(() =>
    recoverInterruptedProjectExports(window.localStorage, projectId),
  );
  const exportHistoryRef = useRef(exportHistory);
  exportHistoryRef.current = exportHistory;
  const operationLedger = useMemo(
    () => new ProjectOperationLedger(window.localStorage, projectId),
    [projectId],
  );
  useEffect(() => {
    operationLedger.recoverInterrupted('export');
    operationLedger.recoverUncertain('cloud-audio');
  }, [operationLedger]);
  useEffect(() => {
    const interruptedIds = exportHistory
      .filter((entry) => entry.status === 'interrupted-retryable')
      .map((entry) => entry.id);
    if (interruptedIds.length === 0) return;
    void exportCachePromise
      .then((cache) => Promise.all(interruptedIds.map((id) => cache.removeVerified(id))))
      .catch(() => undefined);
  }, [exportHistory]);
  const [exportPreset, setExportPreset] = useState<ExportPresetId>('reels-1080');
  const [audioState, setAudioStateRaw] = useState<AudioState>(() => loadAudioState(projectId));
  const [audioHydrated, setAudioHydrated] = useState(false);
  const [processesOpen, setProcessesOpen] = useState(false);
  const [processFilter, setProcessFilter] = useState<EditorUiPreferencesV2['processFilter']>(
    () => loadEditorUiPreferences(window.localStorage).processFilter,
  );
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
  const [creativeBriefOptedIn, setCreativeBriefOptedIn] = useState(false);
  const [joySession, setJoySession] = useState<JoySessionState>({ kind: 'unknown' });
  const joySessionRefreshSeqRef = useRef(0);
  const [toasts, setToasts] = useState<
    readonly { id: string; message: string; kind: 'info' | 'success' | 'error' }[]
  >([]);
  const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false);
  const [viewMode, setViewMode] = useState<EditorViewMode>(
    () => loadEditorUiPreferences(window.localStorage).viewMode,
  );
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const [workspacePreset, setWorkspacePreset] = useState<WorkspacePresetId>(
    () => loadEditorUiPreferences(window.localStorage).workspacePreset,
  );
  const workspacePresetRef = useRef(workspacePreset);
  workspacePresetRef.current = workspacePreset;
  const [createTool, setCreateTool] = useState<FeatureToolId>('media');
  const [enhanceTool, setEnhanceTool] = useState<FeatureToolId>('effects');
  const paletteRef = useRef<HTMLElement | null>(null);
  const accountDropdownRef = useRef<HTMLElement | null>(null);
  const [motionStudioSceneId, setMotionStudioSceneId] = useState<string | undefined>(undefined);
  const [effectStudioSession, setEffectStudioSession] = useState<
    { readonly recipeId: string; readonly objectId?: string } | undefined
  >(undefined);
  useEffect(() => {
    return () => {
      stickerImageCache.clear();
    };
  }, []);
  const lastExportRef = useRef<{ readonly entryId: string; readonly url: string } | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const exportInFlightRef = useRef(false);
  const exportToastTimerRef = useRef<number | undefined>(undefined);
  const toastTimersRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const toastTimers = toastTimersRef.current;
    return () => {
      window.clearTimeout(exportToastTimerRef.current);
      for (const timer of toastTimers.values()) window.clearTimeout(timer);
      toastTimers.clear();
      exportAbortRef.current?.abort();
      exportAbortRef.current = null;
      if (lastExportRef.current !== null) URL.revokeObjectURL(lastExportRef.current.url);
    };
  }, []);
  const showToast = useCallback((message: string, kind: 'info' | 'success' | 'error' = 'info') => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev, { id, message, kind }]);
    const timer = window.setTimeout(() => {
      toastTimersRef.current.delete(id);
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 4000);
    toastTimersRef.current.set(id, timer);
  }, []);
  useEffect(() => {
    if (lastExportRef.current !== null) return;
    const entry = exportHistory.find((candidate) => candidate.status === 'completed');
    if (entry === undefined) return;
    let cancelled = false;
    void exportCachePromise
      .then((cache) => cache.get(entry.id))
      .then(async (blob) => {
        if (cancelled || lastExportRef.current !== null) return;
        const valid =
          blob !== undefined &&
          blob.size === entry.totalBytes &&
          (await sha256Hex(new Uint8Array(await blob.arrayBuffer()))) === entry.sha256;
        if (!valid) {
          await exportCachePromise
            .then((cache) => cache.removeVerified(entry.id))
            .catch(() => undefined);
          setExportHistory((current) => {
            const next = current.map((candidate): ProjectExportProcessEntry =>
              candidate.id === entry.id
                ? {
                    ...candidate,
                    status: 'failed',
                    cacheState: 'none',
                    error: 'durable export bytes are unavailable',
                  }
                : candidate,
            );
            saveProjectExportHistory(window.localStorage, projectId, next);
            return next;
          });
          return;
        }
        lastExportRef.current = { entryId: entry.id, url: URL.createObjectURL(blob!) };
        setExportHistory((current) => [...current]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [exportHistory, projectId]);
  useEffect(() => {
    saveAgentSettings(window.localStorage, agentSettings);
  }, [agentSettings]);
  useEffect(() => {
    updateEditorUiPreferences(window.localStorage, (current) => ({
      ...current,
      processFilter,
    }));
  }, [processFilter]);
  const [previewVideoFrame, setPreviewVideoFrame] = useState<DecodedPreviewFrame | undefined>(
    undefined,
  );
  const [, setRevision] = useState(0);
  const [pluginHost] = useState(() => createEditorPluginHost());
  const [, setPluginRevision] = useState(0);
  const sessionRef = useRef<EditorSession | null>(null);
  const dockviewApiRef = useRef<DockviewApi | null>(null);
  const dockviewComponentsRef = useRef<{ readonly 'editor-panel': typeof Panel } | null>(null);
  const scheduler = useRef(new PlaybackScheduler());
  const playbackDiagnostics = useRef(new PlaybackDiagnosticsSession());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const replacementAudioRef = useRef<HTMLAudioElement | null>(null);
  const decoderRef = useRef<HtmlMediaDecoder | null>(null);
  const clockRef = useRef<MediaClock | null>(null);
  /** Last decoded RGBA per timeline clip id — feeds dual-texture transitions. */
  const clipFrameCacheRef = useRef<Map<string, ImageDataLike>>(new Map());
  const [clipFrameTick, setClipFrameTick] = useState(0);
  const partnerVideoRef = useRef<HTMLVideoElement | null>(null);
  const partnerDecoderRef = useRef<HtmlMediaDecoder | null>(null);
  const partnerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const previewAudioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const replacementAudioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const previewGainNodeRef = useRef<GainNode | null>(null);
  const previewPanNodeRef = useRef<StereoPannerNode | null>(null);
  const replacementGainNodeRef = useRef<GainNode | null>(null);
  const replacementPanNodeRef = useRef<StereoPannerNode | null>(null);
  const previewAudioDisposeTimerRef = useRef<number | undefined>(undefined);
  const previewResourcePrefixRef = useRef(
    `${projectId}:${crypto.randomUUID?.() ?? Date.now().toString(36)}`,
  );

  const ensurePreviewAudioGraph = useCallback(() => {
    const video = videoRef.current;
    const replacementAudio = replacementAudioRef.current;
    if (!video || !replacementAudio) return;
    if (audioContextRef.current === null) {
      audioContextRef.current = new AudioContext();
      recordPreviewResourceCreated('audio-context', `${previewResourcePrefixRef.current}:audio`);
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
    if (replacementAudioSourceRef.current === null) {
      replacementAudioSourceRef.current = audioContext.createMediaElementSource(replacementAudio);
      replacementGainNodeRef.current = audioContext.createGain();
      replacementPanNodeRef.current = audioContext.createStereoPanner();
      replacementAudioSourceRef.current
        .connect(replacementGainNodeRef.current)
        .connect(replacementPanNodeRef.current)
        .connect(audioContext.destination);
    }
  }, []);
  const disposePreviewAudioGraph = useCallback(() => {
    previewAudioSourceRef.current?.disconnect();
    replacementAudioSourceRef.current?.disconnect();
    previewGainNodeRef.current?.disconnect();
    replacementGainNodeRef.current?.disconnect();
    previewPanNodeRef.current?.disconnect();
    replacementPanNodeRef.current?.disconnect();
    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    previewAudioSourceRef.current = null;
    replacementAudioSourceRef.current = null;
    previewGainNodeRef.current = null;
    replacementGainNodeRef.current = null;
    previewPanNodeRef.current = null;
    replacementPanNodeRef.current = null;
    if (audioContext !== null && audioContext.state !== 'closed')
      void audioContext.close().catch(() => undefined);
    recordPreviewResourceReleased('audio-context', `${previewResourcePrefixRef.current}:audio`);
  }, []);
  useEffect(() => {
    if (previewAudioDisposeTimerRef.current !== undefined) {
      window.clearTimeout(previewAudioDisposeTimerRef.current);
      previewAudioDisposeTimerRef.current = undefined;
    }
    return () => {
      // React StrictMode intentionally tears effects down and recreates them
      // while preserving the same media elements. A MediaElementSource can
      // only ever be created once for an element, even after its AudioContext
      // closes, so defer disposal long enough for the matching setup to cancel
      // it. A genuine unmount has no matching setup and still closes the graph.
      previewAudioDisposeTimerRef.current = window.setTimeout(() => {
        previewAudioDisposeTimerRef.current = undefined;
        disposePreviewAudioGraph();
      }, 0);
    };
  }, [disposePreviewAudioGraph]);

  // Sync live preview mixer to audioState (mute/solo/gain/pan) — P14.1
  useEffect(() => {
    ensurePreviewAudioGraph();
    const gainNode = previewGainNodeRef.current;
    const panNode = previewPanNodeRef.current;
    const replacementGainNode = replacementGainNodeRef.current;
    const replacementPanNode = replacementPanNodeRef.current;
    if (!gainNode || !panNode || !replacementGainNode || !replacementPanNode) return;

    // Master gain from master bus
    const masterBus = audioState.buses.find((b) => b.id === 'master') ?? audioState.buses[0];
    if (masterBus) {
      gainNode.gain.value = masterBus.mute ? 0 : masterBus.gain;
      panNode.pan.value = masterBus.pan;
      replacementGainNode.gain.value = masterBus.mute ? 0 : masterBus.gain;
      replacementPanNode.pan.value = masterBus.pan;
    }
  }, [audioState, ensurePreviewAudioGraph]);

  if (sessionRef.current === null) {
    const entry = getCatalogProject(window.localStorage, projectId);
    if (entry === undefined) throw new Error(`unknown project "${projectId}"`);
    const seeds = seedsForCatalogEntry(entry);
    sessionRef.current = new EditorSession(window.localStorage, seeds.timeline, seeds.visual);
  }
  const session = sessionRef.current;
  // Audio commands keep static mixer state in the project. Universal
  // automation is sampled only for the current playback instant, so it never
  // mutates that durable mixer state while the playhead advances.
  const previewAudioState: AudioState = (() => {
    const projectAudio = session.visualProject.audio;
    if (projectAudio === undefined) return audioState;
    const evaluated = evaluateProjectAudioAtTime(
      projectAudio,
      session.visualProject.propertyAnimations,
      {
        compositionTimeUs: state.playheadUs,
        audioTimelineTimeUs: state.playheadUs,
      },
    );
    return { clips: evaluated.clips, buses: evaluated.buses, effects: audioState.effects };
  })();
  // Dockview keeps panel instances independently from this workspace render.
  // Keep compound drill-in state here, rather than inside the panel component,
  // so opening a child timeline survives the project update that created it.
  const [activeTimelineCompositionId, setActiveTimelineCompositionId] = useState(
    () => session.timelineProject.rootCompositionId,
  );
  useEffect(() => {
    if (session.timelineProject.compositions[activeTimelineCompositionId] !== undefined) return;
    setActiveTimelineCompositionId(session.timelineProject.rootCompositionId);
  }, [activeTimelineCompositionId, session.timelineProject]);
  useEffect(() => {
    ensurePreviewAudioGraph();
    const videoGain = previewGainNodeRef.current;
    const videoPan = previewPanNodeRef.current;
    const replacementGain = replacementGainNodeRef.current;
    const replacementPan = replacementPanNodeRef.current;
    if (!videoGain || !videoPan || !replacementGain || !replacementPan) return;
    const activeClip = activeVideoClipAt(
      session.timelineProject,
      state.playheadUs,
      state.selectedIds,
      session.visualProject,
    );
    const activeVideoClip = activeClip?.kind === 'video' ? activeClip : undefined;
    const clipConfig =
      activeVideoClip === undefined ? undefined : previewAudioState.clips[activeVideoClip.id];
    const master =
      previewAudioState.buses.find((bus) => bus.id === 'master') ?? previewAudioState.buses[0];
    const hasSolo = Object.values(previewAudioState.clips).some((clip) => clip.solo);
    const clipAudible =
      clipConfig === undefined || (!clipConfig.mute && (!hasSolo || clipConfig.solo));
    const gain =
      (master?.mute ? 0 : (master?.gain ?? 1)) * (clipAudible ? (clipConfig?.gain ?? 1) : 0);
    const pan = Math.max(-1, Math.min(1, (master?.pan ?? 0) + (clipConfig?.pan ?? 0)));
    const replacementActive =
      activeVideoClip !== undefined &&
      clipConfig?.sourceAssetId !== undefined &&
      clipConfig.sourceAssetId !== activeVideoClip.assetId;
    videoGain.gain.value = replacementActive ? 0 : gain;
    replacementGain.gain.value = replacementActive ? gain : 0;
    videoPan.pan.value = pan;
    replacementPan.pan.value = pan;
  }, [ensurePreviewAudioGraph, previewAudioState, session, state.playheadUs, state.selectedIds]);
  const audioMigrationRef = useRef(false);
  useEffect(() => {
    if (audioMigrationRef.current) return;
    audioMigrationRef.current = true;
    const canonical = loadAudioStateFromProject(
      window.localStorage,
      projectId,
      session.visualProject,
    );
    if (session.visualProject.audio === undefined) {
      session.synchronizeVisualProject(withProjectAudio(session.visualProject, canonical));
      setAudioStateRaw(canonical);
      setRevision((revision) => revision + 1);
    } else setAudioStateRaw(canonical);
    setAudioHydrated(true);
  }, [projectId, session]);
  const controlPlaneOwnerKey =
    joySession.kind === 'ready' ? (joySession.subject ?? 'signed-in') : 'signed-out';
  const controlPlaneProject = useMemo(
    () =>
      getOrCreateControlPlaneProjectBinding(window.localStorage, session.visualProject, {
        ownerKey: controlPlaneOwnerKey,
      }),
    [controlPlaneOwnerKey, session.visualProject],
  );
  const creativeBriefRunner = useMemo(
    () =>
      createCreativeBriefPanelRunner({
        binding: controlPlaneProject,
        document: session.visualProject,
        revisionId: session.projectRevisionId,
        storage: window.localStorage,
        syncProjectDocument: (controlPlaneProjectId, params) =>
          mediaControlPlaneClient.syncProjectDocument(controlPlaneProjectId, params),
        creativeBriefTransport: (controlPlaneProjectId, request) =>
          mediaControlPlaneClient.createCreativeBrief(controlPlaneProjectId, request),
        requestFactory: (
          trimmedText: string,
          projectId: string,
          revisionId: ProjectRevisionId,
        ): CreativeBriefRequestV1 => ({
          projectId,
          snapshotRevisionId: revisionId,
          request: trimmedText,
          scope: 'general',
        }),
        ownerKey: controlPlaneOwnerKey,
      }),
    [controlPlaneOwnerKey, controlPlaneProject, session.projectRevisionId, session.visualProject],
  );
  const onCreativeBriefOptIn = useCallback(async () => {
    const result = await coordinateCreativeBriefOptIn(
      controlPlaneProject,
      true,
      window.localStorage,
      (controlPlaneProjectId, enabled, baseRevision) =>
        mediaControlPlaneClient.setCreativeBriefOptIn(
          controlPlaneProjectId,
          enabled,
          baseRevision,
        ),
      { ownerKey: controlPlaneOwnerKey },
    );
    if (result.kind !== 'success') {
      throw new Error(`Creative Brief opt-in failed (${result.kind})`);
    }
    setCreativeBriefOptedIn(true);
  }, [controlPlaneOwnerKey, controlPlaneProject]);
  const mediaResolver = useMemo(
    () =>
      new ProjectMediaResolver({
        projectId: controlPlaneProject.controlPlaneProjectId,
        controlPlaneReady: joySession.kind === 'ready',
        project: session.visualProject,
        client: mediaControlPlaneClient,
        originalCache: {
          get: (assetId) => originalAssetCachePromise.then((cache) => cache.get(assetId)),
        },
      }),
    [controlPlaneProject.controlPlaneProjectId, joySession.kind, session.visualProject],
  );
  useEffect(() => () => mediaResolver.clear(), [mediaResolver]);
  const agentCommandBusRef = useRef<ReturnType<typeof createAgentCommandBus> | null>(null);
  if (agentCommandBusRef.current === null)
    agentCommandBusRef.current = createAgentCommandBus(session, () =>
      setRevision((revision) => revision + 1),
    );
  // WP-15.1/15.2: rebuilt each render so a dry-run/execute always sees the
  // current real timeline, bound to the real command bus above — not a mock.
  const selectedClipIdSet = new Set(state.selectedIds);
  const selectedTrackIds =
    session.timelineProject.compositions[session.timelineProject.rootCompositionId]?.tracks
      .filter((track) => track.clips.some((clip) => selectedClipIdSet.has(clip.id)))
      .map((track) => track.id) ?? [];
  const agentContext = buildEditorContext(
    session.timelineProject,
    undefined,
    agentCommandBusRef.current,
    {
      liveAudio: audioState,
      creativeProject: session.visualProject,
      selection: {
        selectedClipIds: state.selectedIds,
        selectedTrackIds,
        playheadUs: state.playheadUs,
      },
      recentHistory: session.historyEntries.map((entry) => entry.label),
    },
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastMediaTimeUsRef = useRef<number | undefined>(undefined);
  const lastDiagnosticsObservedUsRef = useRef<number | undefined>(undefined);
  const freezeWallStartRef = useRef<{ wallMs: number; playheadUs: number } | undefined>(undefined);
  /** Reverse playback is browser-seek driven because HTMLMediaElement has no portable negative rate. */
  const reverseWallStartRef = useRef<
    { readonly wallMs: number; readonly playheadUs: number; readonly epoch: number } | undefined
  >(undefined);
  const reverseFrameInFlightRef = useRef(false);
  /** The playing effect publishes its current capture tick for async media loads. */
  const playbackTickRef = useRef<(() => void) | undefined>(undefined);
  const playbackFrameRef = useRef<number | undefined>(undefined);
  const playbackOperationRef = useRef(new PlaybackOperationGate());

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
      recordPreviewResourceCreated(
        'partner-decoder',
        `${previewResourcePrefixRef.current}:partner`,
      );
    }
    return { video: partnerVideoRef.current, decoder: partnerDecoderRef.current };
  }, []);
  useEffect(
    () => () => {
      const partnerVideo = partnerVideoRef.current;
      partnerVideo?.pause();
      partnerVideo?.removeAttribute('src');
      partnerVideo?.load();
      partnerVideoRef.current = null;
      partnerDecoderRef.current = null;
      if (partnerCanvasRef.current !== null) {
        partnerCanvasRef.current.width = 0;
        partnerCanvasRef.current.height = 0;
      }
      partnerCanvasRef.current = null;
      clipFrameCacheRef.current.clear();
      recordPreviewResourceReleased(
        'partner-decoder',
        `${previewResourcePrefixRef.current}:partner`,
      );
    },
    [],
  );

  const captureTransitionPartnerFrames = useCallback(
    async (playheadUs: number): Promise<void> => {
      const transition = activeTransitionAt(session.visualProject, playheadUs);
      if (transition === undefined) return;
      const { video, decoder } = ensurePartnerDecoder();
      for (const clipId of [transition.leftClipId, transition.rightClipId]) {
        const clip = findVideoClipById(session.timelineProject, clipId);
        if (clip === undefined) continue;
        const source = await mediaResolver.resolve(playbackAssetId(session.visualProject, clip));
        const sourceUrl = new URL(source.url, window.location.href).href;
        if (video.src !== sourceUrl) {
          video.src = sourceUrl;
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
        const sourceUs = sourceTimeForTransitionSample(clip, playheadUs, transition);
        await seekDetachedVideo(video, sourceUs);
        const token = scheduler.current.requestToken();
        const frame = decoder.captureCurrentFrame(token);
        if (frame.bitmap !== undefined) rememberClipFrame(clip.id, frame.bitmap);
      }
    },
    [ensurePartnerDecoder, mediaResolver, rememberClipFrame, session],
  );

  const syncMediaToPlayhead = useCallback(
    async (playheadUs: number, play: boolean, epoch: number): Promise<boolean> => {
      const video = videoRef.current;
      const replacementAudio = replacementAudioRef.current;
      const clock = clockRef.current;
      const decoder = decoderRef.current;
      const operation = playbackOperationRef.current;
      const composition =
        session.timelineProject.compositions[session.timelineProject.rootCompositionId];
      const transition = activeTransitionAt(session.visualProject, playheadUs);
      const clip =
        activeVideoClipAt(
          session.timelineProject,
          playheadUs,
          stateRef.current.selectedIds,
          session.visualProject,
        ) ??
        (transition !== undefined
          ? findVideoClipById(session.timelineProject, transition.leftClipId)
          : undefined);
      if (
        video === null ||
        replacementAudio === null ||
        clock === null ||
        composition === undefined ||
        clip === undefined ||
        clip.kind !== 'video'
      )
        return false;
      const source = await mediaResolver.resolve(playbackAssetId(session.visualProject, clip));
      if (!operation.isCurrent(epoch)) return false;
      const clipAudioConfig = audioState.clips[clip.id];
      const replacementAssetId =
        clipAudioConfig?.sourceAssetId !== undefined &&
        clipAudioConfig.sourceAssetId !== clip.assetId
          ? clipAudioConfig.sourceAssetId
          : undefined;
      const replacementSource =
        replacementAssetId === undefined
          ? undefined
          : await mediaResolver.resolve(replacementAssetId);
      if (!operation.isCurrent(epoch)) return false;
      playbackDiagnostics.current.start(clip.id, 'full');
      const sourceUrl = new URL(source.url, window.location.href).href;
      if (video.src !== sourceUrl) {
        video.src = sourceUrl;
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
        if (!operation.isCurrent(epoch)) return false;
      }
      if (replacementSource === undefined) {
        replacementAudio.pause();
        if (replacementAudio.hasAttribute('src')) {
          replacementAudio.removeAttribute('src');
          replacementAudio.load();
        }
      } else {
        const replacementUrl = new URL(replacementSource.url, window.location.href).href;
        if (replacementAudio.src !== replacementUrl) {
          replacementAudio.src = replacementUrl;
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              replacementAudio.removeEventListener('loadeddata', onLoaded);
              replacementAudio.removeEventListener('error', onError);
            };
            const onLoaded = () => {
              cleanup();
              resolve();
            };
            const onError = () => {
              cleanup();
              reject(new Error(`Unable to load ${replacementAssetId} for live playback`));
            };
            replacementAudio.addEventListener('loadeddata', onLoaded, { once: true });
            replacementAudio.addEventListener('error', onError, { once: true });
          });
          if (!operation.isCurrent(epoch)) return false;
        }
      }
      const rate = normalizePlaybackRate(clip.playbackRate);
      const sourceTimeUs = sourceTimeForTransitionSample(clip, playheadUs, transition);
      video.currentTime = sourceTimeUs / 1_000_000;
      video.playbackRate = rate === 0 ? 1 : rate;
      if (replacementSource !== undefined) {
        replacementAudio.currentTime = sourceTimeUs / 1_000_000;
        replacementAudio.playbackRate = rate === 0 ? 1 : rate;
      }
      scheduler.current.seek(sourceTimeUs);
      lastMediaTimeUsRef.current = undefined;
      lastDiagnosticsObservedUsRef.current = undefined;
      if (play) {
        video.muted = replacementSource !== undefined || clip.reversed === true;
        replacementAudio.muted = clip.reversed === true;
        if (rate === 0) {
          video.pause();
          replacementAudio.pause();
          freezeWallStartRef.current = {
            wallMs: performance.now(),
            playheadUs,
          };
          reverseWallStartRef.current = undefined;
        } else if (clip.reversed === true) {
          // Browsers do not support negative HTMLMediaElement playback rates.
          // Keep decode paused and advance the root playhead on rAF while
          // seeking each visual frame to the canonical reverse source time.
          video.pause();
          replacementAudio.pause();
          freezeWallStartRef.current = undefined;
          reverseWallStartRef.current = { wallMs: performance.now(), playheadUs, epoch };
          // The playing effect may have already consumed its initial rAF
          // while a cold source was loading. Wake its capture loop after the
          // reverse wall clock is installed.
          window.requestAnimationFrame(() => {
            if (operation.isCurrent(epoch) && operation.intendsToPlay) playbackTickRef.current?.();
          });
        } else {
          freezeWallStartRef.current = undefined;
          reverseWallStartRef.current = undefined;
          const started = await playMediaWhenCurrent(
            operation,
            epoch,
            async () => {
              await Promise.all([
                video.play(),
                ...(replacementSource === undefined ? [] : [replacementAudio.play()]),
              ]);
            },
            () => {
              video.pause();
              replacementAudio.pause();
            },
          );
          if (!started) return false;
        }
      } else {
        freezeWallStartRef.current = undefined;
        reverseWallStartRef.current = undefined;
        video.pause();
        replacementAudio.pause();
        await seekDetachedVideo(video, sourceTimeUs);
        if (decoder !== null) {
          const token = scheduler.current.requestToken();
          const frame = decoder.captureCurrentFrame(token);
          if (frame.bitmap !== undefined) {
            const visualComposition =
              session.visualProject.compositions[session.visualProject.rootCompositionId];
            const node = videoFrameNodeFromDecoded(
              videoClipSpecAt(
                session.visualProject,
                session.timelineProject,
                clip,
                playheadUs,
                visualComposition?.height ?? 1920,
              ),
              frame,
              {
                width: video.videoWidth,
                height: video.videoHeight,
              },
            );
            rememberClipFrame(clip.id, frame.bitmap);
            setPreviewVideoFrame({ node, bitmap: frame.bitmap });
          }
        }
        await captureTransitionPartnerFrames(playheadUs).catch(() => undefined);
      }
      return true;
    },
    [audioState.clips, captureTransitionPartnerFrames, mediaResolver, rememberClipFrame, session],
  );

  const seek = useCallback(
    (timeUs: number) => {
      const operation = playbackOperationRef.current;
      const epoch = operation.begin(operation.intendsToPlay);
      scheduler.current.seek(timeUs);
      playbackDiagnostics.current.reset();
      lastMediaTimeUsRef.current = undefined;
      lastDiagnosticsObservedUsRef.current = undefined;
      stateRef.current = { ...stateRef.current, playheadUs: timeUs };
      setState((current) => ({ ...current, playheadUs: timeUs }));
      void syncMediaToPlayhead(timeUs, operation.intendsToPlay, epoch).catch(() => {
        if (!operation.isCurrent(epoch)) return;
        operation.begin(false);
        videoRef.current?.pause();
        replacementAudioRef.current?.pause();
        stateRef.current = { ...stateRef.current, playing: false };
        setState((current) => ({ ...current, playing: false }));
      });
    },
    [syncMediaToPlayhead],
  );
  const resyncTimelineMedia = useCallback(() => {
    const current = stateRef.current;
    const operation = playbackOperationRef.current;
    const shouldPlay = operation.intendsToPlay;
    const epoch = operation.begin(shouldPlay);
    reverseFrameInFlightRef.current = false;
    void syncMediaToPlayhead(current.playheadUs, shouldPlay, epoch)
      .then((ready) => {
        if (!operation.isCurrent(epoch)) return;
        if (!ready) {
          operation.begin(false);
          videoRef.current?.pause();
          replacementAudioRef.current?.pause();
          freezeWallStartRef.current = undefined;
          reverseWallStartRef.current = undefined;
          stateRef.current = { ...stateRef.current, playing: false };
          setState((active) => ({ ...active, playing: false }));
          return;
        }
        if (shouldPlay && operation.intendsToPlay) {
          window.requestAnimationFrame(() => {
            if (operation.isCurrent(epoch) && operation.intendsToPlay) playbackTickRef.current?.();
          });
        }
      })
      .catch(() => {
        if (!operation.isCurrent(epoch)) return;
        operation.begin(false);
        videoRef.current?.pause();
        replacementAudioRef.current?.pause();
        freezeWallStartRef.current = undefined;
        reverseWallStartRef.current = undefined;
        stateRef.current = { ...stateRef.current, playing: false };
        setState((active) => ({ ...active, playing: false }));
      });
  }, [syncMediaToPlayhead]);
  useEffect(() => {
    if (!state.playing) return;
    const video = videoRef.current;
    const decoder = decoderRef.current;
    const clock = clockRef.current;
    if (video === null || decoder === null || clock === null) return;
    let cancelled = false;
    let boundaryTransitionInFlight = false;
    const stopPlaybackForEpoch = (epoch: number): void => {
      const operation = playbackOperationRef.current;
      if (!operation.isCurrent(epoch)) return;
      operation.begin(false);
      video.pause();
      replacementAudioRef.current?.pause();
      freezeWallStartRef.current = undefined;
      reverseWallStartRef.current = undefined;
      stateRef.current = { ...stateRef.current, playing: false };
      setState((active) => ({ ...active, playing: false }));
    };
    const advancePlaybackAfterClip = (clipEndUs: number): void => {
      const operation = playbackOperationRef.current;
      if (cancelled || boundaryTransitionInFlight || !operation.intendsToPlay) return;
      const rootComposition =
        session.timelineProject.compositions[session.timelineProject.rootCompositionId];
      const durationUs =
        rootComposition === undefined ? clipEndUs : timelineEffectiveDurationUs(rootComposition);
      // Advance across gaps and wrap the final playable clip back to the
      // first. Move the authoritative playhead before loading the next media
      // so the next frame cannot resolve the clip that just finished.
      const nextPlayheadUs = playbackTargetAfterClip(
        withFlattenedRootTimeline(session.timelineProject),
        clipEndUs,
      );
      if (nextPlayheadUs === undefined) {
        operation.begin(false);
        video.pause();
        replacementAudioRef.current?.pause();
        freezeWallStartRef.current = undefined;
        reverseWallStartRef.current = undefined;
        stateRef.current = {
          ...stateRef.current,
          playheadUs: durationUs,
          playing: false,
        };
        setState((active) => ({ ...active, playheadUs: durationUs, playing: false }));
        setRevision((revision) => revision + 1);
        return;
      }
      boundaryTransitionInFlight = true;
      const epoch = operation.begin(true);
      stateRef.current = {
        ...stateRef.current,
        playheadUs: nextPlayheadUs,
        playing: true,
      };
      setState((active) => ({ ...active, playheadUs: nextPlayheadUs, playing: true }));
      void syncMediaToPlayhead(nextPlayheadUs, true, epoch)
        .then((ready) => {
          boundaryTransitionInFlight = false;
          if (!operation.isCurrent(epoch) || !operation.intendsToPlay || cancelled) return;
          if (!ready) {
            stopPlaybackForEpoch(epoch);
            return;
          }
          requestFrame();
        })
        .catch(() => {
          boundaryTransitionInFlight = false;
          stopPlaybackForEpoch(epoch);
        });
    };
    const captureReverseFrame = (
      clip: VideoClip,
      reverse: { readonly wallMs: number; readonly playheadUs: number; readonly epoch: number },
    ): void => {
      const operation = playbackOperationRef.current;
      if (
        reverseFrameInFlightRef.current ||
        !operation.isCurrent(reverse.epoch) ||
        !operation.intendsToPlay ||
        reverseWallStartRef.current !== reverse
      )
        return;
      const compositionTimeUs =
        reverse.playheadUs + Math.floor((performance.now() - reverse.wallMs) * 1_000);
      if (compositionTimeUs >= clip.startUs + clip.durationUs) {
        advancePlaybackAfterClip(clip.startUs + clip.durationUs);
        return;
      }
      const sourceTimeUs = sourceTimeForPlayhead(clip, compositionTimeUs);
      reverseFrameInFlightRef.current = true;
      void seekDetachedVideo(video, sourceTimeUs)
        .then(() => {
          if (
            !operation.isCurrent(reverse.epoch) ||
            !operation.intendsToPlay ||
            reverseWallStartRef.current !== reverse ||
            cancelled
          )
            return;
          scheduler.current.seek(sourceTimeUs);
          const token = scheduler.current.requestToken();
          const frame = decoder.captureCurrentFrame(token);
          const visualComposition =
            session.visualProject.compositions[session.visualProject.rootCompositionId];
          const node = videoFrameNodeFromDecoded(
            videoClipSpecAt(
              session.visualProject,
              session.timelineProject,
              clip,
              compositionTimeUs,
              visualComposition?.height ?? 1920,
            ),
            frame,
            { width: video.videoWidth, height: video.videoHeight },
          );
          if (frame.bitmap === undefined) {
            scheduler.current.recordDecodedFrame(token, false, false);
            playbackDiagnostics.current.recordDecodeMiss();
          } else {
            rememberClipFrame(clip.id, frame.bitmap);
            setPreviewVideoFrame({ node, bitmap: frame.bitmap });
            scheduler.current.recordDecodedFrame(token, true, true);
            playbackDiagnostics.current.recordFrame(undefined, sourceTimeUs, performance.now());
            void captureTransitionPartnerFrames(compositionTimeUs).catch(() => undefined);
          }
          lastMediaTimeUsRef.current = sourceTimeUs;
          stateRef.current = { ...stateRef.current, playheadUs: compositionTimeUs };
          setState((active) => ({ ...active, playheadUs: compositionTimeUs }));
          requestFrame();
        })
        .catch(() => stopPlaybackForEpoch(reverse.epoch))
        .finally(() => {
          reverseFrameInFlightRef.current = false;
        });
    };
    const capture = (frameInfo?: {
      readonly metadata?: VideoFramePresentationMetadata;
      readonly observedAtMs?: number;
    }): void => {
      if (cancelled || !stateRef.current.playing) return;
      const clip = activeVideoClipAt(
        session.timelineProject,
        stateRef.current.playheadUs,
        stateRef.current.selectedIds,
        session.visualProject,
      );
      if (clip === undefined || clip.kind !== 'video') return;
      if (clip.reversed === true) {
        const reverse = reverseWallStartRef.current;
        // A cold OPFS/cloud source can still be loading when the first rAF
        // arrives. Keep the manual decoder cadence alive until sync installs
        // the reverse wall clock; otherwise a single early frame would leave
        // playback visibly "playing" but permanently stalled.
        if (reverse === undefined) {
          playbackFrameRef.current = window.requestAnimationFrame(() => capture());
          return;
        }
        captureReverseFrame(clip, reverse);
        return;
      }
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
        advancePlaybackAfterClip(clip.startUs + clip.durationUs);
        return;
      }
      const token = scheduler.current.requestToken();
      const frame = decoder.captureCurrentFrame(token);
      const observedAtUs = Math.round((frameInfo?.observedAtMs ?? performance.now()) * 1_000);
      const previousObservedAtUs = lastDiagnosticsObservedUsRef.current;
      if (previousObservedAtUs !== undefined && observedAtUs - previousObservedAtUs > 250_000) {
        playbackDiagnostics.current.beginStall(previousObservedAtUs);
        playbackDiagnostics.current.endStall(observedAtUs);
      }
      lastDiagnosticsObservedUsRef.current = observedAtUs;
      const visualComposition =
        session.visualProject.compositions[session.visualProject.rootCompositionId];
      const clipSpec = videoClipSpecAt(
        session.visualProject,
        session.timelineProject,
        clip,
        compositionTimeUs,
        visualComposition?.height ?? 1920,
      );
      const node = videoFrameNodeFromDecoded(clipSpec, frame, {
        width: video.videoWidth,
        height: video.videoHeight,
      });
      if (frame.bitmap === undefined) {
        scheduler.current.recordDecodedFrame(token, false, false);
        playbackDiagnostics.current.recordDecodeMiss();
      } else {
        rememberClipFrame(clip.id, frame.bitmap);
        setPreviewVideoFrame({ node, bitmap: frame.bitmap });
        const previous = lastMediaTimeUsRef.current;
        if (previous === undefined) scheduler.current.recordDecodedFrame(token, true, true);
        else scheduler.current.driveTick(clock, true, Math.max(1, sourceTimeUs - previous));
        playbackDiagnostics.current.recordFrame(
          frameInfo?.metadata,
          sourceTimeUs,
          frameInfo?.observedAtMs,
        );
        void captureTransitionPartnerFrames(compositionTimeUs).catch(() => undefined);
      }
      lastMediaTimeUsRef.current = sourceTimeUs;
      setState((active) => ({ ...active, playheadUs: compositionTimeUs }));
      // setState above already schedules the frame render. Bumping the global
      // revision here redraws the entire workspace a second time per video
      // frame and can turn ordinary compositor jitter into presentation drops.
      requestFrame();
    };
    const requestFrame = (): void => {
      // Freeze holds a still frame — drive with rAF. Otherwise follow media cadence.
      const clip = activeVideoClipAt(
        session.timelineProject,
        stateRef.current.playheadUs,
        [],
        session.visualProject,
      );
      const manualReverse = clip?.kind === 'video' && clip.reversed === true;
      const freeze = clip?.kind === 'video' && normalizePlaybackRate(clip.playbackRate) === 0;
      if (!freeze && !manualReverse && typeof video.requestVideoFrameCallback === 'function')
        playbackFrameRef.current = video.requestVideoFrameCallback((now, metadata) =>
          capture({
            observedAtMs: now,
            metadata: {
              mediaTime: metadata.mediaTime,
              presentedFrames: metadata.presentedFrames,
              expectedDisplayTime: metadata.expectedDisplayTime,
            },
          }),
        );
      else
        playbackFrameRef.current = window.requestAnimationFrame((now) =>
          capture({ observedAtMs: now }),
        );
    };
    playbackTickRef.current = () => capture();
    const onEnded = (): void => {
      const clip = activeVideoClipAt(
        session.timelineProject,
        stateRef.current.playheadUs,
        stateRef.current.selectedIds,
        session.visualProject,
      );
      if (clip !== undefined && clip.kind === 'video')
        advancePlaybackAfterClip(clip.startUs + clip.durationUs);
    };
    video.addEventListener('ended', onEnded);
    requestFrame();
    return () => {
      cancelled = true;
      if (playbackTickRef.current !== undefined) playbackTickRef.current = undefined;
      video.removeEventListener('ended', onEnded);
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
    controlPlaneProject,
    state.playing,
    syncMediaToPlayhead,
  ]);
  const handleMediaReady = useCallback((decoder: HtmlMediaDecoder, clock: MediaClock) => {
    decoderRef.current = decoder;
    clockRef.current = clock;
  }, []);
  useEffect(() => {
    const video = videoRef.current;
    const replacementAudio = replacementAudioRef.current;
    const playbackOperation = playbackOperationRef.current;
    if (video === null) return;
    const captureCanvas = document.createElement('canvas');
    // A zero-sized canvas asks the decoder to size it to the decoded media on
    // first use; this avoids treating the DOM default 300×150 as a proxy size.
    captureCanvas.width = 0;
    captureCanvas.height = 0;
    const decoder = createHtmlMediaDecoder(video, captureCanvas);
    const decoderResourceToken = `${previewResourcePrefixRef.current}:primary`;
    recordPreviewResourceCreated('primary-decoder', decoderResourceToken);
    handleMediaReady(decoder, createHtmlVideoMediaClock(video));
    const firstClip = activeVideoClipAt(session.timelineProject, 0, [], session.visualProject);
    if (firstClip !== undefined && firstClip.kind === 'video') {
      void mediaResolver
        .resolve(firstClip.assetId)
        .then((source) => {
          if (videoRef.current === video) video.src = source.url;
        })
        .catch(() => undefined);
    }
    return () => {
      playbackOperation.begin(false);
      video.pause();
      replacementAudio?.pause();
      decoderRef.current = null;
      clockRef.current = null;
      video.removeAttribute('src');
      video.load();
      replacementAudio?.removeAttribute('src');
      replacementAudio?.load();
      captureCanvas.width = 0;
      captureCanvas.height = 0;
      recordPreviewResourceReleased('primary-decoder', decoderResourceToken);
    };
  }, [handleMediaReady, mediaResolver, session]);
  const togglePlayback = useCallback(() => {
    const current = stateRef.current;
    const operation = playbackOperationRef.current;
    if (operation.intendsToPlay) {
      operation.begin(false);
      videoRef.current?.pause();
      replacementAudioRef.current?.pause();
      freezeWallStartRef.current = undefined;
      reverseWallStartRef.current = undefined;
      reverseFrameInFlightRef.current = false;
      stateRef.current = { ...current, playing: false };
      setState((active) => ({ ...active, playing: false }));
      return;
    }
    ensurePreviewAudioGraph();
    void audioContextRef.current?.resume();
    const startUs = playbackStartAtOrAfter(
      withFlattenedRootTimeline(session.timelineProject),
      current.playheadUs,
    );
    if (startUs === undefined) {
      operation.begin(false);
      stateRef.current = { ...current, playing: false };
      setState((active) => ({ ...active, playing: false }));
      return;
    }
    const epoch = operation.begin(true);
    scheduler.current.seek(startUs);
    stateRef.current = { ...current, playheadUs: startUs, playing: true };
    setState((active) => ({ ...active, playheadUs: startUs, playing: true }));
    void syncMediaToPlayhead(startUs, true, epoch)
      .then((ready) => {
        if (ready || !operation.isCurrent(epoch)) return;
        operation.begin(false);
        videoRef.current?.pause();
        replacementAudioRef.current?.pause();
        stateRef.current = { ...stateRef.current, playing: false };
        setState((active) => ({ ...active, playing: false }));
      })
      .catch(() => {
        if (!operation.isCurrent(epoch)) return;
        operation.begin(false);
        videoRef.current?.pause();
        replacementAudioRef.current?.pause();
        stateRef.current = { ...stateRef.current, playing: false };
        setState((active) => ({ ...active, playing: false }));
      });
  }, [ensurePreviewAudioGraph, session, syncMediaToPlayhead]);
  const dispatchTimeline = useCallback(
    (transaction: CommandTransaction) => {
      const presentationTarget = derivedClipPresentationTarget(transaction);
      const removedClipId = removedClipPresentationTarget(transaction);
      if (presentationTarget !== undefined) {
        const sourceClip = Object.values(session.timelineProject.compositions)
          .flatMap((composition) => composition.tracks)
          .flatMap((track) => track.clips)
          .find((clip) => clip.id === presentationTarget.originalClipId);
        const splitLocalUs =
          presentationTarget.splitAtUs === undefined || sourceClip === undefined
            ? undefined
            : presentationTarget.splitAtUs - sourceClip.startUs;
        const presentation = buildDerivedClipPresentation(
          session.visualProject,
          audioState,
          presentationTarget.originalClipId,
          presentationTarget.derivedClipIds,
          splitLocalUs === undefined ? {} : { splitLocalUs },
        );
        const syncedPresentation = updateUniversalTimelineForTransaction(
          presentation.project,
          transaction,
        );
        session.dispatchCompound(transaction.label, {
          timeline: transaction,
          document: syncedPresentation,
        });
        setAudioStateRaw(presentation.audio);
      } else if (removedClipId !== undefined) {
        session.dispatchCompound(transaction.label, {
          timeline: transaction,
          document: updateUniversalTimelineForTransaction(
            removeClipPropertyAnimations(session.visualProject, removedClipId),
            transaction,
          ),
        });
      } else {
        const universalProject = updateUniversalTimelineForTransaction(
          session.visualProject,
          transaction,
        );
        if (universalProject === session.visualProject) session.dispatchTimeline(transaction);
        else
          session.dispatchCompound(transaction.label, {
            timeline: transaction,
            document: universalProject,
          });
      }
      resyncTimelineMedia();
      setRevision((revision) => revision + 1);
    },
    [audioState, resyncTimelineMedia, session],
  );
  const dispatchTimelineAndProjectAudio = useCallback(
    (
      label: string,
      timeline: CommandTransaction,
      nextVisualProject: JoyProjectV1,
      nextAudioState: AudioState,
    ) => {
      session.dispatchCompound(label, {
        timeline,
        document: withProjectAudio(nextVisualProject, nextAudioState),
      });
      setAudioStateRaw(nextAudioState);
      resyncTimelineMedia();
      setRevision((revision) => revision + 1);
    },
    [resyncTimelineMedia, session],
  );
  const dispatchGraph = useCallback(
    (transaction: GraphTransaction) => {
      session.dispatchGraph(transaction);
      setRevision((revision) => revision + 1);
    },
    [session],
  );
  const dispatchArtifacts = useCallback(
    (transaction: ArtifactTransaction) => {
      session.dispatchArtifacts(transaction);
      setRevision((revision) => revision + 1);
    },
    [session],
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
      const transaction: VisualObjectTransaction = {
        label: `Set ${key}`,
        commands: [{ type: 'object.setTransformProperty', payload: { objectId, key, value } }],
      };
      session.dispatchVisualObjects(transaction);
      setRevision((revision) => revision + 1);
    },
    [session],
  );
  const dispatchProject = useCallback(
    (transaction: VisualObjectTransaction) => {
      session.dispatchVisualObjects(transaction);
      setRevision((revision) => revision + 1);
    },
    [session],
  );

  const replaceVisualProject = useCallback(
    (next: JoyProjectV1) => {
      session.replaceVisualProject(next);
      setRevision((revision) => revision + 1);
    },
    [session],
  );
  const replaceVisualProjectAndAudio = useCallback(
    (next: JoyProjectV1, nextAudio: AudioState) => {
      session.replaceVisualProject(withProjectAudio(next, nextAudio));
      setAudioStateRaw(nextAudio);
      setRevision((revision) => revision + 1);
    },
    [session],
  );

  const syncStickerBitmaps = useCallback(
    async (project = session.visualProject) => {
      const mattes = readImageMatteMap(project);
      const activeStickerIds = new Set(
        Object.values(project.visualObjects)
          .filter((object) => object.kind === 'image' && object.assetId !== undefined)
          .map((object) => object.id),
      );
      stickerImageCache.clearMissing(activeStickerIds);
      await Promise.all(
        Object.values(project.visualObjects).map(async (object) => {
          if (object.kind !== 'image' || object.assetId === undefined) return;
          const assetRecord = project.assets[object.assetId];
          await stickerImageCache.syncObject({
            objectId: object.id,
            assetId: object.assetId,
            ...(mattes[object.id] !== undefined ? { matteAssetId: mattes[object.id] } : {}),
            crop: object.transform.crop,
            ...(assetRecord?.descriptor?.animation !== undefined
              ? { animation: assetRecord.descriptor.animation }
              : {}),
            ...(assetRecord?.descriptor?.mimeType !== undefined
              ? { mimeType: assetRecord.descriptor.mimeType }
              : {}),
            loadBlob: loadStickerAssetBlob,
          });
        }),
      );
      setStickerTick((tick) => tick + 1);
    },
    [session],
  );

  const addStickerFromAsset = useCallback(
    async (asset: {
      readonly assetId: string;
      readonly displayName?: string;
      readonly blob?: Blob;
    }) => {
      if (asset.blob !== undefined) stickerImageCache.rememberBlob(asset.assetId, asset.blob);
      const objectId = `sticker-${asset.assetId}-${Date.now().toString(36)}`;
      const clipId = `clip-${objectId}`;
      const composition =
        session.timelineProject.compositions[session.timelineProject.rootCompositionId];
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
      const label = `Add sticker ${asset.displayName ?? asset.assetId}`;
      const clip: VideoClip = {
        id: clipId,
        kind: 'video',
        assetId: asset.assetId,
        startUs,
        durationUs,
        sourceInUs: 0,
      };
      const document = buildTimelineElementDocument({
        baseProject: session.visualProject,
        clipId,
        planned: { compositionId: composition.id, trackId: track.id, clip },
        elementKind: 'image',
        source: { kind: 'object', id: objectId },
        visualObject: {
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
      });
      session.dispatchCompound(label, {
        document,
        timeline: {
          label,
          commands: [
            {
              type: 'timeline.insertClip',
              payload: { compositionId: composition.id, trackId: track.id, clip },
            },
          ],
        },
      });
      await syncStickerBitmaps();
      setState((current) => ({ ...current, selectedIds: [clipId] }));
      setRevision((revision) => revision + 1);
    },
    [session, syncStickerBitmaps],
  );

  const addJoyCode3DRender = useCallback(
    async (asset: JoyCode3DRenderAsset) => {
      const composition =
        session.timelineProject.compositions[session.timelineProject.rootCompositionId];
      if (composition === undefined || composition.durationUs <= 0) {
        throw new Error('The main timeline is unavailable.');
      }

      stickerImageCache.rememberBlob(asset.assetId, asset.blob);
      const insertion = buildThreeDRenderLayerInsertion({
        timeline: session.timelineProject,
        project: session.visualProject,
        playheadUs: state.playheadUs,
        token: Date.now().toString(36),
        asset: {
          assetId: asset.assetId,
          displayName: asset.displayName,
          bytes: asset.blob.size,
          mimeType: asset.blob.type || 'image/png',
        },
      });
      session.dispatchCompound(insertion.label, {
        timeline: insertion.timeline,
        document: insertion.project,
      });
      await syncStickerBitmaps();
      setState((current) => ({ ...current, selectedIds: [insertion.clipId] }));
      setRevision((revision) => revision + 1);
      showToast('3D render added as an editable timeline layer.', 'success');
    },
    [session, showToast, state.playheadUs, syncStickerBitmaps],
  );

  const addTreatmentLayer = useCallback(
    (kind: TreatmentLayerKind, targetClipId: string, effect?: TreatmentLayerEffectSeed) => {
      try {
        const insertion = buildTreatmentLayerInsertion({
          timeline: session.timelineProject,
          project: session.visualProject,
          targetClipId,
          token: Date.now().toString(36),
          kind,
          ...(effect === undefined ? {} : { effect }),
        });
        session.dispatchCompound(insertion.label, {
          timeline: insertion.timeline,
          document: insertion.project,
        });
        resyncTimelineMedia();
        setState((current) => ({ ...current, selectedIds: [insertion.clipId] }));
        setRevision((revision) => revision + 1);
        const name = kind === 'effect' ? 'Effects' : kind === 'filter' ? 'Filters' : 'Adjust';
        showToast(
          `${effect === undefined ? name : effect.effectId} layer added and parented to the selected media.`,
          'success',
        );
      } catch (reason) {
        showToast(reason instanceof Error ? reason.message : String(reason), 'info');
      }
    },
    [resyncTimelineMedia, session, showToast],
  );

  const addAdjustmentLayer = useCallback(
    (targetClipId: string) => addTreatmentLayer('adjust', targetClipId),
    [addTreatmentLayer],
  );

  const addCaptionLayer = useCallback(() => {
    try {
      const insertion = buildCaptionLayerInsertion({
        timeline: session.timelineProject,
        project: session.visualProject,
        token: Date.now().toString(36),
      });
      session.dispatchCompound(insertion.label, {
        timeline: insertion.timeline,
        document: insertion.project,
      });
      resyncTimelineMedia();
      setState((current) => ({ ...current, selectedIds: [insertion.clipId] }));
      setRevision((revision) => revision + 1);
      showToast('CC captions layer added to the timeline.', 'success');
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : String(reason), 'error');
    }
  }, [resyncTimelineMedia, session, showToast]);

  const addHtmlSceneToSelectedClip = useCallback(
    (scenePackageId: string) => {
      const composition =
        session.timelineProject.compositions[session.timelineProject.rootCompositionId];
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
            track.family !== 'audio' &&
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
                    family: 'visual' as const,
                    order,
                    enabled: true,
                    clips: [],
                  },
                },
              },
              insertClipCommand,
            ]
          : [insertClipCommand];

      const object: VisualObjectV1 = {
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
      };
      const document = buildTimelineElementDocument({
        baseProject: session.visualProject,
        clipId,
        planned: {
          compositionId: composition.id,
          trackId: targetTrackId,
          clip: insertClipCommand.payload.clip,
        },
        elementKind: 'html-scene',
        source: { kind: 'object', id: objectId },
        visualObject: object,
      });
      const label = `Place HTML scene ${scenePackageId}`;
      session.dispatchCompound(label, {
        document,
        timeline: { label, commands: timelineCommands },
      });
      setState((current) => ({ ...current, selectedIds: [clipId] }));
      setRevision((revision) => revision + 1);
    },
    [session, state.selectedIds],
  );

  const setAudioState = useCallback(
    (next: AudioState) => {
      session.replaceVisualProject(withProjectAudio(session.visualProject, next));
      setAudioStateRaw(next);
      setRevision((revision) => revision + 1);
    },
    [session],
  );

  const timelineClipIds = useMemo(() => {
    const kinds = readTimelineElementKindMap(session.visualProject);
    return (
      session.timelineProject.compositions[
        session.timelineProject.rootCompositionId
      ]?.tracks.flatMap((track) =>
        track.clips
          .filter((clip) => {
            const kind = timelineElementKindForClip(clip, kinds);
            return kind === 'video' || kind === 'overlay' || kind === 'audio';
          })
          .map((clip) => clip.id),
      ) ?? []
    );
  }, [session.timelineProject, session.visualProject]);
  useEffect(() => {
    // The initial state comes from the legacy key because the EditorSession is
    // created later in this component. Wait until canonical project audio has
    // hydrated before deriving clip rows; otherwise StrictMode can persist the
    // same stale migration twice during reload and invalidate an interrupted
    // export's immutable retry fingerprint.
    if (!audioHydrated) return;
    const next = ensureClipAudio(audioState, timelineClipIds);
    if (next === audioState) return;
    try {
      session.synchronizeVisualProject(withProjectAudio(session.visualProject, next));
      setAudioStateRaw(next);
    } catch (error) {
      showToast(
        `Audio metadata could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }
  }, [audioHydrated, audioState, session, showToast, timelineClipIds]);

  const transcribe = useCallback(
    async (documentId: string, language: 'fa-IR' | 'en-US') => {
      try {
        const clip = activeVideoClipAt(
          session.timelineProject,
          state.playheadUs,
          state.selectedIds,
          session.visualProject,
        );
        if (clip === undefined || clip.kind !== 'video')
          throw new Error('Place a media clip before transcribing.');
        const source = await mediaResolver.resolve(clip.assetId);
        const response = await fetch(source.url);
        if (!response.ok) throw new Error(`Unable to read ${clip.assetId} for transcription.`);
        const media = await response.blob();
        const document = await transcribeReferenceCaption(
          documentId,
          language,
          mediaControlPlaneClient,
          { media, mediaType: source.mimeType },
        );
        session.dispatchVisualObjects({
          label: `Transcribe ${language}`,
          commands: [{ type: 'caption.replaceDocument', payload: { documentId, document } }],
        });
        setTranscriptionError(undefined);
        setRevision((revision) => revision + 1);
      } catch (error) {
        setTranscriptionError(
          error instanceof Error ? error.message : 'Local transcription is unavailable.',
        );
      }
    },
    [mediaResolver, session, state.playheadUs, state.selectedIds],
  );
  const reconcileWorkerResultOperations = useCallback(() => {
    for (const record of operationLedger.list()) {
      if (record.type !== 'worker-job' || record.resultRef === undefined) continue;
      const asset = session.visualProject.assets[record.resultRef];
      const parameters = asset?.generationProvenance?.parameters;
      const parameterRecord = recordValue(parameters);
      const isApplied =
        asset?.generationProvenance?.providerId === 'local-worker' &&
        parameterRecord?.jobId === record.id;
      if (isApplied && record.status === 'review')
        operationLedger.finish(record.id, 'applied', { resultRef: record.resultRef });
      if (!isApplied && record.status === 'applied')
        operationLedger.finish(record.id, 'review', { resultRef: record.resultRef });
    }
  }, [operationLedger, session]);
  const reconcileSelection = useCallback(() => {
    setState((current) => {
      const selectedIds = reconcileTimelineSelection(session.timelineProject, current.selectedIds);
      return selectedIds.length === current.selectedIds.length
        ? current
        : { ...current, selectedIds: [...selectedIds] };
    });
  }, [session]);
  const undo = useCallback(() => {
    session.undo();
    reconcileSelection();
    setAudioStateRaw(
      loadAudioStateFromProject(window.localStorage, projectId, session.visualProject),
    );
    reconcileWorkerResultOperations();
    setRevision((revision) => revision + 1);
  }, [projectId, reconcileSelection, reconcileWorkerResultOperations, session]);
  const redo = useCallback(() => {
    session.redo();
    reconcileSelection();
    setAudioStateRaw(
      loadAudioStateFromProject(window.localStorage, projectId, session.visualProject),
    );
    reconcileWorkerResultOperations();
    setRevision((revision) => revision + 1);
  }, [projectId, reconcileSelection, reconcileWorkerResultOperations, session]);
  const jumpToHistory = useCallback(
    (sequence: number) => {
      session.jumpToHistory(sequence);
      reconcileSelection();
      setAudioStateRaw(
        loadAudioStateFromProject(window.localStorage, projectId, session.visualProject),
      );
      reconcileWorkerResultOperations();
      setRevision((revision) => revision + 1);
    },
    [projectId, reconcileSelection, reconcileWorkerResultOperations, session],
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
    const route = featureActivationRoute(panelId);
    if (route?.hub === 'create') setCreateTool(route.toolId);
    if (route?.hub === 'enhance') setEnhanceTool(route.toolId);
    const dockPanelId = route?.dockPanelId ?? panelId;
    const api = dockviewApiRef.current;
    if (api === null) return;
    let panel = api.getPanel(dockPanelId);
    if (panel === undefined) {
      api.addPanel({
        id: dockPanelId,
        component: 'editor-panel',
        title: panelLabel(dockPanelId),
        minimumWidth: DOCK_PANEL_MINIMUM_WIDTH,
        minimumHeight: DOCK_PANEL_MINIMUM_HEIGHT,
      });
      panel = api.getPanel(dockPanelId);
    }
    panel?.api.setActive();
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
  const [animationGraphFocus, setAnimationGraphFocus] = useState<
    AnimationGraphFocusRequest | undefined
  >(undefined);
  const openAnimationGraph = useCallback(
    (objectId: string, channel: AnimatablePropertyV1) => {
      setAnimationGraphFocus({ objectId, channel, token: Date.now() });
      activatePanel('motion');
    },
    [activatePanel],
  );
  const selectClips = useCallback((clipIds: readonly string[]) => {
    setState((current) => ({ ...current, selectedIds: [...clipIds] }));
  }, []);
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
  useEffect(() => {
    if (session.recoveryWarnings.length === 0) return;
    showToast(
      `Recovered with ${session.recoveryWarnings.length} warning${session.recoveryWarnings.length === 1 ? '' : 's'}. Check persistence diagnostics before continuing.`,
      'error',
    );
  }, [session, showToast]);
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
        void openJoyCodeOpfsAssetCache()
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

    for (const panel of CORE_WORKSPACE_PANELS) {
      addPanel(panel, {
        inactive: true,
        ...(panel === 'flow' && api.getPanel('timeline') !== undefined
          ? { position: { referencePanel: 'timeline', direction: 'within' as const } }
          : {}),
      });
    }
  }, []);

  const applyDockLayout = useCallback(
    (api: DockviewApi, mode: EditorViewMode, preset = workspacePresetRef.current) => {
      const layoutKey =
        preset === 'edit' ? dockLayoutKey(mode) : workspacePresetLayoutKey(mode, preset);
      const saved = window.localStorage.getItem(layoutKey);
      let restored = false;
      if (saved !== null) {
        try {
          api.fromJSON(migrateDockLayout(JSON.parse(saved)) as never, {
            reuseExistingPanels: false,
          });
          restored = true;
        } catch {
          window.localStorage.removeItem(layoutKey);
        }
      }
      if (!restored) {
        try {
          api.fromJSON(
            (preset === 'edit'
              ? seedDockLayout(mode)
              : workspacePresetLayout(preset, mode)) as never,
            { reuseExistingPanels: false },
          );
        } catch (error) {
          console.warn('default dock layout rejected, falling back to a stack', error);
        }
      }
      ensureDockPanels(api);
      api.getPanel('monitor')?.api.setActive();
      window.localStorage.setItem(layoutKey, serializeDockLayout(api.toJSON()));
    },
    [ensureDockPanels],
  );

  const persistUiPreferences = useCallback(
    (next: Partial<{ workspacePreset: WorkspacePresetId; viewMode: EditorViewMode }>) => {
      const current = loadEditorUiPreferences(window.localStorage);
      saveEditorUiPreferences(window.localStorage, {
        ...current,
        ...next,
      });
    },
    [],
  );

  const switchWorkspacePreset = useCallback(
    (next: WorkspacePresetId) => {
      if (next === workspacePresetRef.current) return;
      const api = dockviewApiRef.current;
      const current = workspacePresetRef.current;
      const mode = viewModeRef.current;
      if (api !== null && current !== 'custom') {
        window.localStorage.setItem(
          workspacePresetLayoutKey(mode, 'custom'),
          serializeDockLayout(api.toJSON()),
        );
      }
      workspacePresetRef.current = next;
      setWorkspacePreset(next);
      persistUiPreferences({ workspacePreset: next });
      if (api !== null) applyDockLayout(api, mode, next);
    },
    [applyDockLayout, persistUiPreferences],
  );

  const resetWorkspace = useCallback(() => {
    for (const mode of ['vertical', 'widescreen'] as const) {
      window.localStorage.removeItem(dockLayoutKey(mode));
      for (const preset of ['enhance', 'audio-captions', 'automate', 'custom'] as const) {
        window.localStorage.removeItem(workspacePresetLayoutKey(mode, preset));
      }
    }
    window.localStorage.removeItem(EDITOR_UI_PREFERENCES_KEY);
    workspacePresetRef.current = DEFAULT_EDITOR_UI_PREFERENCES.workspacePreset;
    setWorkspacePreset(DEFAULT_EDITOR_UI_PREFERENCES.workspacePreset);
    setViewMode(DEFAULT_EDITOR_UI_PREFERENCES.viewMode);
    viewModeRef.current = DEFAULT_EDITOR_UI_PREFERENCES.viewMode;
    const api = dockviewApiRef.current;
    if (api !== null) applyDockLayout(api, 'vertical', 'edit');
  }, [applyDockLayout]);

  const switchEditorView = useCallback(() => {
    const api = dockviewApiRef.current;
    if (api === null) return;
    const current = viewModeRef.current;
    window.localStorage.setItem(dockLayoutKey(current), serializeDockLayout(api.toJSON()));
    const next: EditorViewMode = current === 'vertical' ? 'widescreen' : 'vertical';
    saveViewMode(window.localStorage, next);
    persistUiPreferences({ viewMode: next });
    setViewMode(next);
    applyDockLayout(api, next, workspacePresetRef.current);
  }, [applyDockLayout, persistUiPreferences]);

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
    if (!window.confirm('Sign out of JOY Studio? Your local project will remain on this device.'))
      return;
    setAccountOpen(false);
    await logoutJoySession(window.localStorage);
    refreshJoySession();
  }, [refreshJoySession]);
  const recordExportEntry = useCallback(
    (entry: ProjectExportProcessEntry) => {
      const next = upsertProjectEntry(exportHistoryRef.current, entry);
      saveProjectExportHistory(window.localStorage, projectId, next);
      exportHistoryRef.current = next;
      setExportHistory(next);
    },
    [projectId],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = resolveShortcut(event);
      if (action === undefined) return;
      // Escape must close the palette even while its search input has focus.
      if (
        action !== 'palette.close' &&
        (isEditableTarget(event.target) || isInteractiveTarget(event.target))
      )
        return;
      if (action === 'playback.toggle' && event.repeat) {
        event.preventDefault();
        return;
      }
      const current = stateRef.current;
      const composition =
        session.timelineProject.compositions[session.timelineProject.rootCompositionId];
      const durationUs = composition === undefined ? 0 : timelineEffectiveDurationUs(composition);
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
          if (composition === undefined || current.selectedIds.length === 0) return;
          const plan = buildTimelineDeletePlan({
            composition,
            selectedIds: current.selectedIds,
            tracks: timelineTrackFlags,
          });
          if (!plan.ok) {
            showToast(plan.reason, 'info');
            return;
          }
          dispatchTimeline(plan.transaction);
          setState((active) => ({
            ...active,
            selectedIds: active.selectedIds.filter((id) => !plan.clipIds.includes(id)),
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
  }, [dispatchTimeline, redo, seek, session, showToast, timelineTrackFlags, togglePlayback, undo]);

  const runSelectedClipAction = useCallback(
    (kind: 'split' | 'duplicate' | 'delete') => {
      const current = stateRef.current;
      const composition =
        session.timelineProject.compositions[session.timelineProject.rootCompositionId];
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
      const plan = buildTimelineDeletePlan({
        composition,
        selectedIds: current.selectedIds,
        tracks: timelineTrackFlags,
      });
      if (!plan.ok) {
        showToast(plan.reason, 'info');
        return;
      }
      dispatchTimeline(plan.transaction);
      setState((active) => ({
        ...active,
        selectedIds: active.selectedIds.filter((id) => !plan.clipIds.includes(id)),
      }));
    },
    [dispatchTimeline, session, showToast, timelineTrackFlags],
  );

  const handleExport = useCallback(
    async (retryEntry?: ProjectExportProcessEntry) => {
      if (exportInFlightRef.current) return;
      const retryPreset = retryEntry?.presetId;
      if (
        retryPreset !== undefined &&
        retryPreset !== 'reels-1080' &&
        retryPreset !== 'shorts-1080' &&
        retryPreset !== 'youtube-1080' &&
        retryPreset !== 'high-bitrate'
      ) {
        setExportStatus('Export retry failed: the saved preset is no longer supported.');
        return;
      }
      const activeExportPreset = retryPreset ?? exportPreset;
      const exportTimelineProject = structuredClone(session.timelineProject);
      const exportVisualProject = structuredClone(session.visualProject);
      const exportAudioState = structuredClone(audioState);
      const missingLuts = missingColorLutExportDependencies(exportVisualProject);
      if (missingLuts.length > 0) {
        setExportStatus(
          `Export blocked: restore the required LUT${missingLuts.length === 1 ? '' : 's'} (${missingLuts.join(', ')}).`,
        );
        return;
      }
      const sourceProjectRevisionId = session.projectRevisionId;
      const sourceRevision = session.historyCursorSequence;
      let selectedMimeType: ReturnType<typeof selectBrowserMp4MimeType>;
      try {
        selectedMimeType = selectBrowserMp4MimeType();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        window.clearTimeout(exportToastTimerRef.current);
        setExportStatus(`Export failed: ${message}`);
        setExportProgress(undefined);
        exportToastTimerRef.current = window.setTimeout(() => {
          setExportStatus(undefined);
        }, 8_000);
        return;
      }
      exportInFlightRef.current = true;
      const abortController = new AbortController();
      exportAbortRef.current = abortController;
      setExporting(true);
      window.clearTimeout(exportToastTimerRef.current);
      setExportStatus('Building render manifest…');
      setExportProgress(0.02);
      const entryId = retryEntry?.id ?? `export-${Date.now()}`;
      const startedAt = retryEntry?.startedAt ?? new Date().toISOString();
      const exportFilename = retryEntry?.filename ?? `joy-media-export-${Date.now()}.mp4`;
      let retryManifest: ExportRetryManifest | undefined;
      let exportFingerprint: string | undefined;
      let retryInputsAccepted = retryEntry === undefined;
      const startTimers: number[] = [];
      let activeAudioContext: AudioContext | undefined;
      let activeMixedAudioSource: AudioBufferSourceNode | undefined;
      let mixedAudioStarted = false;
      let activeRenderer: BrowserPixiRenderer | undefined;
      let activeRecorderCanvas: HTMLCanvasElement | undefined;
      const exportMediaCleanup: Array<{
        readonly video?: HTMLVideoElement;
        readonly animated?: AnimatedImageFrameSource;
      }> = [];
      let activeExportAudioTrack: MediaStreamTrack | undefined;
      let operationStarted = false;
      let exportCompleted = false;
      let pendingExportUrl: string | undefined;
      try {
        const estimate = await navigator.storage?.estimate?.();
        if (
          estimate?.quota !== undefined &&
          estimate.usage !== undefined &&
          estimate.quota > 0 &&
          estimate.usage / estimate.quota > 0.95
        ) {
          throw new Error('Browser storage is almost full. Free space before exporting.');
        }
        await syncStickerBitmaps(exportVisualProject);
        const compositionV1 =
          exportVisualProject.compositions[exportVisualProject.rootCompositionId];
        const baseWidth = compositionV1?.width ?? 1080;
        const baseHeight = compositionV1?.height ?? 1920;
        const { width, height } = (() => {
          switch (activeExportPreset) {
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
        const compositionTimeline =
          exportTimelineProject.compositions[exportTimelineProject.rootCompositionId];
        const allTimelineClips = flattenRootTimelineVideoClips(exportTimelineProject);
        const exportElementKinds = readTimelineElementKindMap(exportVisualProject);
        const playableTimelineClips = allTimelineClips.filter((clip) => {
          const kind = timelineElementKindForClip(clip, exportElementKinds);
          const assetKind = exportVisualProject.assets[clip.assetId]?.kind;
          return isExportVisualTimelineClip(kind, assetKind);
        });
        const durationTimelineClips = allTimelineClips.filter((clip) => {
          const kind = timelineElementKindForClip(clip, exportElementKinds);
          const assetKind = exportVisualProject.assets[clip.assetId]?.kind;
          return isExportDurationTimelineClip(kind, assetKind);
        });
        const contentEndUs = durationTimelineClips.reduce(
          (end, clip) => Math.max(end, clip.startUs + clip.durationUs),
          0,
        );
        const durationUs =
          contentEndUs > 0 ? contentEndUs : (compositionTimeline?.durationUs ?? 30_000_000);
        const frameRate = 30;
        const totalFrames = Math.max(1, Math.round((durationUs / 1_000_000) * frameRate));
        const manifest: BrowserExportManifest = Object.freeze({
          width,
          height,
          frameRate,
          durationUs,
        });
        retryManifest = manifest;
        exportFingerprint = `${sourceProjectRevisionId}:${activeExportPreset}:${width}x${height}:${durationUs}:${frameRate}`;
        if (
          retryEntry !== undefined &&
          (retryEntry.projectId !== projectId ||
            retryEntry.fingerprint !== exportFingerprint ||
            JSON.stringify(retryEntry.manifest) !== JSON.stringify(retryManifest))
        )
          throw new Error('The project changed since this export attempt. Start a new export.');
        retryInputsAccepted = true;
        recordExportEntry({
          id: entryId,
          projectId,
          filename: exportFilename,
          status: 'running',
          cacheState: 'none',
          startedAt,
          mimeType: selectedMimeType,
          fingerprint: exportFingerprint,
          revision: sourceRevision,
          presetId: activeExportPreset,
          manifest: retryManifest,
        });
        operationLedger.begin({
          id: entryId,
          type: 'export',
          fingerprint: exportFingerprint,
          revision: sourceRevision,
        });
        operationStarted = true;
        const cameraId = compositionV1?.activeCameraId;
        const objectsById = exportVisualProject.visualObjects as Readonly<
          Record<string, VisualObjectV1>
        >;
        const buildFrame = (timeUs: number) => {
          const resolved: ResolvedObject[] = Object.values(exportVisualProject.visualObjects).map(
            (object) => ({
              object,
              transform: evaluateCameraExpressionTransform(
                object.id,
                cameraId,
                objectsById,
                timeUs,
                height,
              ).transform,
            }),
          );
          return withCaptionBurnInNodes(
            buildRenderFrameIR(
              compositionV1?.id ?? 'root',
              timeUs,
              width,
              height,
              resolved,
              renderFrameOptions(
                exportVisualProject,
                exportTimelineProject,
                timeUs,
                imageSizesFromCache(),
              ),
            ),
            exportVisualProject,
          );
        };
        const clipsByBoundary = playableTimelineClips;
        const transitionPartnerClips = (exportVisualProject.transitions ?? []).flatMap(
          (transition) =>
            [transition.leftClipId, transition.rightClipId]
              .map((clipId) => findVideoClipById(exportTimelineProject, clipId))
              .filter((clip): clip is VideoClip => clip !== undefined),
        );
        const exportClips = [...clipsByBoundary, ...transitionPartnerClips].filter(
          (clip, index, clips) =>
            clips.findIndex((candidate) => candidate.id === clip.id) === index,
        );
        if (exportClips.length === 0)
          throw new Error('No playable visual clips are available for export');

        setExportStatus('Preloading preview-equivalent video and audio…');
        setExportProgress(0.05);
        const audioContext = new AudioContext();
        activeAudioContext = audioContext;
        const audioDestination = audioContext.createMediaStreamDestination();
        const preloadStage = <T,>(
          stage: ExportPreloadStage,
          operation: (signal: AbortSignal) => Promise<T>,
        ) => {
          setExportStatus(`${stage[0]!.toUpperCase()}${stage.slice(1)}…`);
          return runExportPreloadStage(stage, operation, abortController.signal);
        };
        const exportMedia = await Promise.all(
          exportClips.map(async (clip) => {
            const clipAudioConfig = exportAudioState.clips[clip.id] ?? {
              gain: 1,
              pan: 0,
              mute: false,
              solo: false,
            };
            const audioAssetId = clipAudioConfig.sourceAssetId ?? clip.assetId;
            const source = await preloadStage('resolving source', () =>
              mediaResolver.resolve(playbackAssetId(session.visualProject, clip)),
            );
            const audioSource =
              audioAssetId === clip.assetId
                ? source
                : await preloadStage('resolving source', () => mediaResolver.resolve(audioAssetId));
            const assetKind = exportVisualProject.assets[clip.assetId]?.kind ?? 'video';
            let video: HTMLVideoElement | undefined;
            let decoder: ReturnType<typeof createHtmlMediaDecoder> | undefined;
            let stillFrame: ImageDataLike | undefined;
            let animatedFrameSource: AnimatedImageFrameSource | undefined;
            if (assetKind !== 'audio') {
              if (assetKind === 'image') {
                abortController.signal.throwIfAborted();
                const declaredAnimation =
                  exportVisualProject.assets[clip.assetId]?.descriptor?.animation;
                const imageResponse = await fetch(source.url, { signal: abortController.signal });
                if (!imageResponse.ok)
                  throw new Error(`Unable to fetch export image ${clip.assetId}`);
                const imageBlob = await imageResponse.blob();
                const animation =
                  declaredAnimation ?? inspectImageAnimation(await imageBlob.arrayBuffer());
                if (animation !== undefined) {
                  setExportStatus('Decoding animated image…');
                  animatedFrameSource = await createAnimatedImageFrameSource(imageBlob, animation);
                  exportMediaCleanup.push({ animated: animatedFrameSource });
                } else {
                  stillFrame = await decodeStillFrame(source.url);
                }
                abortController.signal.throwIfAborted();
              } else {
                video = document.createElement('video');
                exportMediaCleanup.push({ video });
                setExportStatus('Loading detached video…');
                await loadDetachedVideo(video, source.url, abortController.signal);
                setExportStatus('Seeking video…');
                await seekExportDetachedVideo(video, clip.sourceInUs, abortController.signal);
                const captureCanvas = document.createElement('canvas');
                captureCanvas.width = 0;
                captureCanvas.height = 0;
                decoder = createHtmlMediaDecoder(video, captureCanvas);
              }
            }
            let sampleRate = 48_000;
            let fullSamples: Float32Array | undefined;
            const hasAuthoredAudio = assetKind !== 'image' || clipAudioConfig.sourceAssetId != null;
            if (hasAuthoredAudio) {
              const authoredAudioBytes = await preloadStage(
                'fetching authored audio bytes',
                async (signal) => {
                  const audioResponse = await fetch(audioSource.url, { signal });
                  if (!audioResponse.ok)
                    throw new Error(`Unable to fetch export audio for ${audioAssetId}`);
                  return audioResponse.arrayBuffer();
                },
              );
              const audioBuffer = await preloadStage('decoding authored audio', () =>
                audioContext.decodeAudioData(authoredAudioBytes),
              );
              sampleRate = audioBuffer.sampleRate;
              const channels = audioBuffer.numberOfChannels;
              fullSamples = new Float32Array(audioBuffer.length);
              const monoChannel = new Float32Array(audioBuffer.length);
              for (let channel = 0; channel < channels; channel++) {
                audioBuffer.copyFromChannel(monoChannel, channel);
                for (let index = 0; index < monoChannel.length; index++) {
                  fullSamples[index] = fullSamples[index]! + monoChannel[index]! / channels;
                }
              }
            }
            const rate = normalizePlaybackRate(clip.playbackRate);
            const sourceSpanUs = Math.max(1, Math.round(clip.durationUs * rate));
            const sourceStartUs =
              clip.reversed === true
                ? Math.max(0, clip.sourceInUs - sourceSpanUs + 1)
                : clip.sourceInUs;
            const sourceStartSample = Math.max(
              0,
              Math.floor((sourceStartUs * sampleRate) / 1_000_000),
            );
            const sourceLength = Math.max(1, Math.ceil((sourceSpanUs * sampleRate) / 1_000_000));
            let samples: Float32Array<ArrayBufferLike> =
              fullSamples?.slice(
                sourceStartSample,
                Math.min(fullSamples.length, sourceStartSample + sourceLength),
              ) ?? new Float32Array(sourceLength);
            if (clip.reversed === true) {
              const reversed = new Float32Array(samples.length);
              for (let index = 0; index < samples.length; index++)
                reversed[index] = samples[samples.length - 1 - index]!;
              samples = reversed;
            }
            // The offline mixer uses the clip's timeline duration. Resample
            // the selected source window to that duration so rate edits and
            // reverse export stay synchronized with the rendered frames.
            if (rate !== 1) samples = resampleMonoSamples(samples, sampleRate, sampleRate / rate);
            return {
              clip,
              video,
              decoder,
              stillFrame,
              animatedFrameSource,
              audio: {
                samples,
                sampleRate,
                config: clipAudioConfig,
              },
            };
          }),
        );
        const mediaForClip = new Map(exportMedia.map((media) => [media.clip.id, media]));
        const audioSampleRate = exportMedia[0]?.audio.sampleRate ?? 48000;
        const offlineAudio = renderOfflineAudio(
          exportMedia.map((media) => ({
            clipId: media.clip.id,
            samples: resampleMonoSamples(
              media.audio.samples,
              media.audio.sampleRate,
              audioSampleRate,
            ),
            startUs: media.clip.startUs,
            config: exportAudioState.clips[media.clip.id] ?? {
              gain: 1,
              pan: 0,
              mute: false,
              solo: false,
            },
            effects: exportAudioState.effects
              .filter((effect) => effect.targetId === media.clip.id)
              .map((effect) => effect.effect),
          })),
          exportAudioState.buses,
          {
            sampleRate: audioSampleRate,
            channels: 1,
            startUs: 0,
            endUs: durationUs,
            automation: {
              clipAt: (clipId, timeUs, fallback) => {
                const clip = exportVisualProject.audio?.clips[clipId];
                return clip === undefined
                  ? fallback
                  : evaluateAudioClipAtTime(clip, clipId, exportVisualProject.propertyAnimations, {
                      compositionTimeUs: timeUs,
                      audioTimelineTimeUs: timeUs,
                    });
              },
              busAt: (busId, timeUs, fallback) => {
                const bus = exportVisualProject.audio?.buses.find(
                  (candidate) => candidate.id === busId,
                );
                return bus === undefined
                  ? fallback
                  : evaluateAudioBusAtTime(bus, exportVisualProject.propertyAnimations, {
                      compositionTimeUs: timeUs,
                      audioTimelineTimeUs: timeUs,
                    });
              },
            },
          },
        );
        const mixedAudio = offlineAudio.samples;
        const mixedAudioBuffer = createMonoAudioBuffer(audioContext, mixedAudio, audioSampleRate);
        const mixedChannel = mixedAudioBuffer.getChannelData(0);
        for (let i = 0; i < mixedAudio.length; i++) mixedChannel[i] = mixedAudio[i]!;
        const mixedAudioSource = audioContext.createBufferSource();
        activeMixedAudioSource = mixedAudioSource;
        mixedAudioSource.buffer = mixedAudioBuffer;
        mixedAudioSource.connect(audioDestination);
        const exportAudioTrack = audioDestination.stream.getAudioTracks()[0];
        if (exportAudioTrack === undefined)
          throw new Error('Export audio mix did not produce a track');
        activeExportAudioTrack = exportAudioTrack;
        const renderer = await createBrowserPixiRenderer({ width, height, resolution: 1 });
        activeRenderer = renderer;
        const recorderCanvas = document.createElement('canvas');
        recorderCanvas.width = width;
        recorderCanvas.height = height;
        const recorderContext = recorderCanvas.getContext('2d');
        if (recorderContext === null)
          throw new Error('Unable to create the deterministic export capture canvas');
        activeRecorderCanvas = recorderCanvas;
        const hasHtmlScenes = Object.values(exportVisualProject.visualObjects).some(
          (object) => object.kind === 'html-scene',
        );
        const sceneFrames = new Map<
          number,
          Map<string, { width: number; height: number; data: Uint8ClampedArray }>
        >();
        if (hasHtmlScenes) {
          setExportStatus('Capturing HTML scene frames…');
          const sceneCache = new HtmlSceneSurfaceCache();
          try {
            for (let index = 0; index < totalFrames; index++) {
              const timeUs = Math.min(durationUs - 1, Math.floor((index * 1_000_000) / frameRate));
              abortController.signal.throwIfAborted();
              await sceneCache.sync(exportVisualProject.visualObjects, timeUs);
              sceneFrames.set(index, new Map(sceneCache.bitmaps()));
              if (index % frameRate === 0)
                setExportStatus(`Capturing HTML scenes… ${index + 1}/${totalFrames}`);
            }
          } finally {
            sceneCache.destroy();
          }
        }
        await audioContext.resume();
        setExportStatus(`Encoding ${totalFrames} preview-equivalent H.264/AAC frames…`);
        const browserExportResult: BrowserExportResult = await downloadBrowserMp4({
          manifest,
          frameCount: totalFrames,
          canvas: recorderCanvas,
          audioTrack: exportAudioTrack,
          mimeType: selectedMimeType,
          onRecordingStart: () => {
            mixedAudioSource.start(0);
            mixedAudioStarted = true;
            for (const media of exportMedia) {
              if (media.video === undefined) continue;
              const startVideo = () => void media.video?.play();
              if (media.clip.startUs === 0) startVideo();
              else startTimers.push(window.setTimeout(startVideo, media.clip.startUs / 1_000));
            }
          },
          paintFrame: async (index) => {
            const timeUs = Math.min(durationUs - 1, Math.floor((index * 1_000_000) / frameRate));
            const transition = activeTransitionAt(exportVisualProject, timeUs);
            const activeClip = activePreparedExportClipAt(
              playableTimelineClips,
              timeUs,
              mediaForClip,
              (candidate) =>
                timelineElementKindForClip(candidate, exportElementKinds) === 'video' ? 0 : 1,
            );
            const clip =
              activeClip ??
              (transition !== undefined
                ? (() => {
                    const partner = findVideoClipById(exportTimelineProject, transition.leftClipId);
                    return partner !== undefined &&
                      hasRenderableExportMedia(mediaForClip.get(partner.id) ?? {})
                      ? partner
                      : undefined;
                  })()
                : undefined);
            const bitmaps = new Map<string, ImageDataLike>();
            const captureExportClip = async (target: VideoClip): Promise<VideoFrameNode> => {
              const media = mediaForClip.get(target.id);
              if (media === undefined)
                throw new Error(`Export media for ${target.id} was not prepared`);
              if (media.stillFrame !== undefined) {
                bitmaps.set(target.id, media.stillFrame);
                return videoFrameNodeFromDecoded(
                  videoClipSpecAt(
                    exportVisualProject,
                    exportTimelineProject,
                    target,
                    timeUs,
                    height,
                  ),
                  {
                    assetId: target.assetId,
                    bitmap: media.stillFrame,
                    sourceTimeUs: target.sourceInUs,
                    token: `still:${target.assetId}`,
                  },
                  { width: media.stillFrame.width, height: media.stillFrame.height },
                );
              }
              if (media.animatedFrameSource !== undefined) {
                const sourceTimeUs = sourceTimeForTransitionSample(target, timeUs, transition);
                const frame = media.animatedFrameSource.frameAt(sourceTimeUs - target.sourceInUs);
                bitmaps.set(target.id, frame.bitmap);
                return videoFrameNodeFromDecoded(
                  videoClipSpecAt(
                    exportVisualProject,
                    exportTimelineProject,
                    target,
                    timeUs,
                    height,
                  ),
                  {
                    assetId: target.assetId,
                    bitmap: frame.bitmap,
                    sourceTimeUs,
                    token: `animated:${target.assetId}:${frame.startUs}`,
                  },
                  {
                    width: media.animatedFrameSource.width,
                    height: media.animatedFrameSource.height,
                  },
                );
              }
              if (media.video === undefined || media.decoder === undefined)
                throw new Error(`Export media for ${target.id} was not prepared`);
              const sourceUs = sourceTimeForTransitionSample(target, timeUs, transition);
              setExportStatus('Seeking video…');
              await seekExportDetachedVideo(media.video, sourceUs, abortController.signal);
              const token = index + 1;
              const decoded = media.decoder.captureCurrentFrame(token);
              if (decoded.bitmap === undefined)
                throw new Error(
                  `Export media frame ${index} for ${target.assetId} is not drawable`,
                );
              bitmaps.set(target.id, decoded.bitmap);
              return videoFrameNodeFromDecoded(
                videoClipSpecAt(exportVisualProject, exportTimelineProject, target, timeUs, height),
                decoded,
                {
                  width: media.video.videoWidth,
                  height: media.video.videoHeight,
                },
              );
            };
            let node: VideoFrameNode | undefined;
            if (clip !== undefined && clip.kind === 'video') {
              node = await captureExportClip(clip);
            }
            if (transition !== undefined && node !== undefined) {
              for (const clipId of [transition.leftClipId, transition.rightClipId]) {
                if (bitmaps.has(clipId)) continue;
                const partner = findVideoClipById(exportTimelineProject, clipId);
                if (
                  partner !== undefined &&
                  hasRenderableExportMedia(mediaForClip.get(partner.id) ?? {})
                )
                  await captureExportClip(partner);
              }
            }
            const scenes = sceneFrames.get(index);
            if (scenes !== undefined) {
              for (const [id, bitmap] of scenes) bitmaps.set(id, bitmap);
            }
            for (const [id, bitmap] of stickerImageCache.bitmaps(timeUs)) bitmaps.set(id, bitmap);
            applyClipGradesToTransitionBitmaps(exportVisualProject, transition, timeUs, bitmaps);
            const frame = buildFrame(timeUs);
            renderer.render(node === undefined ? frame : withVideoFrameNode(frame, node), bitmaps);
            // CanvasCaptureMediaStreamTrack can sample a WebGL surface before
            // its GPU work is committed on cold/software renderers. Copying
            // into a 2D staging canvas synchronizes the exact painted frame.
            recorderContext.clearRect(0, 0, width, height);
            recorderContext.drawImage(renderer.canvas, 0, 0, width, height);
          },
          onProgress: (completed, total) => {
            setExportProgress(0.05 + 0.93 * (completed / total));
            if (completed === total || completed % frameRate === 0)
              setExportStatus(
                `Encoding preview-equivalent H.264/AAC… ${completed}/${total} frames`,
              );
          },
          filename: exportFilename,
          autoDownload: false,
          signal: abortController.signal,
        });
        if (browserExportResult.blob === undefined)
          throw new Error('Browser export did not produce a downloadable MP4');
        setExportStatus('Finalizing H.264/AAC export…');
        const remuxedBlob = await mediaControlPlaneClient.remuxBrowserMp4(
          controlPlaneProject.controlPlaneProjectId,
          browserExportResult.blob,
          frameRate,
          totalFrames,
          abortController.signal,
        );
        abortController.signal.throwIfAborted();
        if (
          session.projectRevisionId !== sourceProjectRevisionId ||
          session.historyCursorSequence !== sourceRevision
        )
          throw new Error('The project changed during export. Start a new export.');
        const exportResult: BrowserExportResult & { readonly blob: Blob } = {
          ...browserExportResult,
          blob: remuxedBlob,
          mimeType: remuxedBlob.type || 'video/mp4',
          totalBytes: remuxedBlob.size,
        };
        const durableBlob = await exportCachePromise.then((cache) =>
          cache.putVerified(entryId, exportResult.blob),
        );
        abortController.signal.throwIfAborted();
        const exportSha256 = await sha256Hex(new Uint8Array(await durableBlob.arrayBuffer()));
        abortController.signal.throwIfAborted();
        if (
          session.projectRevisionId !== sourceProjectRevisionId ||
          session.historyCursorSequence !== sourceRevision
        )
          throw new Error(
            'The project changed while the export was being finalized. Start a new export.',
          );
        pendingExportUrl = URL.createObjectURL(durableBlob);
        session.synchronizeVisualProject({
          ...session.visualProject,
          exportPreset: activeExportPreset,
          updatedAt: new Date().toISOString(),
        });
        recordExportEntry({
          id: entryId,
          projectId,
          filename: exportResult.filename,
          status: 'completed',
          cacheState: 'ready',
          startedAt,
          finishedAt: new Date().toISOString(),
          mimeType: exportResult.mimeType,
          totalBytes: exportResult.totalBytes,
          frameCount: exportResult.frameCount,
          sha256: exportSha256,
          fingerprint: exportFingerprint,
          revision: sourceRevision,
          presetId: activeExportPreset,
          manifest: retryManifest,
        });
        operationLedger.finish(entryId, 'completed', { resultRef: entryId });
        exportCompleted = true;
        const previousExport = lastExportRef.current;
        lastExportRef.current = { entryId, url: pendingExportUrl };
        pendingExportUrl = undefined;
        if (previousExport !== null && previousExport.url !== lastExportRef.current.url) {
          try {
            URL.revokeObjectURL(previousExport.url);
          } catch {
            // The committed export remains available even if releasing the old URL fails.
          }
        }
        void exportCachePromise
          .then((cache) => cache.prune(undefined, [entryId]))
          .catch(() => undefined);
        setExportProgress(1);
        try {
          triggerBrowserDownload(durableBlob, exportResult.filename);
          setExportStatus(undefined);
        } catch {
          setExportStatus('Export saved. Download it from Recent processes.');
        }
        exportToastTimerRef.current = window.setTimeout(() => {
          setExportProgress(undefined);
        }, 450);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cancelled =
          abortController.signal.aborted ||
          (error instanceof DOMException && error.name === 'AbortError');
        setExportStatus(
          cancelled
            ? 'Export cancelled. You can retry from Recent processes.'
            : `Export failed: ${message}`,
        );
        if (retryInputsAccepted && retryManifest !== undefined && exportFingerprint !== undefined)
          try {
            recordExportEntry({
              id: entryId,
              projectId,
              filename: exportFilename,
              status: cancelled ? 'interrupted-retryable' : 'failed',
              cacheState: 'none',
              startedAt,
              finishedAt: new Date().toISOString(),
              mimeType: selectedMimeType,
              error: cancelled ? 'cancelled by user' : message,
              fingerprint: exportFingerprint,
              revision: sourceRevision,
              presetId: activeExportPreset,
              manifest: retryManifest,
            });
          } catch {
            // Storage quota failures must not prevent partial-output cleanup.
          }
        if (operationStarted)
          try {
            operationLedger.finish(entryId, cancelled ? 'cancelled' : 'failed', {
              error: message,
            });
          } catch {
            // Preserve the original failure and continue releasing the new partial output.
          }
        setExportProgress(undefined);
        exportToastTimerRef.current = window.setTimeout(() => {
          setExportStatus(undefined);
        }, 8_000);
      } finally {
        for (const timer of startTimers) window.clearTimeout(timer);
        if (mixedAudioStarted)
          try {
            activeMixedAudioSource?.stop();
          } catch {
            // The owning AudioContext is closed below even if the source already ended.
          }
        for (const media of exportMediaCleanup) {
          try {
            media.video?.pause();
            media.video?.removeAttribute('src');
            media.video?.load();
            media.animated?.dispose();
          } catch {
            // Continue releasing renderer and audio resources.
          }
        }
        try {
          activeRenderer?.destroy();
        } catch {
          // Continue releasing audio and persisted partial output.
        }
        if (activeRecorderCanvas !== undefined) {
          activeRecorderCanvas.width = 0;
          activeRecorderCanvas.height = 0;
        }
        if (activeAudioContext !== undefined && activeAudioContext.state !== 'closed')
          await activeAudioContext.close().catch(() => undefined);
        activeExportAudioTrack?.stop();
        if (!exportCompleted) {
          if (pendingExportUrl !== undefined) {
            try {
              URL.revokeObjectURL(pendingExportUrl);
            } catch {
              // The new partial URL is never published as a re-download.
            }
            pendingExportUrl = undefined;
          }
          await exportCachePromise
            .then((cache) => cache.removeVerified(entryId))
            .catch(() => undefined);
        }
        if (exportAbortRef.current === abortController) exportAbortRef.current = null;
        exportInFlightRef.current = false;
        setExporting(false);
      }
    },
    [
      audioState,
      controlPlaneProject.controlPlaneProjectId,
      exportPreset,
      mediaResolver,
      operationLedger,
      projectId,
      recordExportEntry,
      session,
      syncStickerBitmaps,
    ],
  );
  const cancelExport = useCallback(() => {
    exportAbortRef.current?.abort();
  }, []);
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

      const mode = loadEditorUiPreferences(window.localStorage).viewMode;
      const preset = loadEditorUiPreferences(window.localStorage).workspacePreset;
      setViewMode(mode);
      setWorkspacePreset(preset);
      workspacePresetRef.current = preset;
      applyDockLayout(event.api, mode, preset);

      const persistDockLayout = () => {
        window.localStorage.setItem(
          dockLayoutKey(viewModeRef.current),
          serializeDockLayout(event.api.toJSON()),
        );
      };
      event.api.onDidLayoutChange(persistDockLayout);
    },
    [applyDockLayout],
  );

  function Panel({ api }: IDockviewPanelProps) {
    const context = useContext(EditorPanelContext);
    if (context === undefined) throw new Error('editor panel context is unavailable');
    const createHub = api.id === 'media';
    const enhanceHub = api.id === 'effects';
    const effectivePanelId = createHub
      ? context.createTool
      : enhanceHub
        ? context.enhanceTool
        : api.id;
    const withFeatureHub = (content: ReactNode): ReactNode => {
      if (createHub)
        return (
          <FeatureHub
            hub="create"
            activeTool={context.createTool}
            onToolChange={context.onCreateToolChange}
          >
            {content}
          </FeatureHub>
        );
      if (enhanceHub)
        return (
          <FeatureHub
            hub="enhance"
            activeTool={context.enhanceTool}
            onToolChange={context.onEnhanceToolChange}
          >
            {content}
          </FeatureHub>
        );
      return content;
    };
    const { state, visualProject, controlPlaneProject, updateVisualProperty } = context;
    const activeTimelineView =
      timelineCompositionView(context.timelineProject, context.activeTimelineCompositionId) ??
      timelineCompositionView(context.timelineProject, context.timelineProject.rootCompositionId);
    if (activeTimelineView === undefined)
      throw new Error('timeline root composition is unavailable');
    const activeTimelinePlayheadUs = timelineViewLocalTime(activeTimelineView, state.playheadUs);
    const activeTimelineDurationUs = timelineEffectiveDurationUs(activeTimelineView.composition);
    const activeTimelineMarkers = visualProject.markers
      .filter(
        (marker) =>
          marker.timeUs >= activeTimelineView.rootOffsetUs &&
          marker.timeUs <= activeTimelineView.rootOffsetUs + activeTimelineDurationUs,
      )
      .map((marker) => ({ ...marker, timeUs: marker.timeUs - activeTimelineView.rootOffsetUs }));
    const setActiveTimelineComposition = (compositionId: string) => {
      const nextView = timelineCompositionView(context.timelineProject, compositionId);
      if (nextView === undefined) return;
      context.onActiveTimelineCompositionChange(compositionId);
      const localTimeUs = state.playheadUs - nextView.rootOffsetUs;
      if (localTimeUs < 0 || localTimeUs > timelineEffectiveDurationUs(nextView.composition)) {
        context.seek(timelineViewRootTime(nextView, 0));
      }
    };
    const projectWithImportedAsset = (
      project: typeof context.visualProject,
      asset: {
        readonly id: string;
        readonly kind: 'video' | 'audio' | 'image';
        readonly displayName: string;
        readonly sha256?: string;
        readonly bytes?: number;
        readonly descriptor?: {
          readonly mimeType?: string;
          readonly durationUs?: number;
          readonly width?: number;
          readonly height?: number;
          readonly animation?: AnimationDescriptorV1;
        };
        readonly generationProvenance?: AssetRecordV1['generationProvenance'];
      },
    ) => ({
      ...project,
      assets: {
        ...project.assets,
        [asset.id]: {
          ...project.assets[asset.id],
          id: asset.id,
          kind: asset.kind,
          displayName: asset.displayName,
          ...(asset.sha256 === undefined ? {} : { sha256: asset.sha256 }),
          ...(asset.bytes === undefined ? {} : { bytes: asset.bytes }),
          ...(asset.descriptor === undefined
            ? {}
            : {
                descriptor: {
                  mimeType: asset.descriptor.mimeType ?? 'application/octet-stream',
                  ...(asset.descriptor.durationUs === undefined
                    ? {}
                    : { durationUs: asset.descriptor.durationUs }),
                  ...(asset.descriptor.width === undefined
                    ? {}
                    : { width: asset.descriptor.width }),
                  ...(asset.descriptor.height === undefined
                    ? {}
                    : { height: asset.descriptor.height }),
                  ...(asset.descriptor.animation === undefined
                    ? {}
                    : { animation: asset.descriptor.animation }),
                },
              }),
          ...(asset.generationProvenance === undefined
            ? {}
            : { generationProvenance: asset.generationProvenance }),
        },
      },
    });
    const rememberImportedAsset = (asset: {
      readonly id: string;
      readonly kind: 'video' | 'audio' | 'image';
      readonly displayName: string;
      readonly sha256?: string;
      readonly bytes?: number;
      readonly descriptor: {
        readonly mimeType: string;
        readonly durationUs?: number;
        readonly width?: number;
        readonly height?: number;
        readonly animation?: AnimationDescriptorV1;
      };
    }) => {
      context.replaceVisualProject(projectWithImportedAsset(context.visualProject, asset));
    };
    const applyMaskWorkerResult = async (
      job: BrowserJob,
      target: MaskTarget,
      settings: MaskSettings,
    ): Promise<string> => {
      if (job.state !== 'completed' || job.derivative === undefined)
        throw new Error('Mask result is not complete.');
      const derivatives = await mediaControlPlaneClient.derivatives(
        controlPlaneProject.controlPlaneProjectId,
        target.assetId,
      );
      const derivative =
        derivatives.find((candidate) => candidate.id === `derivative-${job.id}`) ??
        [...derivatives]
          .filter((candidate) => candidate.kind === 'mask')
          .sort((left, right) => right.verifiedAt - left.verifiedAt)[0];
      if (derivative === undefined) throw new Error('Verified mask derivative is unavailable.');
      const blob = await mediaControlPlaneClient.derivativeBytes(
        controlPlaneProject.controlPlaneProjectId,
        target.assetId,
        derivative.id,
      );
      const extension = derivative.descriptor.mimeType === 'video/webm' ? 'webm' : 'png';
      const file = new File([blob], `JOY Mask ${job.id.slice(-32)}.${extension}`, {
        type: derivative.descriptor.mimeType,
      });
      const expectedRevision = context.session.historyCursorSequence;
      const imported = await importMediaFile({
        projectId: controlPlaneProject.controlPlaneProjectId,
        projectTitle: controlPlaneProject.title,
        file,
        client: mediaControlPlaneClient,
        originalAssetCache: originalAssetCachePromise,
      });
      if (context.session.historyCursorSequence !== expectedRevision)
        throw new Error('The project changed while the mask result was being prepared.');
      let next = projectWithImportedAsset(context.session.visualProject, imported);
      next = writeMaskSettings(next, target.targetId, {
        ...settings,
        lastJob: {
          id: job.id,
          state: 'completed',
          progress: 100,
          resultAssetId: imported.id,
        },
      });
      if (target.kind === 'image') {
        if (target.objectId === undefined) throw new Error('Image mask target is unavailable.');
        next = writeImageMatte(next, target.objectId, imported.id);
      } else {
        if (target.clipId === undefined) throw new Error('Video mask target is unavailable.');
        next = writeVideoMaskSource(next, target.clipId, imported.id);
      }
      context.replaceVisualProject(next);
      context.showToast(
        target.kind === 'image'
          ? 'Mask applied to the selected image.'
          : 'Tracked alpha result linked to the selected video.',
        'success',
      );
      return imported.id;
    };
    const applyUpscaleWorkerResult = async (
      job: BrowserJob,
      target: UpscaleTarget,
      settings: UpscaleSettings,
    ): Promise<string> => {
      if (job.state !== 'completed' || job.derivative === undefined)
        throw new Error('Upscale result is not complete.');
      const derivatives = await mediaControlPlaneClient.derivatives(
        controlPlaneProject.controlPlaneProjectId,
        target.assetId,
      );
      const derivative =
        derivatives.find((candidate) => candidate.id === `derivative-${job.id}`) ??
        [...derivatives]
          .filter((candidate) => candidate.kind === 'upscale')
          .sort((left, right) => right.verifiedAt - left.verifiedAt)[0];
      if (derivative === undefined) throw new Error('Verified upscale derivative is unavailable.');
      const blob = await mediaControlPlaneClient.derivativeBytes(
        controlPlaneProject.controlPlaneProjectId,
        target.assetId,
        derivative.id,
      );
      const mimeType = derivative.descriptor.mimeType;
      const extension =
        mimeType === 'video/mp4'
          ? 'mp4'
          : mimeType === 'video/webm'
            ? 'webm'
            : mimeType === 'image/jpeg'
              ? 'jpg'
              : 'png';
      const file = new File([blob], `JOY Upscale ${job.id.slice(-32)}.${extension}`, {
        type: mimeType,
      });
      const expectedRevision = context.session.historyCursorSequence;
      const imported = await importMediaFile({
        projectId: controlPlaneProject.controlPlaneProjectId,
        projectTitle: controlPlaneProject.title,
        file,
        client: mediaControlPlaneClient,
        originalAssetCache: originalAssetCachePromise,
      });
      if (context.session.historyCursorSequence !== expectedRevision)
        throw new Error('The project changed while the upscale result was being prepared.');
      const next = writeUpscaleSettings(
        projectWithImportedAsset(context.session.visualProject, imported),
        target.targetId,
        {
          ...settings,
          lastJob: { id: job.id, state: 'completed', progress: 100, resultAssetId: imported.id },
        },
      );
      context.replaceVisualProject(next);
      context.showToast('Upscale result imported to Project Assets.', 'success');
      return imported.id;
    };
    const addAssetToTimeline = (asset: {
      readonly assetId: string;
      readonly kind: 'video' | 'audio' | 'image';
      readonly displayName: string;
      readonly descriptor: {
        readonly mimeType: string;
        readonly durationUs?: number;
        readonly width?: number;
        readonly height?: number;
        readonly animation?: AnimationDescriptorV1;
      };
    }) => {
      const composition =
        context.timelineProject.compositions[context.timelineProject.rootCompositionId];
      if (composition === undefined) return;
      const clipId = `${asset.kind === 'audio' ? 'voice' : 'clip'}-${asset.assetId}-${Date.now()}`;
      const controllerId = `media-controller-${clipId}`;
      context.replaceVisualProject(
        writeClipMediaKind(
          bindClipToObject(
            {
              ...projectWithImportedAsset(context.visualProject, {
                id: asset.assetId,
                kind: asset.kind,
                displayName: asset.displayName,
                descriptor: asset.descriptor,
              }),
              visualObjects: {
                ...context.visualProject.visualObjects,
                [controllerId]: {
                  id: controllerId,
                  kind: 'null',
                  assetId: asset.assetId,
                  transform: {
                    x: 0,
                    y: 0,
                    scaleX: 1,
                    scaleY: 1,
                    rotationDeg: 0,
                    opacity: 1,
                    crop: { left: 0, top: 0, right: 0, bottom: 0 },
                  },
                },
              },
            },
            clipId,
            controllerId,
          ),
          clipId,
          asset.kind,
        ),
      );
      context.dispatchTimeline(
        buildTimelineMediaImportTransaction(
          composition,
          [{ id: asset.assetId, ...asset }],
          state.playheadUs,
          new Set(),
          () => clipId,
        ),
      );
    };
    const bindMediaClip = (
      asset: {
        readonly id: string;
        readonly kind: 'video' | 'audio' | 'image';
        readonly displayName?: string;
        readonly sha256?: string;
        readonly bytes?: number;
        readonly descriptor?: {
          readonly mimeType?: string;
          readonly durationUs?: number;
          readonly width?: number;
          readonly height?: number;
          readonly animation?: AnimationDescriptorV1;
        };
      },
      clipId: string,
    ) => {
      const controllerId = `media-controller-${clipId}`;
      if (context.visualProject.visualObjects[controllerId] !== undefined) return;
      context.replaceVisualProject(
        bindClipToObject(
          {
            ...projectWithImportedAsset(context.visualProject, {
              id: asset.id,
              kind: asset.kind,
              displayName: asset.displayName ?? asset.id,
              ...(asset.sha256 === undefined ? {} : { sha256: asset.sha256 }),
              ...(asset.bytes === undefined ? {} : { bytes: asset.bytes }),
              ...(asset.descriptor === undefined ? {} : { descriptor: asset.descriptor }),
            }),
            visualObjects: {
              ...context.visualProject.visualObjects,
              [controllerId]: {
                id: controllerId,
                kind: 'null',
                assetId: asset.id,
                transform: {
                  x: 0,
                  y: 0,
                  scaleX: 1,
                  scaleY: 1,
                  rotationDeg: 0,
                  opacity: 1,
                  crop: { left: 0, top: 0, right: 0, bottom: 0 },
                },
              },
            },
          },
          clipId,
          controllerId,
        ),
      );
    };
    const applyWorkerAudioResult = async (
      result: VerifiedWorkerAudioResult,
      mode: 'replace' | 'keep',
    ): Promise<void> => {
      const existingGeneratedAsset = context.session.visualProject.assets[result.generatedAsset.id];
      if (existingGeneratedAsset !== undefined) {
        const provenance = existingGeneratedAsset.generationProvenance;
        const parameters = provenance?.parameters;
        const parameterRecord = recordValue(parameters);
        if (
          provenance?.providerId !== 'local-worker' ||
          parameterRecord?.jobId !== result.jobId ||
          parameterRecord?.derivativeId !== result.derivativeId
        )
          throw new Error('Generated asset ID collision with unrelated project media');
        context.showToast('This Worker result is already applied.', 'info');
        return;
      }
      const targetClipId = state.selectedIds[0];
      if (mode === 'replace' && targetClipId === undefined)
        throw new Error('Select a timeline clip before replacing audio');
      const expectedRevision = context.session.historyCursorSequence;
      const generated = result.generatedAsset;
      const cache = await originalAssetCachePromise;
      await cache.put(
        {
          assetId: generated.id,
          sha256: generated.sha256!,
          bytes: generated.bytes!,
          mimeType: generated.descriptor!.mimeType,
        },
        result.blob,
      );
      if (context.session.historyCursorSequence !== expectedRevision)
        throw new Error('The project changed while the Worker result was being prepared');
      const currentProject = context.session.visualProject;
      const currentAudio = loadAudioStateFromProject(
        window.localStorage,
        projectId,
        currentProject,
      );
      if (
        mode === 'replace' &&
        !Object.values(context.session.timelineProject.compositions)
          .flatMap((composition) => composition.tracks)
          .flatMap((track) => track.clips)
          .some((clip) => clip.id === targetClipId)
      )
        throw new Error('The selected clip no longer exists');
      const nextProject = projectWithImportedAsset(currentProject, {
        ...generated,
        kind: 'audio',
      });
      if (mode === 'replace') {
        const clipId = targetClipId!;
        const current = currentAudio.clips[clipId] ?? {
          gain: 1,
          pan: 0,
          mute: false,
          solo: false,
        };
        const nextAudio = {
          ...currentAudio,
          clips: {
            ...currentAudio.clips,
            [clipId]: { ...current, sourceAssetId: generated.id },
          },
        };
        context.replaceVisualProjectAndAudio(nextProject, nextAudio);
      } else {
        context.replaceVisualProject(nextProject);
      }
      context.showToast(
        mode === 'replace' ? 'Processed audio applied.' : 'Processed audio kept in the project.',
        'success',
      );
    };
    const selectedTimelineEntry = state.selectedIds
      .map((clipId) =>
        Object.values(context.timelineProject.compositions)
          .flatMap((composition) =>
            composition.tracks.map((track) => ({
              composition,
              track,
              clip: track.clips.find((candidate) => candidate.id === clipId),
            })),
          )
          .find((entry) => entry.clip !== undefined),
      )
      .find((entry) => entry !== undefined);
    const selectedTimelineVideo =
      selectedTimelineEntry?.clip?.kind === 'video'
        ? { ...selectedTimelineEntry, clip: selectedTimelineEntry.clip }
        : undefined;
    const timelineElementKinds = readTimelineElementKindMap(visualProject);
    const selectedElementKind =
      selectedTimelineEntry?.clip === undefined
        ? undefined
        : timelineElementKindForClip(selectedTimelineEntry.clip, timelineElementKinds);
    const treatmentTarget =
      selectedTimelineEntry?.clip !== undefined &&
      selectedElementKind !== undefined &&
      isAdjustmentTargetKind(selectedElementKind)
        ? selectedTimelineEntry
        : undefined;
    const changeSelectedClipSpeed = (change: InspectorSpeedChange, label: string) => {
      if (selectedTimelineVideo === undefined) return;
      const { composition, track, clip } = selectedTimelineVideo;
      try {
        if (Object.hasOwn(change, 'timeRemap')) {
          context.dispatchTimeline({
            label,
            commands: [
              {
                type: 'timeline.setTimeRemap',
                payload: {
                  compositionId: composition.id,
                  trackId: track.id,
                  clipId: clip.id,
                  ...(change.timeRemap === undefined ? {} : { timeRemap: change.timeRemap }),
                },
              },
            ],
          });
          context.showToast(label, 'success');
          return;
        }
        if (Object.hasOwn(change, 'ramp')) {
          if (change.ramp === undefined) {
            context.showToast('Undo the ramp to restore the original constant-speed clip.', 'info');
            return;
          }
          if (composition.id !== context.timelineProject.rootCompositionId) {
            context.showToast(
              'Speed ramps are unavailable inside a merged timeline because its parent timing is fixed.',
              'info',
            );
            return;
          }
          const result = buildSpeedRampTransaction({
            compositionId: composition.id,
            track,
            clip,
            preset: change.ramp,
          });
          const presentation = buildSpeedRampPresentation(
            context.visualProject,
            context.audioState,
            clip.id,
            result.segmentIds,
          );
          context.dispatchTimelineAndProjectAudio(
            result.transaction.label,
            result.transaction,
            presentation.project,
            presentation.audio,
          );
          context.selectClips([result.segmentIds[0]]);
          context.showToast(`${label}. The clip is now three editable speed segments.`, 'success');
          return;
        }
        if (change.rate === undefined) return;
        const requestedRate = Math.abs(change.rate);
        const currentRate = normalizePlaybackRate(clip.playbackRate);
        const requestedReverse = change.rate < 0;
        if (
          composition.id !== context.timelineProject.rootCompositionId &&
          requestedRate !== currentRate
        ) {
          context.showToast(
            'Constant speed changes are unavailable inside a merged timeline because its parent timing is fixed.',
            'info',
          );
          return;
        }
        const commands: CommandTransaction['commands'][number][] = [];
        if (requestedReverse !== (clip.reversed === true)) {
          commands.push({
            type: 'timeline.toggleClipReverse',
            payload: { compositionId: composition.id, trackId: track.id, clipId: clip.id },
          });
        }
        if (requestedRate !== currentRate) {
          commands.push({
            type: 'timeline.setClipRate',
            payload: {
              compositionId: composition.id,
              trackId: track.id,
              clipId: clip.id,
              playbackRate: requestedRate,
              preserveSourceRange: currentRate !== 0,
            },
          });
        }
        if (commands.length === 0) return;
        context.dispatchTimeline({ label, commands });
        context.showToast(
          requestedReverse !== (clip.reversed === true)
            ? `${label}. Program Monitor reverse preview is silent; export reverses audio.`
            : label,
          'success',
        );
      } catch (reason) {
        context.showToast(
          `Could not change clip speed: ${reason instanceof Error ? reason.message : String(reason)}`,
          'error',
        );
      }
    };
    if (api.id === 'inspector') {
      const objectId = resolveObjectIdForSelection(visualProject, state.selectedIds);
      const object = objectId === undefined ? undefined : visualProject.visualObjects[objectId];
      const selectedMaskAsset =
        selectedTimelineEntry?.clip?.kind === 'video'
          ? visualProject.assets[selectedTimelineEntry.clip.assetId]
          : undefined;
      const selectedTimelineObjectId =
        selectedTimelineEntry?.clip === undefined
          ? undefined
          : resolveObjectIdForSelection(visualProject, [selectedTimelineEntry.clip.id]);
      const selectedObjectAsset =
        object?.assetId === undefined ? undefined : visualProject.assets[object.assetId];
      const selectedClipMediaKind =
        selectedTimelineEntry?.clip === undefined
          ? undefined
          : readClipMediaKindMap(visualProject)[selectedTimelineEntry.clip.id];
      const selectedImageAssetId =
        selectedMaskAsset?.kind === 'image' && selectedTimelineEntry?.clip?.kind === 'video'
          ? selectedTimelineEntry?.clip?.assetId
          : selectedObjectAsset?.kind === 'image'
            ? object?.assetId
            : selectedClipMediaKind === 'image' && selectedTimelineEntry?.clip?.kind === 'video'
              ? selectedTimelineEntry.clip.assetId
              : undefined;
      const maskTarget: MaskTarget | undefined =
        object?.kind === 'image' && object.assetId !== undefined
          ? {
              targetId: object.id,
              objectId: object.id,
              assetId: object.assetId,
              kind: 'image',
              ...(selectedTimelineEntry?.clip === undefined
                ? {}
                : { clipId: selectedTimelineEntry.clip.id }),
            }
          : selectedTimelineEntry?.clip?.kind === 'video' && selectedImageAssetId !== undefined
            ? {
                targetId: selectedTimelineObjectId ?? selectedTimelineEntry.clip.id,
                ...(selectedTimelineObjectId === undefined
                  ? {}
                  : { objectId: selectedTimelineObjectId }),
                clipId: selectedTimelineEntry.clip.id,
                assetId: selectedImageAssetId,
                kind: 'image',
              }
            : selectedTimelineEntry?.clip?.kind === 'video' && selectedMaskAsset?.kind === 'video'
              ? {
                  targetId: selectedTimelineEntry.clip.id,
                  clipId: selectedTimelineEntry.clip.id,
                  assetId: selectedTimelineEntry.clip.assetId,
                  kind: 'video',
                  durationUs: selectedTimelineEntry.clip.durationUs,
                  playheadUs: state.playheadUs,
                }
              : undefined;
      const upscaleTarget: UpscaleTarget | undefined =
        object?.kind === 'image' && object.assetId !== undefined
          ? { targetId: object.id, objectId: object.id, assetId: object.assetId, kind: 'image' }
          : selectedTimelineEntry?.clip?.kind === 'video' && selectedImageAssetId !== undefined
            ? {
                targetId: selectedTimelineObjectId ?? object?.id ?? selectedTimelineEntry.clip.id,
                ...(selectedTimelineObjectId === undefined && object?.id === undefined
                  ? {}
                  : { objectId: selectedTimelineObjectId ?? object!.id }),
                clipId: selectedTimelineEntry.clip.id,
                assetId: selectedImageAssetId,
                kind: 'image',
              }
            : selectedTimelineEntry?.clip?.kind === 'video' && selectedMaskAsset?.kind === 'video'
              ? {
                  targetId: selectedTimelineEntry.clip.id,
                  clipId: selectedTimelineEntry.clip.id,
                  assetId: selectedTimelineEntry.clip.assetId,
                  kind: 'video',
                  durationUs: selectedTimelineEntry.clip.durationUs,
                  playheadUs: state.playheadUs,
                }
              : undefined;
      const rootComposition =
        context.timelineProject.compositions[context.timelineProject.rootCompositionId];
      const adjustmentTargets =
        rootComposition?.tracks.flatMap((track) =>
          track.clips.flatMap((clip) => {
            const kind = timelineElementKindForClip(clip, timelineElementKinds);
            if (!isAdjustmentTargetKind(kind)) return [];
            const asset = clip.kind === 'video' ? visualProject.assets[clip.assetId] : undefined;
            const targetObjectId = resolveObjectIdForSelection(visualProject, [clip.id]);
            const targetObject =
              targetObjectId === undefined
                ? undefined
                : visualProject.visualObjects[targetObjectId];
            return [
              {
                clipId: clip.id,
                label: asset?.displayName ?? clip.id,
                kind:
                  kind === 'overlay' || asset?.kind === 'image' || targetObject?.kind === 'image'
                    ? ('picture' as const)
                    : ('video' as const),
              },
            ];
          }),
        ) ?? [];
      const adjustmentTargetId =
        objectId === undefined ? undefined : readEffectLayerTargetMap(visualProject)[objectId];
      return (
        <InspectorPanel
          object={object}
          {...(state.selectedIds[0] !== undefined ? { selectedClipId: state.selectedIds[0] } : {})}
          selectedKind={
            selectedElementKind === undefined
              ? object?.kind
              : selectedElementKind.charAt(0).toUpperCase() + selectedElementKind.slice(1)
          }
          selectedName={
            selectedTimelineEntry?.clip?.kind === 'video'
              ? (visualProject.assets[selectedTimelineEntry.clip.assetId]?.displayName ??
                selectedTimelineEntry.clip.id)
              : selectedTimelineEntry?.clip?.id
          }
          selectedTrackName={selectedTimelineEntry?.track.id}
          selectedSourceDurationUs={
            selectedTimelineEntry?.clip?.kind === 'video'
              ? visualProject.assets[selectedTimelineEntry.clip.assetId]?.descriptor?.durationUs
              : undefined
          }
          selectedTimelineDurationUs={selectedTimelineEntry?.clip?.durationUs}
          {...(selectedTimelineVideo === undefined
            ? {}
            : {
                clipSpeed: {
                  rate:
                    (selectedTimelineVideo.clip.reversed === true ? -1 : 1) *
                    normalizePlaybackRate(selectedTimelineVideo.clip.playbackRate),
                  supportsReverse:
                    normalizePlaybackRate(selectedTimelineVideo.clip.playbackRate) !== 0,
                  supportsRamps:
                    selectedTimelineVideo.clip.reversed !== true &&
                    normalizePlaybackRate(selectedTimelineVideo.clip.playbackRate) * 0.75 >= 0.1 &&
                    normalizePlaybackRate(selectedTimelineVideo.clip.playbackRate) * 2 <= 8,
                  timeRemap: selectedTimelineVideo.clip.timeRemap,
                  durationUs: selectedTimelineVideo.clip.durationUs,
                  sourceInUs: selectedTimelineVideo.clip.sourceInUs,
                },
                onSpeedChange: changeSelectedClipSpeed,
              })}
          allObjects={visualProject.visualObjects}
          playheadUs={state.playheadUs}
          project={visualProject}
          {...(maskTarget === undefined
            ? {}
            : {
                maskTarget,
                maskProjectId: controlPlaneProject.controlPlaneProjectId,
                maskProjectTitle: controlPlaneProject.title,
                onMaskSettingsChange: (next: MaskSettings) =>
                  context.replaceVisualProject(
                    writeMaskSettings(context.visualProject, maskTarget.targetId, next),
                  ),
                onApplyMaskResult: (job: BrowserJob, settings: MaskSettings) =>
                  applyMaskWorkerResult(job, maskTarget, settings),
                onClearMask: () => {
                  const current = readMaskSettings(
                    context.visualProject,
                    maskTarget.targetId,
                    maskTarget.kind,
                  );
                  const { lastJob, ...withoutJob } = current;
                  void lastJob;
                  let next = writeMaskSettings(
                    context.visualProject,
                    maskTarget.targetId,
                    withoutJob,
                  );
                  if (maskTarget.kind === 'image' && maskTarget.objectId !== undefined)
                    next = clearImageMatte(next, maskTarget.objectId);
                  if (maskTarget.kind === 'video' && maskTarget.clipId !== undefined)
                    next = writeVideoMaskSource(next, maskTarget.clipId, undefined);
                  context.replaceVisualProject(next);
                  context.showToast('Mask cleared.', 'success');
                },
              })}
          {...(upscaleTarget === undefined
            ? {}
            : {
                upscaleTarget,
                upscaleProjectId: controlPlaneProject.controlPlaneProjectId,
                upscaleProjectTitle: controlPlaneProject.title,
                onUpscaleSettingsChange: (next: UpscaleSettings) =>
                  context.replaceVisualProject(
                    writeUpscaleSettings(context.visualProject, upscaleTarget.targetId, next),
                  ),
                onApplyUpscaleResult: (job: BrowserJob, settings: UpscaleSettings) =>
                  applyUpscaleWorkerResult(job, upscaleTarget, settings),
              })}
          audioState={context.audioState}
          onAudioChange={(next) => context.setAudioState(next)}
          onSetStatic={updateVisualProperty}
          onDispatch={context.dispatchProject}
          {...(selectedElementKind === 'adjust'
            ? {
                adjustmentLayer: {
                  ...(adjustmentTargetId === undefined ? {} : { targetClipId: adjustmentTargetId }),
                  targets: adjustmentTargets,
                },
                onAdjustmentTargetChange: (targetClipId: string) => {
                  if (objectId === undefined) return;
                  context.replaceVisualProject(
                    withEffectLayerTarget(visualProject, objectId, targetClipId),
                  );
                },
              }
            : {})}
          {...(selectedElementKind !== undefined &&
          isAdjustmentTargetKind(selectedElementKind) &&
          selectedTimelineEntry?.clip !== undefined
            ? {
                onCreateAdjustmentLayer: () =>
                  context.addAdjustmentLayer(selectedTimelineEntry.clip!.id),
              }
            : {})}
          onOpenAnimationGraph={context.openAnimationGraph}
        />
      );
    }
    if (effectivePanelId === 'motion') {
      const objectId = resolveObjectIdForSelection(visualProject, state.selectedIds);
      const object = objectId === undefined ? undefined : visualProject.visualObjects[objectId];
      const motionTimelineComposition =
        context.timelineProject.compositions[context.timelineProject.rootCompositionId];
      return withFeatureHub(
        <MotionPanel
          object={object}
          allObjects={visualProject.visualObjects}
          compositionDurationUs={
            motionTimelineComposition === undefined
              ? 30_000_000
              : timelineEffectiveDurationUs(motionTimelineComposition)
          }
          playheadUs={state.playheadUs}
          onSeek={context.seek}
          onDispatch={context.dispatchProject}
          {...(state.selectedIds[0] !== undefined ? { selectedClipId: state.selectedIds[0] } : {})}
          onAddHtmlSceneToSelection={context.addHtmlSceneToSelectedClip}
        />,
      );
    }
    if (api.id === 'camera') {
      const composition = visualProject.compositions[visualProject.rootCompositionId];
      if (composition === undefined) return <p>Main composition is missing.</p>;
      return (
        <CameraPanel
          allObjects={visualProject.visualObjects}
          composition={composition}
          project={visualProject}
          playheadUs={state.playheadUs}
          onDispatch={context.dispatchProject}
        />
      );
    }
    if (effectivePanelId === 'audio') {
      const audioComposition =
        context.timelineProject.compositions[context.timelineProject.rootCompositionId];
      const audioTracks = audioComposition?.tracks ?? [];
      const audioClips = audioTracks.flatMap((track) => track.clips);
      const clipIds = audioClips.map((clip) => clip.id);
      const selectedClipIds = audioClips
        .filter((clip) => state.selectedIds.includes(clip.id))
        .map((clip) => clip.id);
      const selectedTrack = audioTracks.find((track) =>
        track.clips.some((clip) => state.selectedIds.includes(clip.id)),
      );
      const enhanceScopes: readonly AudioEnhanceScopeOption[] = [
        {
          id: 'selection',
          label: 'Selected',
          description:
            selectedClipIds.length === 0
              ? 'Select timeline clips to target them directly.'
              : `${selectedClipIds.length} selected clip${selectedClipIds.length === 1 ? '' : 's'}`,
          clipIds: selectedClipIds,
        },
        {
          id: 'track',
          label: 'Track',
          description:
            selectedTrack === undefined
              ? 'Select a timeline clip to target its track.'
              : `${selectedTrack.clips.length} clip${selectedTrack.clips.length === 1 ? '' : 's'} on ${selectedTrack.id}`,
          clipIds: selectedTrack?.clips.map((clip) => clip.id) ?? [],
        },
        {
          id: 'timeline',
          label: 'Timeline',
          description: `${clipIds.length} timeline clip${clipIds.length === 1 ? '' : 's'}`,
          clipIds,
        },
      ];
      const selectedAudioClip =
        audioClips.find(
          (clip): clip is VideoClip => clip.kind === 'video' && state.selectedIds.includes(clip.id),
        ) ?? audioClips.find((clip): clip is VideoClip => clip.kind === 'video');
      return withFeatureHub(
        <AudioPanel
          clipIds={clipIds}
          enhanceScopes={enhanceScopes}
          audioState={context.audioState}
          onAudioChange={(next, label) => context.setAudioState(next, label)}
          project={visualProject}
          playheadUs={state.playheadUs}
          onDispatch={context.dispatchProject}
          onRunBrowserDsp={(workflowId, targetClipIds) => {
            if (targetClipIds.length === 0)
              throw new Error('Select timeline clips before applying Browser DSP.');
            const effectKinds = [
              {
                kind: 'eq' as const,
                bands: [
                  { frequency: 120, gain: -2, q: 0.7, type: 'highpass' as const },
                  { frequency: 3_000, gain: 2, q: 0.8, type: 'peaking' as const },
                ],
              },
              {
                kind: 'compressor' as const,
                threshold: -18,
                ratio: 3,
                attackUs: 10_000,
                releaseUs: 120_000,
                knee: 6,
              },
              { kind: 'limiter' as const, ceiling: -1, releaseUs: 80_000 },
            ];
            const nextEffects = targetClipIds.flatMap((clipId) =>
              effectKinds.map((effect, index) => ({
                id: `browser-polish-${workflowId}-${clipId}-${index}`,
                targetId: clipId,
                effect,
              })),
            );
            context.setAudioState(
              {
                ...context.audioState,
                effects: nextEffects,
              },
              `Run ${workflowId} with Browser DSP`,
            );
            context.showToast(
              `Browser Voice Polish applied to ${targetClipIds.length} clip${targetClipIds.length === 1 ? '' : 's'}.`,
              'success',
            );
          }}
          onRunLocalWorker={async (workflowId) => {
            if (selectedAudioClip === undefined)
              throw new Error('Place a video or audio clip before running Local Worker.');
            const operationId = workerAudioDenoiseOperationId(
              controlPlaneProject.controlPlaneProjectId,
              selectedAudioClip.assetId,
            );
            const existing = operationLedger.get(operationId);
            if (
              existing?.status === 'running' ||
              existing?.status === 'review' ||
              existing?.status === 'applied' ||
              existing?.status === 'completed'
            ) {
              context.showToast('This Local Worker operation is already in Jobs.', 'info');
              context.activatePanel('jobs');
              return;
            }
            operationLedger.begin({
              id: operationId,
              type: 'worker-job',
              fingerprint: `${selectedAudioClip.assetId}:audio.ml-denoise:v1`,
              revision: context.session.historyCursorSequence,
            });
            try {
              await mediaControlPlaneClient.ensureProject(
                controlPlaneProject.controlPlaneProjectId,
                controlPlaneProject.title,
              );
              // A Worker fetches its source through the control plane, not from
              // this tab's OPFS cache. A browser reload can restore the visual
              // project before an ephemeral/dev catalog has restored its asset
              // row, so repair that durable source boundary before queueing.
              const catalogAssets = await mediaControlPlaneClient.assets(
                controlPlaneProject.controlPlaneProjectId,
              );
              const catalogAsset = catalogAssets.find(
                (asset) => asset.id === selectedAudioClip.assetId,
              );
              if (catalogAsset?.cloudBacked !== true) {
                const sourceAsset = context.session.visualProject.assets[selectedAudioClip.assetId];
                if (sourceAsset === undefined)
                  throw new Error('The selected audio source is no longer part of this project.');
                let original = await (
                  await originalAssetCachePromise
                ).get(selectedAudioClip.assetId);
                if (original === undefined) {
                  const source = await mediaResolver.resolve(selectedAudioClip.assetId);
                  const response = await fetch(source.url);
                  if (!response.ok)
                    throw new Error('The selected audio original is unavailable for Local Worker.');
                  original = await response.blob();
                }
                if (catalogAsset !== undefined) {
                  await mediaControlPlaneClient.uploadAssetOriginal(
                    controlPlaneProject.controlPlaneProjectId,
                    catalogAsset,
                    original,
                  );
                } else {
                  const file = new File([original], sourceAsset.displayName, {
                    type: sourceAsset.descriptor?.mimeType || original.type,
                  });
                  await importMediaFile({
                    projectId: controlPlaneProject.controlPlaneProjectId,
                    projectTitle: controlPlaneProject.title,
                    file,
                    assetId: selectedAudioClip.assetId,
                    client: mediaControlPlaneClient,
                    originalAssetCache: originalAssetCachePromise,
                  });
                }
              }
              if (existing?.status === 'failed' || existing?.status === 'cancelled')
                await mediaControlPlaneClient.retry(
                  controlPlaneProject.controlPlaneProjectId,
                  operationId,
                );
              else
                await mediaControlPlaneClient.enqueueWorkerGeneration(
                  controlPlaneProject.controlPlaneProjectId,
                  operationId,
                  'audio.ml-denoise',
                  selectedAudioClip.assetId,
                );
              context.showToast(`Local Worker ${workflowId} queued in Jobs.`, 'success');
              context.activatePanel('jobs');
            } catch (error) {
              operationLedger.finish(operationId, 'failed', {
                error: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
          }}
          onRunCloudBrain={async (workflowId) => {
            if (selectedAudioClip === undefined)
              throw new Error('Place a video or audio clip before running Cloud Brain.');
            const targetClipId = selectedAudioClip.id;
            const targetAssetId = selectedAudioClip.assetId;
            const sourceProjectRevisionId = context.session.projectRevisionId;
            const sourceRevision = context.session.historyCursorSequence;
            const sourceAsset = context.session.visualProject.assets[targetAssetId];
            const source = await mediaResolver.resolve(targetAssetId);
            const response = await fetch(source.url);
            if (!response.ok) throw new Error('Cloud Brain could not read the selected media.');
            const sourceBlob = await response.blob();
            const sourceSha256 =
              sourceAsset?.sha256 ??
              (await sha256Hex(new Uint8Array(await sourceBlob.arrayBuffer())));
            const operationId = `cloud-audio-${targetAssetId}-${workflowId}`;
            const fingerprint = `${sourceSha256}:${workflowId}:afftdn:0.8`;
            const existing = operationLedger.get(operationId);
            if (existing?.status === 'applied' || existing?.status === 'completed') {
              context.showToast('This Cloud Brain result is already applied.', 'info');
              return;
            }
            if (existing === undefined)
              operationLedger.begin({
                id: operationId,
                type: 'cloud-audio',
                fingerprint,
                revision: sourceRevision,
              });
            try {
              await mediaControlPlaneClient.ensureProject(
                controlPlaneProject.controlPlaneProjectId,
                controlPlaneProject.title,
              );
              let recovered:
                | Awaited<ReturnType<typeof mediaControlPlaneClient.denoiseAudioOperation>>
                | undefined;
              if (existing !== undefined) {
                recovered = await mediaControlPlaneClient.denoiseAudioOperation(
                  controlPlaneProject.controlPlaneProjectId,
                  operationId,
                );
                if (recovered === undefined) {
                  // A 429 before the durable server claim is safe to retry: the
                  // authoritative recovery lookup proves no provider run exists.
                  operationLedger.begin({
                    id: operationId,
                    type: 'cloud-audio',
                    fingerprint,
                    revision: sourceRevision,
                  });
                }
              }
              if (
                recovered?.status === 'running' &&
                recovered.leaseExpiresAt !== undefined &&
                recovered.leaseExpiresAt > Date.now()
              ) {
                context.showToast(
                  'This Cloud Brain operation is still running. Try recovery again shortly.',
                  'info',
                );
                return;
              }
              if (recovered?.status === 'running' || recovered?.status === 'failed')
                operationLedger.begin({
                  id: operationId,
                  type: 'cloud-audio',
                  fingerprint,
                  revision: sourceRevision,
                });
              const result =
                recovered?.result ??
                (await mediaControlPlaneClient.denoiseAudio({
                  projectId: controlPlaneProject.controlPlaneProjectId,
                  operationId,
                  assetId: targetAssetId,
                  media: sourceBlob,
                  strength: 0.8,
                }));
              const generatedBytes = bytesFromBase64(result.bytesBase64);
              const generatedBlob = new Blob([generatedBytes.buffer as ArrayBuffer], {
                type: result.mimeType,
              });
              const generatedSha256 = await sha256Hex(generatedBytes);
              const generatedAsset: AssetRecordV1 = {
                id: result.assetId,
                kind: 'audio',
                displayName: `Cloud denoise · ${sourceAsset?.displayName ?? targetAssetId}`,
                sha256: generatedSha256,
                bytes: generatedBlob.size,
                descriptor: { mimeType: result.mimeType },
                generationProvenance: {
                  providerId: 'joy.cloud-brain',
                  modelId: result.method,
                  modelVersion: 'v1',
                  prompt: workflowId,
                  inputAssetHashes: [sourceSha256],
                  parameters: { strength: result.strength },
                  generatedAssetId: result.assetId,
                  createdAt: new Date().toISOString(),
                },
              };
              await (
                await originalAssetCachePromise
              ).put(
                {
                  assetId: generatedAsset.id,
                  sha256: generatedSha256,
                  bytes: generatedBlob.size,
                  mimeType: result.mimeType,
                },
                generatedBlob,
              );
              if (
                context.session.projectRevisionId !== sourceProjectRevisionId ||
                context.session.historyCursorSequence !== sourceRevision
              )
                throw new Error(
                  'The project changed while Cloud Brain was running. The result was not applied.',
                );
              const currentTimeline =
                context.session.timelineProject.compositions[
                  context.session.timelineProject.rootCompositionId
                ];
              const currentTarget = currentTimeline?.tracks
                .flatMap((track) => track.clips)
                .find(
                  (clip): clip is VideoClip => clip.id === targetClipId && clip.kind === 'video',
                );
              if (currentTarget?.assetId !== targetAssetId)
                throw new Error(
                  'The target clip changed while Cloud Brain was running. The result was not applied.',
                );
              const currentProject = context.session.visualProject;
              const collision = currentProject.assets[generatedAsset.id];
              if (collision !== undefined && collision.sha256 !== generatedAsset.sha256)
                throw new Error(
                  'Cloud Brain returned an asset ID already used by different media.',
                );
              const nextProject = projectWithImportedAsset(currentProject, {
                ...generatedAsset,
                kind: 'audio',
              });
              const currentAudioState = loadAudioStateFromProject(
                window.localStorage,
                projectId,
                currentProject,
              );
              const currentClipAudio = currentAudioState.clips[targetClipId] ?? {
                gain: 1,
                pan: 0,
                mute: false,
                solo: false,
              };
              context.replaceVisualProjectAndAudio(nextProject, {
                ...currentAudioState,
                clips: {
                  ...currentAudioState.clips,
                  [targetClipId]: {
                    ...currentClipAudio,
                    sourceAssetId: generatedAsset.id,
                  },
                },
              });
              operationLedger.finish(operationId, 'applied', { resultRef: generatedAsset.id });
              context.showToast('Cloud Brain audio applied to the selected clip.', 'success');
            } catch (error) {
              operationLedger.finish(operationId, 'failed', {
                error: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
          }}
        />,
      );
    }
    if (effectivePanelId === 'effects') {
      const objectId = resolveObjectIdForSelection(visualProject, state.selectedIds);
      const canApplyEffects =
        objectId !== undefined &&
        isSingleVideoClipSelected(context.timelineProject, state.selectedIds);
      return withFeatureHub(
        <EffectsPanel
          project={visualProject}
          objectId={objectId}
          canApplyEffects={canApplyEffects}
          {...(treatmentTarget === undefined
            ? {}
            : {
                onCreateEffectLayer: () =>
                  context.addTreatmentLayer('effect', treatmentTarget.clip!.id),
              })}
          onDispatch={(command) => {
            context.dispatchProject({
              label: `Effect: ${(command.payload as { effectId: string }).effectId}`,
              commands: [command],
            } as unknown as VisualObjectTransaction);
          }}
          showToast={context.showToast}
        />,
      );
    }
    if (effectivePanelId === 'transitions') {
      return withFeatureHub(
        <TransitionsPanel
          project={visualProject}
          timelineProject={context.timelineProject}
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
          playheadUs={state.playheadUs}
          onDispatch={context.dispatchProject}
          showToast={context.showToast}
        />,
      );
    }
    if (effectivePanelId === 'filters')
      return withFeatureHub(
        <FiltersPanel
          canCreate={treatmentTarget?.clip !== undefined}
          {...(treatmentTarget?.clip === undefined
            ? {}
            : {
                targetLabel:
                  treatmentTarget.clip.kind === 'video'
                    ? (visualProject.assets[treatmentTarget.clip.assetId]?.displayName ??
                      treatmentTarget.clip.id)
                    : treatmentTarget.clip.id,
                onCreateFilterLayer: () =>
                  context.addTreatmentLayer('filter', treatmentTarget.clip!.id),
              })}
          onAddFilter={(effectId, params) => {
            if (treatmentTarget?.clip === undefined) return;
            context.addTreatmentLayer('filter', treatmentTarget.clip.id, { effectId, params });
          }}
        />,
      );
    if (effectivePanelId === 'adjust')
      return withFeatureHub(
        <AdjustmentLayersPanel
          canCreate={treatmentTarget?.clip !== undefined}
          {...(treatmentTarget?.clip === undefined
            ? {}
            : {
                targetLabel:
                  treatmentTarget.clip.kind === 'video'
                    ? (visualProject.assets[treatmentTarget.clip.assetId]?.displayName ??
                      treatmentTarget.clip.id)
                    : treatmentTarget.clip.id,
              })}
          onCreate={() => {
            if (treatmentTarget?.clip !== undefined)
              context.addTreatmentLayer('adjust', treatmentTarget.clip.id);
          }}
        />,
      );
    if (effectivePanelId === 'color')
      return withFeatureHub(
        <ColorPanel
          project={visualProject}
          onChange={context.replaceVisualProject}
          onDispatch={context.dispatchProject}
          {...(selectedTimelineVideo === undefined
            ? {}
            : {
                selectedClipId: selectedTimelineVideo.clip.id,
                selectedClipName:
                  visualProject.assets[selectedTimelineVideo.clip.assetId]?.displayName ??
                  selectedTimelineVideo.clip.id,
                selectedClipStartUs: selectedTimelineVideo.clip.startUs,
                selectedClipDurationUs: selectedTimelineVideo.clip.durationUs,
              })}
          playheadUs={state.playheadUs}
        />,
      );
    if (effectivePanelId === 'captions')
      return withFeatureHub(
        <CaptionsPanel
          project={visualProject}
          playheadUs={state.playheadUs}
          onSeek={context.seek}
          onDispatch={context.dispatchProject}
          onTranscribe={context.transcribe}
          transcriptionError={context.transcriptionError}
          onProjectChange={(next) => context.replaceVisualProject(next)}
          onCreateCaptionTrack={context.addCaptionLayer}
        />,
      );
    if (effectivePanelId === 'text')
      return withFeatureHub(
        <TextPanel
          project={visualProject}
          session={context.session}
          selectedIds={state.selectedIds}
          playheadUs={state.playheadUs}
          onSelectClip={context.selectClips}
          onProjectChange={context.replaceVisualProject}
          onProjectRevision={context.bumpProjectRevision}
        />,
      );
    if (api.id === 'timeline') {
      const selectedObjectId = resolveObjectIdForSelection(visualProject, state.selectedIds);
      const selectedObject =
        selectedObjectId === undefined ? undefined : visualProject.visualObjects[selectedObjectId];
      return (
        <TimelinePanel
          project={context.timelineProject}
          elementKinds={timelineElementKinds}
          transitions={visualProject.transitions ?? []}
          trackLabelColors={Object.fromEntries(
            (visualProject.timelineTrackDeck?.rows ?? [])
              .filter((row) => row.compositionId === activeTimelineView.composition.id)
              .map((row) => [row.trackId, row.labelColor]),
          )}
          activeCompositionId={activeTimelineView.composition.id}
          onActiveCompositionChange={setActiveTimelineComposition}
          playheadUs={activeTimelinePlayheadUs}
          playing={state.playing}
          selectedIds={state.selectedIds}
          viewport={context.timelineViewport}
          onViewportChange={context.onTimelineViewportChange}
          trackFlags={context.timelineTrackFlags}
          onTrackFlagsChange={context.onTimelineTrackFlagsChange}
          autoFit={context.timelineAutoFit}
          onAutoFitChange={context.onTimelineAutoFitChange}
          markers={activeTimelineMarkers}
          onRevealInFlow={context.revealInFlow}
          {...(context.dataLanes === undefined || context.artifacts === undefined
            ? {}
            : {
                dataLanes: context.dataLanes,
                artifacts: context.artifacts,
                onDispatchArtifacts: context.dispatchArtifacts,
              })}
          onOpenAssetLibrary={() => context.activatePanel('media')}
          onImportMedia={async (file) => {
            const asset = await importMediaFile({
              projectId: controlPlaneProject.controlPlaneProjectId,
              projectTitle: controlPlaneProject.title,
              file,
              client: mediaControlPlaneClient,
              originalAssetCache: originalAssetCachePromise,
            });
            rememberImportedAsset(asset);
            return asset;
          }}
          assetDisplayNames={Object.fromEntries(
            Object.values(visualProject.assets).map((asset) => [asset.id, asset.displayName]),
          )}
          onImportFiles={(files) => {
            for (const file of files) {
              void importMediaFile({
                projectId: controlPlaneProject.controlPlaneProjectId,
                projectTitle: controlPlaneProject.title,
                file,
                client: mediaControlPlaneClient,
                originalAssetCache: originalAssetCachePromise,
              })
                .then((asset) => {
                  rememberImportedAsset(asset);
                  const composition = activeTimelineView.composition;
                  if (composition !== undefined) {
                    const clipId = `${asset.kind === 'audio' ? 'voice' : 'clip'}-${asset.id}-${Date.now()}`;
                    bindMediaClip(asset, clipId);
                    context.dispatchTimeline(
                      buildTimelineMediaImportTransaction(
                        composition,
                        [asset],
                        activeTimelinePlayheadUs,
                        new Set(),
                        () => clipId,
                      ),
                    );
                  }
                  context.showToast(`${file.name} added to the timeline.`, 'success');
                })
                .catch((error) => {
                  context.showToast(
                    `Failed to import ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
                    'error',
                  );
                });
            }
          }}
          onMediaPlaced={(asset, clipId) => bindMediaClip(asset, clipId)}
          onTogglePlayback={context.togglePlayback}
          onSeek={(timeUs) => context.seek(timelineViewRootTime(activeTimelineView, timeUs))}
          onSelectClips={context.selectClips}
          onToggleSelection={context.toggleSelection}
          onClearSelection={context.clearSelection}
          onDispatch={context.dispatchTimeline}
          {...(selectedObject === undefined
            ? {}
            : { selectedObject, onPropertyDispatch: context.dispatchProject })}
          onAddMarker={(timeUs, label) =>
            context.dispatchProject({
              label: `Add ${label}`,
              commands: [
                {
                  type: 'marker.add',
                  payload: {
                    marker: {
                      id: `marker-${timeUs}`,
                      timeUs: timelineViewRootTime(activeTimelineView, timeUs),
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
          onEffectDrop={(effectId, clipId, _trackId) => {
            context.selectClips([clipId]);
            const objectId = resolveObjectIdForSelection(visualProject, [clipId]);
            if (!objectId) {
              context.showToast("Could not find this clip's target.", 'error');
              return;
            }
            const descriptor = effectRegistry.getEffect(effectId);
            if (!descriptor) return;
            const defaults: Record<string, unknown> = {};
            for (const p of descriptor.params) {
              defaults[p.key] = p.defaultValue;
            }
            context.dispatchProject({
              label: `Effect: ${effectId}`,
              commands: [{ type: 'effect.add', payload: { objectId, effectId, params: defaults } }],
            } as unknown as VisualObjectTransaction);
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
    }
    if (api.id === 'flow')
      return (
        <DualLensPanel
          projection={context.dualLensProjection}
          transitions={visualProject.transitions ?? []}
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
                  <SpecialistReviewPanel
                    timeline={context.timelineProject}
                    creative={visualProject}
                    compositionId={context.timelineProject.rootCompositionId}
                    selectedClipIds={state.selectedIds}
                    projectId={context.timelineProject.id}
                    revisionId={() => context.session.projectRevisionId}
                    onApplyChangeSet={(label, document, artifacts, timelineTransaction) => {
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
      );
    if (api.id === 'jobs') {
      const selectedAudioAssetId = state.selectedIds
        .map((clipId) =>
          context.timelineProject.compositions[context.timelineProject.rootCompositionId]?.tracks
            .flatMap((track) => track.clips)
            .find((clip) => clip.id === clipId),
        )
        .find((clip): clip is VideoClip => clip?.kind === 'video')?.assetId;
      return (
        <JobsPanel
          projectId={controlPlaneProject.controlPlaneProjectId}
          projectTitle={controlPlaneProject.title}
          controlPlaneReady={joySession.kind === 'ready'}
          {...(selectedAudioAssetId === undefined ? {} : { audioAssetId: selectedAudioAssetId })}
          onApplyWorkerAudioResult={applyWorkerAudioResult}
          operationLedger={operationLedger}
          operationRevision={session.historyCursorSequence}
        />
      );
    }
    if (effectivePanelId === 'media')
      return withFeatureHub(
        <AssetLibraryPanel
          projectId={controlPlaneProject.controlPlaneProjectId}
          projectTitle={controlPlaneProject.title}
          onAddSticker={(asset) => void context.addStickerFromAsset(asset)}
          onAddToTimeline={addAssetToTimeline}
          onEditWithAi={(asset) => {
            context.attachKiloCodeAsset(asset);
            context.activatePanel('agent');
          }}
        />,
      );
    if (api.id === 'agent') {
      return (
        <AgentPanel
          project={context.timelineProject}
          selectedClipIds={state.selectedIds}
          playheadUs={state.playheadUs}
          agentContext={context.agentContext}
          onUndo={context.undo}
          session={context.session}
          settings={context.agentSettings}
          {...(context.agentPanelCommand === undefined
            ? {}
            : { command: context.agentPanelCommand })}
          attachedAssets={context.kiloCodeAttachedAssets}
          onDetachAsset={context.detachKiloCodeAsset}
          onAttachAsset={context.attachKiloCodeAsset}
          onAdd3DRender={context.addJoyCode3DRender}
        />
      );
    }
    if (api.id === 'creative-brief') {
      return (
        <Suspense fallback={<PanelShell title="Creative Brief" iconUrl={undefined} />}>
          <CreativeBriefPanel
            revisionId={context.session.projectRevisionId}
            optedIn={context.creativeBriefOptedIn}
            onOptIn={context.onCreativeBriefOptIn}
            runBrief={context.creativeBriefOptedIn ? context.creativeBriefRunner : undefined}
          />
        </Suspense>
      );
    }
    if (api.id === 'history') {
      return <HistoryPanel entries={context.historyEntries} onJumpTo={context.jumpToHistory} />;
    }
    if (api.id === 'diagnostics')
      return (
        <PanelShell
          title="Diagnostics"
          iconUrl={panelTabIconUrl('diagnostics')}
          className="diagnostics-panel"
        >
          <p>Preview source: {context.playback.sourceQuality}</p>
          <p>
            {context.playback.decodedFrames} frames decoded / {context.playback.droppedFrames}{' '}
            frames dropped
          </p>
          <p>
            Presentation drops: {context.playback.presentationDrops}; decode misses:{' '}
            {context.playback.decodeMisses}
          </p>
          <p>
            A/V drift p95: {context.playback.p95DriftUs} µs; max: {context.playback.maxDriftUs} µs
          </p>
          <p>Longest stall: {context.playback.maxStallUs} µs</p>
        </PanelShell>
      );
    if (api.id === 'monitor') return <MonitorPanel />;
    if (api.id === 'workflows') {
      return (
        <WorkflowsPanel
          session={context.session}
          selectedClipIds={state.selectedIds}
          playheadUs={state.playheadUs}
          onRun={async (workflowId, inputs) => {
            try {
              const outcome = await runWorkflow(context.session, workflowId, inputs);
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
          onResume={async (runId, humanInputs) => {
            try {
              const outcome = await resumeWorkflow(context.session, runId, humanInputs);
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
      );
    }
    if (api.id === 'plugins') {
      return <PluginsPanel pluginHost={context.pluginHost} onChange={context.bumpPluginRevision} />;
    }
    if (effectivePanelId === 'templates') {
      return withFeatureHub(
        <LibraryPanel
          onApplyTemplate={(seeded) => {
            buildContentTemplateTransaction(seeded, {
              session: context.session,
              selectedClipIds: state.selectedIds,
              playheadUs: state.playheadUs,
            });
            setRevision((r) => r + 1);
          }}
          showToast={context.showToast}
          openMotionStudio={(sceneId) => context.openMotionStudio(sceneId)}
        />,
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
  const processCounts = {
    active: exportHistory.filter((entry) => entry.status === 'running').length,
    attention: exportHistory.filter(
      (entry) => entry.status === 'failed' || entry.status === 'interrupted-retryable',
    ).length,
    completed: exportHistory.filter((entry) => entry.status === 'completed').length,
  };
  const visibleProcesses = exportHistory.filter((entry) => {
    if (processFilter === 'active') return entry.status === 'running';
    if (processFilter === 'attention')
      return entry.status === 'failed' || entry.status === 'interrupted-retryable';
    if (processFilter === 'completed') return entry.status === 'completed';
    return true;
  });
  const processGroups = [
    {
      id: 'running',
      label: 'Running',
      entries: visibleProcesses.filter((e) => e.status === 'running'),
    },
    {
      id: 'attention',
      label: 'Needs attention',
      entries: visibleProcesses.filter(
        (e) => e.status === 'failed' || e.status === 'interrupted-retryable',
      ),
    },
    {
      id: 'completed',
      label: 'Completed',
      entries: visibleProcesses.filter((e) => e.status === 'completed'),
    },
  ] as const;

  return (
    <main>
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
          <WorkspaceSwitcher
            value={workspacePreset}
            onChange={switchWorkspacePreset}
            onReset={resetWorkspace}
          />
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
              className="icon-button header-export-preset-trigger"
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
              <span className="header-disclosure-chevron" aria-hidden="true">
                <ChevronDownIcon />
              </span>
              <span className="header-export-preset-label">
                {exportPreset === 'reels-1080'
                  ? 'Reels 1080×1920'
                  : exportPreset === 'shorts-1080'
                    ? 'Shorts 1080×1920'
                    : exportPreset === 'youtube-1080'
                      ? 'YouTube 1920×1080'
                      : exportPreset === 'high-bitrate'
                        ? 'High bitrate'
                        : 'Social H.264'}
              </span>
            </button>
            {exportPresetOpen && (
              <section
                className="header-dropdown header-export-preset-dropdown"
                aria-label="Export preset"
              >
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
                        <span className="export-preset-option-label">{label}</span>
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
            onClick={() => void handleExport()}
            disabled={exporting}
            aria-label={exporting ? 'Exporting…' : 'Export MP4'}
            data-guide={exporting ? 'Exporting…' : 'Export MP4'}
            aria-busy={exporting}
          >
            <ExportIcon />
          </button>
          {exporting && (
            <button
              type="button"
              className="icon-button"
              onClick={cancelExport}
              aria-label="Cancel export"
              title="Cancel export"
            >
              <CloseIcon />
            </button>
          )}
          <div className="header-menu">
            <button
              className="icon-button header-processes-trigger"
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
              {processCounts.active + processCounts.attention > 0 && (
                <span
                  className="process-center-count"
                  aria-label={`${processCounts.active + processCounts.attention} active or attention processes`}
                >
                  {processCounts.active + processCounts.attention}
                </span>
              )}
            </button>
            {processesOpen && (
              <section className="header-dropdown" aria-label="Recent processes">
                <h3>Process Center</h3>
                <div className="process-filter-row" role="group" aria-label="Process filter">
                  {(
                    [
                      ['active', 'Active', processCounts.active],
                      ['attention', 'Needs attention', processCounts.attention],
                      ['completed', 'Completed', processCounts.completed],
                      ['all', 'All', exportHistory.length],
                    ] as const
                  ).map(([id, label, count]) => (
                    <button
                      key={id}
                      type="button"
                      className="process-filter-button"
                      aria-pressed={processFilter === id}
                      onClick={() => setProcessFilter(id)}
                    >
                      {label} <span>{count}</span>
                    </button>
                  ))}
                </div>
                {visibleProcesses.length === 0 ? (
                  <p className="empty-hint">No exports yet. Use Export to create an MP4.</p>
                ) : (
                  <div className="process-groups">
                    {processGroups.map(
                      (group) =>
                        group.entries.length > 0 && (
                          <section
                            key={group.id}
                            className="process-group"
                            aria-label={group.label}
                          >
                            <h4>{group.label}</h4>
                            <ul className="process-list">
                              {group.entries.map((entry) => (
                                <li
                                  key={entry.id}
                                  className={`process-row process-${entry.status}`}
                                >
                                  <span className="process-dot" aria-hidden="true" />
                                  <span className="process-name" dir="ltr">
                                    {entry.filename}
                                  </span>
                                  <span className="process-meta">
                                    <strong>
                                      {entry.status === 'running'
                                        ? 'Running'
                                        : entry.status === 'completed'
                                          ? 'Completed'
                                          : entry.status === 'interrupted-retryable'
                                            ? 'Interrupted — retry available'
                                            : 'Failed — retry'}
                                    </strong>{' '}
                                    {entry.status === 'completed' && entry.totalBytes !== undefined
                                      ? `${(entry.totalBytes / 1_048_576).toFixed(1)} MB`
                                      : entry.status !== 'completed'
                                        ? (entry.error ?? '')
                                        : 'Ready to download'}
                                  </span>
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
                                  {(entry.status === 'failed' ||
                                    entry.status === 'interrupted-retryable') && (
                                    <button
                                      type="button"
                                      className="process-retry"
                                      onClick={() => void handleExport(entry)}
                                      disabled={exporting}
                                      aria-label={`Retry ${entry.filename}`}
                                    >
                                      Retry
                                    </button>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </section>
                        ),
                    )}
                  </div>
                )}
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
      <audio
        ref={replacementAudioRef}
        className="playback-media"
        aria-hidden="true"
        preload="auto"
      />
      <EditorPanelContext.Provider
        value={{
          state,
          previewVideoFrame,
          clipFrameCache: clipFrameCacheRef.current,
          clipFrameTick,
          timelineProject: session.timelineProject,
          visualProject: session.visualProject,
          controlPlaneProject,
          playback: playbackDiagnostics.current.snapshot(),
          canUndo: session.canUndo,
          canRedo: session.canRedo,
          historyEntries: session.historyEntries,
          dualLensProjection,
          lensReveal,
          revealInFlow,
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
          dispatchTimelineAndProjectAudio,
          updateVisualProperty,
          dispatchProject,
          replaceVisualProject,
          replaceVisualProjectAndAudio,
          addStickerFromAsset,
          addAdjustmentLayer,
          addTreatmentLayer,
          addCaptionLayer,
          addHtmlSceneToSelectedClip,
          addJoyCode3DRender,
          stickerTick,
          audioState,
          setAudioState,
          transcribe,
          transcriptionError,
          undo,
          redo,
          jumpToHistory,
          session,
          createTool,
          enhanceTool,
          onCreateToolChange: setCreateTool,
          onEnhanceToolChange: setEnhanceTool,
          activatePanel,
          animationGraphFocus,
          openAnimationGraph,
          agentContext,
          agentSettings,
          agentPanelCommand,
          creativeBriefOptedIn,
          creativeBriefRunner,
          onCreativeBriefOptIn,
          kiloCodeAttachedAssets,
          attachKiloCodeAsset,
          detachKiloCodeAsset,
          pluginHost,
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
          activeTimelineCompositionId,
          onActiveTimelineCompositionChange: setActiveTimelineCompositionId,
        }}
      >
        <DockviewReact
          className="workspace"
          components={dockviewComponents}
          defaultTabComponent={PanelTab}
          onReady={onReady}
        />
      </EditorPanelContext.Provider>
      {motionStudioSceneId !== undefined && (
        <Suspense fallback={null}>
          <MotionStudioShell
            key={motionStudioSceneId}
            sceneId={motionStudioSceneId}
            onClose={() => setMotionStudioSceneId(undefined)}
          />
        </Suspense>
      )}
      {effectStudioSession !== undefined && (
        <Suspense fallback={null}>
          <EffectStudioShell
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
              const activeEffects = effects.filter((effect) => effect.enabled);
              if (activeEffects.length === 0) {
                showToast('This recipe has no active effects to apply.', 'info');
                return;
              }
              dispatchProject({
                label: 'Apply Effect Recipe',
                commands: [
                  {
                    type: 'effect.replaceAll',
                    payload: { objectId, effects: activeEffects },
                  },
                ],
              } as unknown as VisualObjectTransaction);
              showToast('Effect recipe applied to the clip.', 'success');
              setEffectStudioSession(undefined);
            }}
            onClose={() => setEffectStudioSession(undefined)}
          />
        </Suspense>
      )}
      {agentSettingsOpen && (
        <AgentSettingsDialog
          settings={agentSettings}
          onChange={setAgentSettings}
          onClose={() => setAgentSettingsOpen(false)}
        />
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
        <div className="shortcuts-overlay" role="dialog" aria-label="Keyboard shortcuts">
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

function MonitorPanel() {
  const context = useContext(EditorPanelContext);
  if (context === undefined) throw new Error('editor panel context is unavailable');
  const {
    state,
    previewVideoFrame,
    clipFrameCache,
    clipFrameTick,
    visualProject,
    timelineProject,
    controlPlaneProject,
    stickerTick,
    togglePlayback,
    seek,
    dispatchProject,
    session,
    bumpProjectRevision,
    showToast,
  } = context;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [monitorDragOver, setMonitorDragOver] = useState(false);
  const rendererRef = useRef<BrowserPixiRenderer | null>(null);
  const rendererPromiseRef = useRef<Promise<BrowserPixiRenderer> | null>(null);
  const rendererDisposeTimerRef = useRef<number | undefined>(undefined);
  const paintRef = useRef<() => void>(() => {});
  const currentFrameRef = useRef<RenderFrameIR | undefined>(undefined);
  const sceneCacheRef = useRef(new HtmlSceneSurfaceCache());
  const [sceneTick, setSceneTick] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [viewerZoom, setViewerZoom] = useState<'fit' | '50' | '100' | '200'>('fit');
  // Fit is a monitor-only choice. Named presets are always derived from the
  // persisted root composition so Undo/Redo and reload cannot leave the
  // footer claiming a canvas ratio that no longer exists.
  const [monitorFitView, setMonitorFitView] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [zoomDrawerOpen, setZoomDrawerOpen] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const transportRef = useRef<HTMLDivElement | null>(null);
  const initialPreviewPreference = useRef(
    loadEditorUiPreferences(window.localStorage).monitorPreview ??
      DEFAULT_EDITOR_UI_PREFERENCES.monitorPreview!,
  );
  const [previewQuality, setPreviewQuality] = useState<PreviewQuality>(
    initialPreviewPreference.current.quality,
  );
  const [previewRenderer, setPreviewRenderer] = useState<'auto' | 'gpu-worker' | 'local'>(
    initialPreviewPreference.current.renderer,
  );
  const [gpuSession, setGpuSession] = useState<BrowserGpuPreviewSession | undefined>(undefined);
  const [gpuPreviewUrl, setGpuPreviewUrl] = useState<string | undefined>(undefined);
  const [gpuPreviewStatus, setGpuPreviewStatus] = useState<
    'local' | 'connecting' | 'hardware-gpu' | 'fallback'
  >(previewRenderer === 'local' ? 'local' : 'connecting');
  const gpuRequestIdRef = useRef(0);
  const monitorResourceTokenRef = useRef(
    `monitor:${crypto.randomUUID?.() ?? Date.now().toString(36)}`,
  );

  useEffect(() => {
    const syncFullscreenState = () =>
      setFullscreen(document.fullscreenElement === panelRef.current);
    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState);
  }, []);

  useEffect(() => {
    if (!zoomDrawerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = transportRef.current;
      if (root === null || root.contains(event.target as Node)) return;
      setZoomDrawerOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setZoomDrawerOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [zoomDrawerOpen]);

  useEffect(() => {
    let cancelled = false;
    const mattes = readImageMatteMap(visualProject);
    const activeStickerIds = new Set(
      Object.values(visualProject.visualObjects)
        .filter((object) => object.kind === 'image' && object.assetId !== undefined)
        .map((object) => object.id),
    );
    stickerImageCache.clearMissing(activeStickerIds);
    void Promise.all(
      Object.values(visualProject.visualObjects).map(async (object) => {
        if (object.kind !== 'image' || object.assetId === undefined) return;
        await stickerImageCache.syncObject({
          objectId: object.id,
          assetId: object.assetId,
          ...(mattes[object.id] !== undefined ? { matteAssetId: mattes[object.id] } : {}),
          crop: object.transform.crop,
          loadBlob: loadStickerAssetBlob,
        });
      }),
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
  }, [visualProject, stickerTick]);

  paintRef.current = (): void => {
    const renderer = rendererRef.current;
    if (renderer === null) return;
    const composition = visualProject.compositions[visualProject.rootCompositionId];
    if (composition === undefined) return;
    const cameraId = composition.activeCameraId;
    const objectsById = visualProject.visualObjects as Readonly<Record<string, VisualObjectV1>>;
    const resolved: ResolvedObject[] = Object.values(visualProject.visualObjects).map((object) => ({
      object,
      transform: evaluateCameraExpressionTransform(
        object.id,
        cameraId,
        objectsById,
        state.playheadUs,
        composition.height,
      ).transform,
    }));
    const visualFrame = withCaptionBurnInNodes(
      buildRenderFrameIR(
        composition.id,
        state.playheadUs,
        composition.width,
        composition.height,
        resolved,
        renderFrameOptions(
          visualProject,
          timelineProject,
          state.playheadUs,
          imageSizesFromCache(state.playheadUs),
        ),
      ),
      visualProject,
    );
    const frame =
      previewVideoFrame === undefined
        ? visualFrame
        : withVideoFrameNode(visualFrame, previewVideoFrame.node);
    currentFrameRef.current = frame;
    const videoBitmaps = new Map(clipFrameCache);
    if (previewVideoFrame !== undefined) {
      videoBitmaps.set(previewVideoFrame.node.id, previewVideoFrame.bitmap);
    }
    for (const [id, bitmap] of sceneCacheRef.current.bitmaps()) {
      videoBitmaps.set(id, bitmap);
    }
    for (const [id, bitmap] of stickerImageCache.bitmaps(state.playheadUs)) {
      videoBitmaps.set(id, bitmap);
    }
    applyClipGradesToTransitionBitmaps(
      visualProject,
      activeTransitionAt(visualProject, state.playheadUs),
      state.playheadUs,
      videoBitmaps,
    );
    renderer.setResolution(previewQualityResolution(previewQuality));
    renderer.render(frame, videoBitmaps);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const rendererResourceToken = monitorResourceTokenRef.current;
    if (rendererDisposeTimerRef.current !== undefined) {
      window.clearTimeout(rendererDisposeTimerRef.current);
      rendererDisposeTimerRef.current = undefined;
    }
    let disposed = false;
    const initialization =
      rendererPromiseRef.current ??
      createBrowserPixiRenderer({
        parent: container,
        resolution: previewQualityResolution(previewQuality),
      });
    rendererPromiseRef.current = initialization;
    initialization
      .then((created) => {
        if (disposed) return;
        rendererRef.current = created;
        recordPreviewResourceCreated('pixi-renderer', rendererResourceToken);
        setMonitorPixelReader(() => created.readPixels());
        paintRef.current();
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      disposed = true;
      // React StrictMode replays effects while preserving this panel. Reuse
      // the same async Pixi Application across that replay so two renderers do
      // not race through Pixi's process-wide CanvasText texture pool. A real
      // unmount has no matching setup and disposes after the zero-delay gate.
      rendererDisposeTimerRef.current = window.setTimeout(() => {
        rendererDisposeTimerRef.current = undefined;
        const pending = rendererPromiseRef.current;
        const existing = rendererRef.current;
        rendererPromiseRef.current = null;
        rendererRef.current = null;
        setMonitorPixelReader(undefined);
        if (pending !== null)
          void pending
            .then((created) => created.destroy())
            .catch(() => undefined)
            .finally(() => recordPreviewResourceReleased('pixi-renderer', rendererResourceToken));
        else {
          existing?.destroy();
          recordPreviewResourceReleased('pixi-renderer', rendererResourceToken);
        }
      }, 0);
    };
  }, [previewQuality]);

  useEffect(() => {
    const current = loadEditorUiPreferences(window.localStorage);
    saveEditorUiPreferences(window.localStorage, {
      ...current,
      monitorPreview: { quality: previewQuality, renderer: previewRenderer },
    });
  }, [previewQuality, previewRenderer]);

  useEffect(() => {
    let cancelled = false;
    let opened: BrowserGpuPreviewSession | undefined;
    if (previewRenderer === 'local') {
      setGpuSession(undefined);
      setGpuPreviewStatus('local');
      return;
    }
    setGpuPreviewStatus('connecting');
    void mediaControlPlaneClient
      .openGpuPreviewSession(controlPlaneProject.controlPlaneProjectId)
      .then((session) => {
        if (cancelled) {
          void mediaControlPlaneClient
            .closeGpuPreviewSession(session.sessionId)
            .catch(() => undefined);
          return;
        }
        opened = session;
        setGpuSession(session);
        setGpuPreviewStatus('hardware-gpu');
      })
      .catch(() => {
        if (cancelled) return;
        setGpuSession(undefined);
        setGpuPreviewStatus('fallback');
      });
    return () => {
      cancelled = true;
      setGpuSession(undefined);
      if (opened !== undefined)
        void mediaControlPlaneClient
          .closeGpuPreviewSession(opened.sessionId)
          .catch(() => undefined);
    };
  }, [controlPlaneProject.controlPlaneProjectId, previewRenderer]);

  useEffect(() => {
    if (previewRenderer === 'local' || gpuSession === undefined || state.playing) return;
    const frame = currentFrameRef.current;
    if (frame === undefined) return;
    const requestId = ++gpuRequestIdRef.current;
    const controller = new AbortController();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await mediaControlPlaneClient.submitGpuPreviewFrame({
            protocolVersion: WORKER_PROTOCOL_VERSION,
            capability: 'render.preview.gpu',
            sessionId: gpuSession.sessionId,
            sessionToken: gpuSession.sessionToken,
            requestId,
            projectId: controlPlaneProject.controlPlaneProjectId,
            projectRevisionId: session.projectRevisionId,
            compositionId: frame.compositionId,
            timeUs: frame.timeUs,
            quality: previewQuality,
            deadlineMs: 2_000,
            frame,
            bitmaps: [
              ...(previewVideoFrame === undefined
                ? []
                : [
                    {
                      nodeId: previewVideoFrame.node.id,
                      width: previewVideoFrame.bitmap.width,
                      height: previewVideoFrame.bitmap.height,
                      rgbaBase64: rgbaBase64(previewVideoFrame.bitmap.data),
                    },
                  ]),
              ...[...clipFrameCache.entries()]
                .filter(([nodeId]) => nodeId !== previewVideoFrame?.node.id)
                .slice(-1)
                .map(([nodeId, bitmap]) => ({
                  nodeId,
                  width: bitmap.width,
                  height: bitmap.height,
                  rgbaBase64: rgbaBase64(bitmap.data),
                })),
            ],
            noStore: true,
          });
          const deadline = performance.now() + 2_000;
          while (!cancelled && performance.now() < deadline) {
            const result = await mediaControlPlaneClient.gpuPreviewFrame(
              gpuSession.sessionId,
              requestId,
              controller.signal,
            );
            if (result !== undefined) {
              if (cancelled || requestId !== gpuRequestIdRef.current) return;
              const nextUrl = URL.createObjectURL(result.blob);
              recordPreviewResourceCreated('gpu-frame-url', nextUrl);
              setGpuPreviewUrl((previous) => {
                if (previous !== undefined) {
                  URL.revokeObjectURL(previous);
                  recordPreviewResourceReleased('gpu-frame-url', previous);
                }
                return nextUrl;
              });
              setGpuPreviewStatus('hardware-gpu');
              return;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 40));
          }
          if (!cancelled) setGpuPreviewStatus('fallback');
        } catch (error) {
          if (!cancelled && !(error instanceof DOMException && error.name === 'AbortError'))
            setGpuPreviewStatus('fallback');
        }
      })();
    }, 80);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    clipFrameTick,
    clipFrameCache,
    controlPlaneProject.controlPlaneProjectId,
    gpuSession,
    previewQuality,
    previewRenderer,
    previewVideoFrame,
    sceneTick,
    session,
    state.playheadUs,
    state.playing,
    visualProject,
  ]);

  useEffect(
    () => () => {
      if (gpuPreviewUrl !== undefined) {
        URL.revokeObjectURL(gpuPreviewUrl);
        recordPreviewResourceReleased('gpu-frame-url', gpuPreviewUrl);
      }
    },
    [gpuPreviewUrl],
  );

  useEffect(() => {
    let cancelled = false;
    void sceneCacheRef.current.sync(visualProject.visualObjects, state.playheadUs).then(() => {
      if (cancelled) return;
      setSceneTick((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [state.playheadUs, visualProject]);

  useEffect(() => () => sceneCacheRef.current.destroy(), []);

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
  const monitorAspectRatio: MonitorAspectRatio = monitorFitView
    ? 'fit'
    : monitorAspectRatioForDimensions(width, height);
  const timelineComposition = timelineProject.compositions[timelineProject.rootCompositionId];
  const durationUs =
    timelineComposition === undefined
      ? (composition?.durationUs ?? 30_000_000)
      : timelineEffectiveDurationUs(timelineComposition);
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
      void document
        .exitFullscreen()
        .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      return;
    }
    void el
      .requestFullscreen()
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const changeMonitorAspectRatio = useCallback(
    (nextAspectRatio: MonitorAspectRatio) => {
      const dimensions = monitorAspectRatioDimensions(nextAspectRatio);
      // Fit is intentionally a monitor view choice: it keeps the project's
      // authored canvas unchanged while the canvas uses its existing contain
      // behavior. Every named ratio below is a real, undoable project change.
      if (dimensions === undefined) {
        setMonitorFitView(true);
        return;
      }
      const visualComposition = visualProject.compositions[visualProject.rootCompositionId];
      const timelineComposition = timelineProject.compositions[timelineProject.rootCompositionId];
      if (visualComposition === undefined || timelineComposition === undefined) {
        showToast('The root composition is unavailable for this aspect-ratio change.', 'error');
        return;
      }
      if (
        visualComposition.width === dimensions.width &&
        visualComposition.height === dimensions.height &&
        timelineComposition.width === dimensions.width &&
        timelineComposition.height === dimensions.height
      ) {
        setMonitorFitView(false);
        return;
      }
      try {
        session.dispatchCompound(`Change canvas aspect ratio to ${nextAspectRatio}`, {
          document: {
            ...visualProject,
            updatedAt: new Date().toISOString(),
            compositions: {
              ...visualProject.compositions,
              [visualComposition.id]: {
                ...visualComposition,
                width: dimensions.width,
                height: dimensions.height,
              },
            },
          },
          timeline: {
            label: `Change canvas aspect ratio to ${nextAspectRatio}`,
            commands: [
              {
                type: 'timeline.setCompositionDimensions',
                payload: {
                  compositionId: timelineComposition.id,
                  width: dimensions.width,
                  height: dimensions.height,
                },
              },
            ],
          },
        });
        setMonitorFitView(false);
        bumpProjectRevision();
        showToast(`Canvas changed to ${nextAspectRatio}.`, 'success');
      } catch (reason) {
        showToast(
          `Could not change canvas aspect ratio: ${
            reason instanceof Error ? reason.message : String(reason)
          }`,
          'error',
        );
      }
    },
    [bumpProjectRevision, session, showToast, timelineProject, visualProject],
  );

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
        const descriptor = effectRegistry.getEffect(payload.effectId);
        if (!descriptor) return;
        const defaults: Record<string, unknown> = {};
        for (const p of descriptor.params) {
          defaults[p.key] = p.defaultValue;
        }
        dispatchProject({
          label: `Effect: ${payload.effectId}`,
          commands: [
            {
              type: 'effect.add',
              payload: { objectId, effectId: payload.effectId, params: defaults },
            },
          ],
        } as unknown as VisualObjectTransaction);
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
        {gpuPreviewUrl !== undefined && !state.playing && gpuPreviewStatus === 'hardware-gpu' && (
          <img
            className="monitor-gpu-frame"
            src={gpuPreviewUrl}
            alt="Hardware GPU Worker preview"
            data-preview-renderer="hardware-gpu"
          />
        )}
      </div>
      <div className="monitor-transport" ref={transportRef}>
        {zoomDrawerOpen && (
          <div
            className="monitor-zoom-drawer"
            id="monitor-zoom-drawer"
            role="dialog"
            aria-label="Preview scale"
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
          <label className="monitor-preview-control">
            <span>Quality</span>
            <select
              aria-label="Monitor preview quality"
              value={previewQuality}
              onChange={(event) => setPreviewQuality(event.target.value as PreviewQuality)}
            >
              {(['quarter', 'half', 'full'] as const).map((quality) => (
                <option key={quality} value={quality}>
                  {previewQualityLabel(quality)}
                </option>
              ))}
            </select>
          </label>
          <label className="monitor-preview-control">
            <span>Renderer</span>
            <select
              aria-label="Monitor preview renderer"
              value={previewRenderer}
              onChange={(event) =>
                setPreviewRenderer(event.target.value as 'auto' | 'gpu-worker' | 'local')
              }
            >
              <option value="auto">Auto</option>
              <option value="gpu-worker">GPU Worker</option>
              <option value="local">Local</option>
            </select>
          </label>
          <span
            className={`monitor-preview-status is-${gpuPreviewStatus}`}
            title={gpuSession === undefined ? undefined : `Worker ${gpuSession.workerId}`}
          >
            {gpuPreviewStatus === 'hardware-gpu'
              ? 'GPU'
              : gpuPreviewStatus === 'connecting'
                ? 'Connecting'
                : gpuPreviewStatus === 'fallback'
                  ? 'Local fallback'
                  : 'Local'}
          </span>
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
          <MonitorAspectRatioSelector
            selectedAspectRatio={monitorAspectRatio}
            authoredWidth={width}
            authoredHeight={height}
            onAspectRatioChange={changeMonitorAspectRatio}
          />
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

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
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
