import { createContext } from 'react';
import type { CreativeBriefV1, EditorContext } from '@joy-media/agent-tools';
import type {
  ArtifactStore,
  ArtifactTransaction,
  CommandTransaction,
  GraphTransaction,
} from '@joy-media/commands';
import type { AudioState } from '@joy-media/commands';
import type { PlaybackDiagnosticsSnapshot, ImageDataLike } from '@joy-media/playback-engine';
import type {
  AnimatablePropertyV1,
  JoyProjectV1,
  SpikeProject,
  WorkflowGraphV2,
} from '@joy-media/project-schema';
import type { TimelineTrackView, TimelineViewport } from '@joy-media/timeline-engine';
import type { VideoFrameNode } from '@joy-media/render-ir';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import type { AgentPanelCommand, JoyAgentAttachedAsset } from './AgentPanel.js';
import type { AgentPolicyPreferences } from './agent-policy-settings.js';
import type { TreatmentLayerEffectSeed, TreatmentLayerKind } from './adjustment-layer.js';
import type { DataLane } from './data-lanes.js';
import type { DualLensProjection } from './dual-lens-model.js';
import type { LensRevealRequest } from './dual-lens-reveal.js';
import type { HistoryEntry, EditorSession } from './editor-session.js';
import type { FeatureToolId } from './feature-architecture.js';
import type { createEditorPluginHost } from './plugin-host.js';
import type { ControlPlaneProjectBinding } from './project-control-plane.js';
import type { ProjectWriterStorage } from './project-writer.js';
import type { JoyCode3DRenderAsset } from './JoyCode3DViewer.js';

export interface EditorRuntimeState {
  readonly selectedIds: readonly string[];
  readonly playheadUs: number;
  readonly playing: boolean;
}

/** A decoded browser frame kept outside the serializable RenderFrameIR. */
export interface DecodedPreviewFrame {
  readonly node: VideoFrameNode;
  readonly bitmap: ImageDataLike;
}

export interface AnimationGraphFocusRequest {
  readonly objectId: string;
  readonly channel: AnimatablePropertyV1;
  /** Makes repeat requests to an already focused channel observable. */
  readonly token: number;
}

/** Browser localStorage, guarded by the owning project writer capability. */
export interface GuardedBrowserStorage extends ProjectWriterStorage {
  removeItem(key: string): void;
}

/**
 * Dockview panels receive this typed, writer-gated surface instead of importing
 * the application root. Keeping it in a leaf module prevents panel-to-App
 * cycles that inflate production chunks and makes the ownership boundary
 * explicit.
 */
export interface EditorPanelContextValue {
  readonly storage: GuardedBrowserStorage;
  readonly state: EditorRuntimeState;
  readonly previewVideoFrame: DecodedPreviewFrame | undefined;
  readonly clipFrameCache: ReadonlyMap<string, ImageDataLike>;
  readonly clipFrameTick: number;
  readonly timelineProject: SpikeProject;
  readonly visualProject: JoyProjectV1;
  readonly controlPlaneProject: ControlPlaneProjectBinding;
  readonly controlPlaneReady: boolean;
  readonly loadProjectAssetBlob: (assetId: string) => Promise<Blob | undefined>;
  readonly playback: PlaybackDiagnosticsSnapshot;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly historyEntries: readonly HistoryEntry[];
  readonly dualLensProjection: DualLensProjection;
  readonly lensReveal: LensRevealRequest | undefined;
  readonly revealInFlow: (clipId: string) => void;
  readonly revealOnTimeline: (clipIds: readonly string[]) => void;
  readonly workflowGraph: WorkflowGraphV2 | undefined;
  readonly dispatchGraph: (transaction: GraphTransaction) => void;
  readonly dataLanes: readonly DataLane[] | undefined;
  readonly artifacts: ArtifactStore | undefined;
  readonly dispatchArtifacts: (transaction: ArtifactTransaction) => void;
  readonly togglePlayback: () => void;
  readonly seek: (timeUs: number) => void;
  readonly toggleSelection: (id: string) => void;
  readonly selectClips: (clipIds: readonly string[]) => void;
  readonly clearSelection: () => void;
  readonly dispatchTimeline: (transaction: CommandTransaction) => void;
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
  readonly session: EditorSession;
  readonly createTool: FeatureToolId;
  readonly enhanceTool: FeatureToolId;
  readonly onCreateToolChange: (tool: FeatureToolId) => void;
  readonly onEnhanceToolChange: (tool: FeatureToolId) => void;
  readonly activatePanel: (panelId: string) => void;
  readonly animationGraphFocus: AnimationGraphFocusRequest | undefined;
  readonly openAnimationGraph: (objectId: string, channel: AnimatablePropertyV1) => void;
  readonly agentContext: EditorContext;
  readonly agentPolicy: AgentPolicyPreferences;
  readonly agentPanelCommand: AgentPanelCommand | undefined;
  readonly creativeBriefOptedIn: boolean;
  readonly creativeBriefRunner: (requestText: string) => Promise<CreativeBriefV1>;
  readonly onCreativeBriefOptIn: () => Promise<void>;
  readonly joyAgentAttachedAssets: readonly JoyAgentAttachedAsset[];
  readonly attachJoyAgentAsset: (asset: JoyAgentAttachedAsset) => void;
  readonly detachJoyAgentAsset: (assetId: string) => void;
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
  readonly timelineViewport: TimelineViewport;
  readonly onTimelineViewportChange: (next: TimelineViewport) => void;
  readonly timelineTrackFlags: readonly TimelineTrackView[];
  readonly onTimelineTrackFlagsChange: (next: readonly TimelineTrackView[]) => void;
  readonly timelineAutoFit: boolean;
  readonly onTimelineAutoFitChange: (next: boolean) => void;
  readonly activeTimelineCompositionId: string;
  readonly onActiveTimelineCompositionChange: (compositionId: string) => void;
}

export const EditorPanelContext = createContext<EditorPanelContextValue | undefined>(undefined);
