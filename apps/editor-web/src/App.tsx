import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { DockviewReact } from 'dockview';
import type { DockviewReadyEvent, IDockviewPanelProps } from 'dockview';
import { PanelTab } from './PanelTab.js';
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
import { rippleDelete, toggleSelection, duplicateClipCommand } from '@joy-media/timeline-engine';
import type { CommandTransaction } from '@joy-media/commands';
import type { EditorContext } from '@joy-media/agent-tools';
import { buildEditorContext } from '@joy-media/agent-tools';
import type { HistoryEntry } from './editor-session.js';
import type {
  JoyProjectV1,
  SpikeProject,
  VideoClip,
  VisualObjectV1,
} from '@joy-media/project-schema';
import { normalizePlaybackRate } from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import { evaluateCameraExpressionTransform } from '@joy-media/evaluator';
import { buildRenderFrameIR, type ResolvedObject } from '@joy-media/visual-object-renderer';
import {
  createBrowserPixiRenderer,
  type BrowserPixiRenderer,
} from '@joy-media/renderer-pixi/browser';
import {
  downloadBrowserMp4,
  type BrowserExportManifest,
  type BrowserExportResult,
} from '@joy-media/renderer-pixi/browser-export';
import { HtmlSceneSurfaceCache } from './html-scene-surfaces.js';
import { EMPTY_EDITOR_STATE, searchActions } from './editor-state.js';
import { TIMELINE_OBJECT_IDS } from './editor-project.js';
import { EditorSession } from './editor-session.js';
import { TimelinePanel } from './TimelinePanel.js';
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
import { CaptionsPanel } from './CaptionsPanel.js';
import { InspectorPanel } from './InspectorPanel.js';
import { MotionPanel } from './MotionPanel.js';
import { CameraPanel } from './CameraPanel.js';
import { JobsPanel } from './JobsPanel.js';
import { AssetLibraryPanel } from './AssetLibraryPanel.js';
import { AudioPanel } from './AudioPanel.js';
import { EffectsPanel } from './EffectsPanel.js';
import { ColorPanel } from './ColorPanel.js';
import { TransitionsPanel } from './TransitionsPanel.js';
import {
  ensureClipAudio,
  loadAudioState,
  saveAudioState,
  withProjectAudio,
} from './audio-session.js';
import type { AudioState } from '@joy-media/commands';
import { buildMixerBuffer } from './mixer-buffer.js';
import type { ExportPresetId } from '@joy-media/project-schema';
import { AgentPanel } from './AgentPanel.js';
import { HistoryPanel } from './HistoryPanel.js';
import { WorkflowsPanel } from './WorkflowsPanel.js';
import { PluginsPanel } from './PluginsPanel.js';
import { createEditorPluginHost } from './plugin-host.js';
import { createAgentCommandBus } from './agent-command-bus.js';
import { resumeWorkflow, runWorkflow } from './workflow-runner.js';
import {
  getOrCreateControlPlaneProjectBinding,
  type ControlPlaneProjectBinding,
} from './project-control-plane.js';
import { transcribeReferenceCaption } from './local-transcription.js';
import { DEFAULT_WORKSPACE } from './workspace.js';
import { panelLabel } from './panel-tab-icons.js';
import { isEditableTarget, resolveShortcut } from './keyboard-shortcuts.js';
import {
  CommandIcon,
  DownloadIcon,
  ExportIcon,
  HighBitrateIcon,
  ListIcon,
  LogoutIcon,
  ProjectsIcon,
  RedoIcon,
  ReelsIcon,
  UndoIcon,
  UserIcon,
  YoutubeIcon,
} from './icons.js';
import {
  JOY_LOGIN_URL,
  logoutJoySession,
  probeJoySession,
  type JoySessionState,
} from './identity.js';
import {
  loadExportHistory,
  saveExportHistory,
  upsertEntry,
  type ExportProcessEntry,
} from './export-history.js';
import './app.css';
import 'dockview/dist/styles/dockview.css';

/**
 * WP-11.2: resolves a timeline clip's assetId to a real, browser-fetchable
 * URL for HTMLVideoElement decode. The reference intro/product/outro clips
 * each have a committed 30 s H.264/AAC fixture under `public/media/reference`.
 */
function resolveReferenceMediaUrl(assetId: string): string {
  return `/media/reference/${assetId}.mp4`;
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

/** Resolve the currently playing timeline clip from the live media URL. */
function activeVideoClipForSource(project: SpikeProject, sourceUrl: string) {
  const composition = project.compositions.root;
  return composition?.tracks
    .flatMap((track) => track.clips)
    .find(
      (clip) => clip.kind === 'video' && sourceUrl.endsWith(`/media/reference/${clip.assetId}.mp4`),
    );
}

function videoClipSpec(clip: VideoClip): VideoClipSpec {
  return {
    id: clip.assetId,
    originalToken: resolveReferenceMediaUrl(clip.assetId),
    startUs: clip.startUs,
    durationUs: clip.durationUs,
    sourceInUs: clip.sourceInUs,
    transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
    opacity: 1,
    zIndex: 0,
  };
}

/** Composition playhead → source media time, honoring clip.playbackRate (0 = freeze). */
function sourceTimeForPlayhead(clip: VideoClip, playheadUs: number): number {
  const rate = normalizePlaybackRate(clip.playbackRate);
  if (rate === 0) return clip.sourceInUs;
  return clip.sourceInUs + (playheadUs - clip.startUs) * rate;
}

/** Source media time → composition playhead (freeze holds last mapped start). */
function playheadForSourceTime(clip: VideoClip, sourceTimeUs: number, freezePlayheadUs: number): number {
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
  readonly timelineProject: SpikeProject;
  readonly visualProject: JoyProjectV1;
  readonly controlPlaneProject: ControlPlaneProjectBinding;
  readonly playback: PlaybackScheduler['metrics'];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly historyEntries: readonly HistoryEntry[];
  readonly togglePlayback: () => void;
  readonly seek: (timeUs: number) => void;
  readonly toggleSelection: (id: string) => void;
  readonly dispatchTimeline: (transaction: CommandTransaction) => void;
  readonly updateVisualProperty: (
    objectId: string,
    key: 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotationDeg' | 'opacity',
    value: number,
  ) => void;
  readonly dispatchProject: (transaction: VisualObjectTransaction) => void;
  readonly replaceVisualProject: (next: JoyProjectV1) => void;
  readonly audioState: AudioState;
  readonly setAudioState: (next: AudioState, label?: string) => void;
  readonly transcribe: (documentId: string, language: 'fa-IR' | 'en-US') => Promise<void>;
  readonly transcriptionError: string | undefined;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly agentContext: EditorContext;
}
const EditorPanelContext = createContext<EditorPanelContextValue | undefined>(undefined);

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

  const backToLibrary = useCallback(() => {
    clearActiveProjectId(storage);
    setActiveProjectId(null);
  }, [storage]);

  if (activeProjectId === null) {
    return (
      <ProjectLibrary storage={storage} onOpen={openProject} onCreate={createProject} />
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [transcriptionError, setTranscriptionError] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | undefined>(undefined);
  const [exportProgress, setExportProgress] = useState<number | undefined>(undefined);
  const [exportHistory, setExportHistory] = useState<readonly ExportProcessEntry[]>(() =>
    loadExportHistory(window.localStorage),
  );
  const [exportPreset, setExportPreset] = useState<ExportPresetId>('social-h264-aac');
  const [audioState, setAudioStateRaw] = useState<AudioState>(() => loadAudioState(projectId));
  const [processesOpen, setProcessesOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [joySession, setJoySession] = useState<JoySessionState>({ kind: 'unknown' });
  const lastExportRef = useRef<{ readonly entryId: string; readonly url: string } | null>(null);
  const exportToastTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    return () => {
      window.clearTimeout(exportToastTimerRef.current);
    };
  }, []);
  const [previewVideoFrame, setPreviewVideoFrame] = useState<DecodedPreviewFrame | undefined>(
    undefined,
  );
  const [, setRevision] = useState(0);
  const [pluginHost] = useState(() => createEditorPluginHost());
  const [, setPluginRevision] = useState(0);
  const sessionRef = useRef<EditorSession | null>(null);
  const controlPlaneProjectRef = useRef<ControlPlaneProjectBinding | null>(null);
  const scheduler = useRef(new PlaybackScheduler());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const decoderRef = useRef<HtmlMediaDecoder | null>(null);
  const clockRef = useRef<MediaClock | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const previewAudioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const previewGainNodeRef = useRef<GainNode | null>(null);
  const previewPanNodeRef = useRef<StereoPannerNode | null>(null);
  const previewMixerSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const previewMixerBufferRef = useRef<Float32Array | null>(null);

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
    const seeds = seedsForCatalogEntry(entry);
    sessionRef.current = new EditorSession(window.localStorage, seeds.timeline, seeds.visual);
  }
  const session = sessionRef.current;
  const controlPlaneProject =
    controlPlaneProjectRef.current ??
    (controlPlaneProjectRef.current = getOrCreateControlPlaneProjectBinding(
      window.localStorage,
      session.visualProject,
    ));
  const agentCommandBusRef = useRef<ReturnType<typeof createAgentCommandBus> | null>(null);
  if (agentCommandBusRef.current === null)
    agentCommandBusRef.current = createAgentCommandBus(session, () =>
      setRevision((revision) => revision + 1),
    );
  // WP-15.1/15.2: rebuilt each render so a dry-run/execute always sees the
  // current real timeline, bound to the real command bus above — not a mock.
  // `buildEditorContext`'s selection/audio fields are pre-existing, unwired
  // summarizers (always empty); the Agent panel reads real selection/playhead
  // state directly as props instead, documented in the WP-15 plan.
  const agentContext = buildEditorContext(
    session.timelineProject,
    undefined,
    agentCommandBusRef.current,
    { liveAudio: audioState },
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastMediaTimeUsRef = useRef<number | undefined>(undefined);
  const freezeWallStartRef = useRef<{ wallMs: number; playheadUs: number } | undefined>(undefined);
  const playbackFrameRef = useRef<number | undefined>(undefined);

  const syncMediaToPlayhead = useCallback(
    async (playheadUs: number, play: boolean): Promise<boolean> => {
      const video = videoRef.current;
      const clock = clockRef.current;
      const composition = session.timelineProject.compositions.root;
      const clip = activeVideoClipAt(session.timelineProject, playheadUs);
      if (
        video === null ||
        clock === null ||
        composition === undefined ||
        clip === undefined ||
        clip.kind !== 'video'
      )
        return false;
      const sourceUrl = new URL(resolveReferenceMediaUrl(clip.assetId), window.location.href).href;
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
      }
      const rate = normalizePlaybackRate(clip.playbackRate);
      const sourceTimeUs = sourceTimeForPlayhead(clip, playheadUs);
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
      }
      return true;
    },
    [session],
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
        activeVideoClipForSource(session.timelineProject, video.currentSrc) ??
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
        const nextPlayheadUs = clip.startUs + clip.durationUs;
        const durationUs = session.timelineProject.compositions.root?.durationUs ?? nextPlayheadUs;
        if (nextPlayheadUs >= durationUs) {
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
        setPreviewVideoFrame({ node, bitmap: frame.bitmap });
        const previous = lastMediaTimeUsRef.current;
        if (previous === undefined) scheduler.current.recordDecodedFrame(token, true, true);
        else scheduler.current.driveTick(clock, true, Math.max(1, sourceTimeUs - previous));
      }
      lastMediaTimeUsRef.current = sourceTimeUs;
      setState((active) => ({ ...active, playheadUs: compositionTimeUs }));
      setRevision((revision) => revision + 1);
      requestFrame();
    };
    const requestFrame = (): void => {
      // Freeze holds a still frame — drive with rAF. Otherwise follow media cadence.
      const clip =
        activeVideoClipForSource(session.timelineProject, video.currentSrc) ??
        activeVideoClipAt(session.timelineProject, stateRef.current.playheadUs);
      const freeze =
        clip?.kind === 'video' && normalizePlaybackRate(clip.playbackRate) === 0;
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
  }, [session, state.playing, syncMediaToPlayhead]);
  const handleMediaReady = useCallback((decoder: HtmlMediaDecoder, clock: MediaClock) => {
    decoderRef.current = decoder;
    clockRef.current = clock;
  }, []);
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    const captureCanvas = document.createElement('canvas');
    // A zero-sized canvas asks the decoder to size it to the decoded media on
    // first use; this avoids treating the DOM default 300×150 as a proxy size.
    captureCanvas.width = 0;
    captureCanvas.height = 0;
    const decoder = createHtmlMediaDecoder(video, captureCanvas);
    handleMediaReady(decoder, createHtmlVideoMediaClock(video));
    const firstClip = activeVideoClipAt(session.timelineProject, 0);
    if (firstClip !== undefined && firstClip.kind === 'video')
      video.src = resolveReferenceMediaUrl(firstClip.assetId);
    return () => video.pause();
  }, [handleMediaReady, session]);
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
      session.dispatchTimeline(transaction);
      setRevision((revision) => revision + 1);
    },
    [session],
  );
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

  const setAudioState = useCallback(
    (next: AudioState) => {
      setAudioStateRaw(next);
      saveAudioState(projectId, next);
      session.replaceVisualProject(withProjectAudio(session.visualProject, next));
      setRevision((revision) => revision + 1);
    },
    [projectId, session],
  );

  const timelineClipIds =
    session.timelineProject.compositions.root?.tracks.flatMap((track) =>
      track.clips.map((clip) => clip.id),
    ) ?? [];
  useEffect(() => {
    setAudioStateRaw((current) => ensureClipAudio(current, timelineClipIds));
  }, [timelineClipIds.join('|')]);

  const transcribe = useCallback(
    async (documentId: string, language: 'fa-IR' | 'en-US') => {
      try {
        const document = await transcribeReferenceCaption(documentId, language);
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
    [session],
  );
  const undo = useCallback(() => {
    session.undo();
    setRevision((revision) => revision + 1);
  }, [session]);
  const redo = useCallback(() => {
    session.redo();
    setRevision((revision) => revision + 1);
  }, [session]);
  const executeAction = useCallback(
    (id: string) => {
      if (id === 'history.undo') undo();
      if (id === 'history.redo') redo();
      setPaletteOpen(false);
    },
    [redo, undo],
  );
  const refreshJoySession = useCallback(() => {
    void probeJoySession().then(setJoySession);
  }, []);
  useEffect(() => {
    refreshJoySession();
  }, [refreshJoySession]);
  const signOut = useCallback(async () => {
    await logoutJoySession();
    refreshJoySession();
  }, [refreshJoySession]);
  const recordExportEntry = useCallback((entry: ExportProcessEntry) => {
    setExportHistory((entries) => {
      const next = upsertEntry(entries, entry);
      saveExportHistory(window.localStorage, next);
      return next;
    });
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
  }, [dispatchTimeline, redo, seek, session, togglePlayback, undo]);
  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    window.clearTimeout(exportToastTimerRef.current);
    setExportStatus('Building render manifest…');
    setExportProgress(0.02);
    const entryId = `export-${Date.now()}`;
    const startedAt = new Date().toISOString();
    const exportFilename = `joy-media-export-${Date.now()}.mp4`;
    recordExportEntry({ id: entryId, filename: exportFilename, status: 'running', startedAt });
    try {
      const compositionV1 =
        session.visualProject.compositions[session.visualProject.rootCompositionId];
      const baseWidth = compositionV1?.width ?? 1920;
      const baseHeight = compositionV1?.height ?? 1080;
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
      const cameraId = compositionV1?.activeCameraId;
      const objectsById = session.visualProject.visualObjects as Readonly<
        Record<string, VisualObjectV1>
      >;
      const buildFrame = (timeUs: number) => {
        const resolved: ResolvedObject[] = Object.values(session.visualProject.visualObjects).map(
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
        return buildRenderFrameIR(
          compositionV1?.id ?? 'root',
          timeUs,
          width,
          height,
          resolved,
          session.visualProject.transitions,
        );
      };
      const transitionTimes = Array.from(
        new Set(
          (compositionTimeline?.tracks.flatMap((track) => track.clips) ?? []).flatMap((clip) => [
            clip.startUs,
            clip.startUs + clip.durationUs,
          ]),
        ),
      ).sort((left, right) => left - right);
      const exportClips = transitionTimes
        .map((timeUs) => activeVideoClipAt(session.timelineProject, timeUs))
        .filter((clip): clip is VideoClip => clip?.kind === 'video')
        .filter(
          (clip, index, clips) =>
            clips.findIndex((candidate) => candidate.id === clip.id) === index,
        );
      if (exportClips.length === 0)
        throw new Error('No playable video clips are available for export');

      setExportStatus('Preloading preview-equivalent video and audio…');
      setExportProgress(0.05);
      const audioContext = new AudioContext();
      const audioDestination = audioContext.createMediaStreamDestination();
      const exportMedia = await Promise.all(
        exportClips.map(async (clip) => {
          const video = document.createElement('video');
          await loadDetachedVideo(video, resolveReferenceMediaUrl(clip.assetId));
          await seekDetachedVideo(video, clip.sourceInUs);
          const captureCanvas = document.createElement('canvas');
          captureCanvas.width = 0;
          captureCanvas.height = 0;
          const audioResponse = await fetch(resolveReferenceMediaUrl(clip.assetId));
          if (!audioResponse.ok)
            throw new Error(`Unable to fetch export audio for ${clip.assetId}`);
          const audioBuffer = await audioContext.decodeAudioData(
            await audioResponse.arrayBuffer(),
          );
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
      const mediaForClip = new Map(exportMedia.map((media) => [media.clip.id, media]));
      const mixedAudio = buildMixerBuffer(
        exportMedia.map((media) => ({ clipId: media.clip.id, samples: media.audio.samples })),
        audioState.clips,
        audioState.buses,
        durationUs,
        exportMedia[0]?.audio.sampleRate ?? 48000,
      );
      const mixedAudioBuffer = audioContext.createBuffer(1, mixedAudio.length, exportMedia[0]?.audio.sampleRate ?? 48000);
      const mixedChannel = mixedAudioBuffer.getChannelData(0);
      for (let i = 0; i < mixedAudio.length; i++) mixedChannel[i] = mixedAudio[i]!;
      const mixedAudioSource = audioContext.createBufferSource();
      mixedAudioSource.buffer = mixedAudioBuffer;
      mixedAudioSource.connect(audioDestination);
      const exportAudioTrack = audioDestination.stream.getAudioTracks()[0];
      if (exportAudioTrack === undefined)
        throw new Error('Export audio mix did not produce a track');
      const renderer = await createBrowserPixiRenderer({ width, height, resolution: 1 });
      const hasHtmlScenes = Object.values(session.visualProject.visualObjects).some(
        (object) => object.kind === 'html-scene',
      );
      const sceneFrames = new Map<number, Map<string, { width: number; height: number; data: Uint8ClampedArray }>>();
      if (hasHtmlScenes) {
        setExportStatus('Capturing HTML scene frames…');
        const sceneCache = new HtmlSceneSurfaceCache();
        try {
          for (let index = 0; index < totalFrames; index++) {
            const timeUs = Math.min(durationUs - 1, Math.floor((index * 1_000_000) / frameRate));
            await sceneCache.sync(session.visualProject.visualObjects, timeUs);
            sceneFrames.set(index, new Map(sceneCache.bitmaps()));
            if (index % frameRate === 0)
              setExportStatus(`Capturing HTML scenes… ${index + 1}/${totalFrames}`);
          }
        } finally {
          sceneCache.destroy();
        }
      }
      const startTimers: number[] = [];
      const audioSources: AudioBufferSourceNode[] = [];
      try {
        await audioContext.resume();
        setExportStatus(`Encoding ${totalFrames} preview-equivalent H.264/AAC frames…`);
        const exportResult: BrowserExportResult = await downloadBrowserMp4({
          manifest,
          frameCount: totalFrames,
          canvas: renderer.canvas,
          audioTrack: exportAudioTrack,
          onRecordingStart: () => {
            const startAt = audioContext.currentTime;
            for (const media of exportMedia) {
              const audioSource = audioContext.createBufferSource();
              const playbackBuffer = audioContext.createBuffer(
                media.audio.samples.length,
                1,
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
          paintFrame: (index) => {
            const timeUs = Math.min(durationUs - 1, Math.floor((index * 1_000_000) / frameRate));
            const clip = activeVideoClipAt(session.timelineProject, timeUs);
            if (clip === undefined || clip.kind !== 'video')
              throw new Error(`No active video clip at ${timeUs}µs during export`);
            const media = mediaForClip.get(clip.id);
            if (media === undefined)
              throw new Error(`Export media for ${clip.id} was not prepared`);
            const token = index + 1;
            const decoded = media.decoder.captureCurrentFrame(token);
            if (decoded.bitmap === undefined)
              throw new Error(`Export media frame ${index} for ${clip.assetId} is not drawable`);
            const node = videoFrameNodeFromDecoded(videoClipSpec(clip), decoded, {
              width: media.video.videoWidth,
              height: media.video.videoHeight,
            });
            const bitmaps = new Map([[node.id, decoded.bitmap]]);
            const scenes = sceneFrames.get(index);
            if (scenes !== undefined) {
              for (const [id, bitmap] of scenes) bitmaps.set(id, bitmap);
            }
            renderer.render(withVideoFrameNode(buildFrame(timeUs), node), bitmaps);
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
        for (const media of exportMedia) media.video.pause();
        renderer.destroy();
        await audioContext.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setExportStatus(`Export failed: ${message}`);
      recordExportEntry({
        id: entryId,
        filename: exportFilename,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        error: message,
      });
      setExportProgress(undefined);
      exportToastTimerRef.current = window.setTimeout(() => {
        setExportStatus(undefined);
      }, 8_000);
    } finally {
      setExporting(false);
    }
  }, [exportPreset, exporting, recordExportEntry, session]);
  const onReady = useCallback((event: DockviewReadyEvent) => {
    // v3: utilities stack as tabs in one group (`within`). v2 wrongly split each
    // utility into its own column via repeated `direction: 'right'`.
    const layoutKey = 'joy-media.dockview.v4';
    window.localStorage.removeItem('joy-media.dockview.v1');
    window.localStorage.removeItem('joy-media.dockview.v2');
    window.localStorage.removeItem('joy-media.dockview.v3');
    const saved = window.localStorage.getItem(layoutKey);
    let restored = false;
    if (saved !== null) {
      try {
        event.api.fromJSON(JSON.parse(saved), { reuseExistingPanels: false });
        restored = true;
      } catch {
        window.localStorage.removeItem(layoutKey);
      }
    }

    const previouslyActive = event.api.activePanel?.id;
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
      if (event.api.getPanel(id) !== undefined) return;
      event.api.addPanel({
        id,
        component: 'editor-panel',
        title: panelLabel(id),
        inactive: options.inactive ?? true,
        ...(options.position !== undefined ? { position: options.position } : {}),
      });
    };

    if (!restored) {
      // Adobe-like seed: media | monitor/timeline | one utility tab group.
      addPanel('monitor', { inactive: false });
      addPanel('timeline', { position: { referencePanel: 'monitor', direction: 'below' } });
      addPanel('media', { position: { referencePanel: 'monitor', direction: 'left' } });
      addPanel('captions', { position: { referencePanel: 'monitor', direction: 'right' } });
      const stackedUtilities = [
        'inspector',
        'motion',
        'camera',
        'audio',
        'effects',
        'color',
        'history',
        'diagnostics',
        'jobs',
        'agent',
        'workflows',
        'plugins',
        'transitions',
      ] as const;
      for (const id of stackedUtilities) {
        addPanel(id, { position: { referencePanel: 'captions', direction: 'within' } });
      }
      event.api.getPanel('monitor')?.api.setActive();
    } else {
      for (const panel of DEFAULT_WORKSPACE.panels) {
        addPanel(panel, { inactive: true });
      }
      const restoreId =
        previouslyActive !== undefined && event.api.getPanel(previouslyActive) !== undefined
          ? previouslyActive
          : 'monitor';
      event.api.getPanel(restoreId)?.api.setActive();
    }

    event.api.onDidLayoutChange(() => {
      window.localStorage.setItem(layoutKey, JSON.stringify(event.api.toJSON()));
    });
  }, []);

  function Panel({ api }: IDockviewPanelProps) {
    const context = useContext(EditorPanelContext);
    if (context === undefined) throw new Error('editor panel context is unavailable');
    const { state, visualProject, controlPlaneProject, updateVisualProperty } = context;
    if (api.id === 'inspector') {
      const objectId = state.selectedIds.flatMap((clipId) => TIMELINE_OBJECT_IDS[clipId] ?? [])[0];
      const object = objectId === undefined ? undefined : visualProject.visualObjects[objectId];
      return (
        <InspectorPanel
          object={object}
          allObjects={visualProject.visualObjects}
          playheadUs={state.playheadUs}
          onSetStatic={updateVisualProperty}
          onDispatch={context.dispatchProject}
        />
      );
    }
    if (api.id === 'motion') {
      const objectId = state.selectedIds.flatMap((clipId) => TIMELINE_OBJECT_IDS[clipId] ?? [])[0];
      const object = objectId === undefined ? undefined : visualProject.visualObjects[objectId];
      return (
        <MotionPanel
          object={object}
          allObjects={visualProject.visualObjects}
          compositionDurationUs={context.timelineProject.compositions.root?.durationUs ?? 30_000_000}
          playheadUs={state.playheadUs}
          onSeek={context.seek}
          onDispatch={context.dispatchProject}
        />
      );
    }
    if (api.id === 'camera') {
      const composition = visualProject.compositions[visualProject.rootCompositionId];
      if (composition === undefined) return <p>No root composition.</p>;
      return (
        <CameraPanel
          allObjects={visualProject.visualObjects}
          composition={composition}
          onDispatch={context.dispatchProject}
        />
      );
    }
    if (api.id === 'audio') {
      const clipIds =
        context.timelineProject.compositions.root?.tracks.flatMap((track) =>
          track.clips.map((clip) => clip.id),
        ) ?? [];
      return (
        <AudioPanel
          clipIds={clipIds}
          audioState={context.audioState}
          onAudioChange={(next) => context.setAudioState(next)}
        />
      );
    }
    if (api.id === 'effects') {
      const objectId = state.selectedIds.flatMap((clipId) => TIMELINE_OBJECT_IDS[clipId] ?? [])[0];
      return (
        <EffectsPanel
          project={visualProject}
          objectId={objectId}
          onChange={context.replaceVisualProject}
        />
      );
    }
    if (api.id === 'transitions') {
      return (
        <TransitionsPanel
          project={visualProject}
          selectedClipIds={state.selectedIds}
          onAddTransition={(t) =>
            context.replaceVisualProject({
              ...visualProject,
              transitions: [...(visualProject.transitions ?? []), { ...t, id: `transition-${Date.now()}` }],
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
        />
      );
    }
    if (api.id === 'color')
      return <ColorPanel project={visualProject} onChange={context.replaceVisualProject} />;
    if (api.id === 'captions')
      return (
        <CaptionsPanel
          project={visualProject}
          playheadUs={state.playheadUs}
          onSeek={context.seek}
          onDispatch={context.dispatchProject}
          onTranscribe={context.transcribe}
          transcriptionError={context.transcriptionError}
        />
      );
    if (api.id === 'timeline')
      return (
        <TimelinePanel
          project={context.timelineProject}
          playheadUs={state.playheadUs}
          playing={state.playing}
          selectedIds={state.selectedIds}
          markers={visualProject.markers}
          onTogglePlayback={context.togglePlayback}
          onSeek={context.seek}
          onToggleSelection={context.toggleSelection}
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
                      color: '#e9b949',
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
        />
      );
    if (api.id === 'jobs')
      return (
        <JobsPanel
          projectId={controlPlaneProject.controlPlaneProjectId}
          projectTitle={controlPlaneProject.title}
        />
      );
    if (api.id === 'media')
      return <AssetLibraryPanel projectId={controlPlaneProject.controlPlaneProjectId} />;
    if (api.id === 'agent') {
      return (
        <AgentPanel
          project={context.timelineProject}
          selectedClipIds={state.selectedIds}
          playheadUs={state.playheadUs}
          agentContext={context.agentContext}
          onUndo={context.undo}
          session={session}
        />
      );
    }
    if (api.id === 'history') {
      return (
        <HistoryPanel
          entries={context.historyEntries}
          canUndo={context.canUndo}
          canRedo={context.canRedo}
          onUndo={context.undo}
          onRedo={context.redo}
        />
      );
    }
    if (api.id === 'diagnostics')
      return (
        <article>
          <p>{context.playback.quality} proxy preview</p>
          <p>
            {context.playback.decodedFrames} decoded / {context.playback.droppedFrames} dropped frames
          </p>
          <p>Maximum media drift: {context.playback.maxDriftUs} µs</p>
        </article>
      );
    if (api.id === 'monitor') return <MonitorPanel />;
    if (api.id === 'workflows') {
      return (
        <WorkflowsPanel
          session={session}
          selectedClipIds={state.selectedIds}
          playheadUs={state.playheadUs}
          onRun={async (workflowId, inputs) => {
            try {
              const outcome = await runWorkflow(session, workflowId, inputs);
              setRevision((revision) => revision + 1);
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
              const outcome = await resumeWorkflow(session, runId, humanInputs);
              setRevision((revision) => revision + 1);
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
      return (
        <PluginsPanel
          pluginHost={pluginHost}
          onChange={() => setPluginRevision((revision) => revision + 1)}
        />
      );
    }
    return (
      <article>
        <p>{`${panelLabel(api.id)} panel`}</p>
      </article>
    );
  }

  return (
    <main>
      <header>
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
        <strong>JOY Media</strong>
        <span className="header-status">
          {session.visualProject.title} · Saved locally · {scheduler.current.metrics.quality} preview
        </span>
        <button
          className="icon-button"
          onClick={onBackToLibrary}
          aria-label="Back to projects"
          title="Projects library"
        >
          <ProjectsIcon />
        </button>
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
        <div className="preset-icon-group" role="group" aria-label="Export preset">
          {(
            [
              ['social-h264-aac', ExportIcon, 'Social H.264'],
              ['reels-1080', ReelsIcon, 'Reels 1080×1920'],
              ['shorts-1080', ReelsIcon, 'Shorts 1080×1920'],
              ['youtube-1080', YoutubeIcon, 'YouTube 1920×1080'],
              ['high-bitrate', HighBitrateIcon, 'High bitrate'],
            ] as const
          ).map(([id, Icon, label]) => (
            <button
              key={id}
              type="button"
              className="icon-button"
              disabled={exporting}
              aria-pressed={exportPreset === id}
              aria-label={label}
              title={label}
              data-guide={label}
              onClick={() => setExportPreset(id)}
            >
              <Icon />
            </button>
          ))}
        </div>
        <button
          className="icon-button"
          onClick={handleExport}
          disabled={exporting}
          aria-label="Export MP4"
          title={exporting ? 'Exporting…' : 'Export MP4'}
          data-guide={exporting ? 'Exporting…' : 'Export MP4'}
          aria-busy={exporting}
        >
          <ExportIcon />
        </button>
        <div className="header-menu">
          <button
            className="icon-button"
            aria-label="Recent processes"
            aria-expanded={processesOpen}
            title="Recent processes"
            onClick={() => {
              setProcessesOpen((open) => !open);
              setAccountOpen(false);
            }}
          >
            <ListIcon />
          </button>
          {processesOpen && (
            <section className="header-dropdown" aria-label="Recent processes">
              <h3>Recent processes</h3>
              {exportHistory.length === 0 ? (
                <p className="empty-hint">No exports yet. Use Export to encode an MP4.</p>
              ) : (
                <ul className="process-list">
                  {exportHistory.map((entry) => (
                    <li key={entry.id} className={`process-row process-${entry.status}`}>
                      <span className="process-dot" aria-hidden="true" />
                      <span className="process-name" dir="ltr">
                        {entry.filename}
                      </span>
                      <span className="process-meta">
                        {entry.status === 'completed' && entry.totalBytes !== undefined
                          ? `${(entry.totalBytes / 1_048_576).toFixed(1)} MB`
                          : entry.status === 'failed'
                            ? (entry.error ?? 'failed')
                            : 'encoding…'}
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
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
        <div className="header-menu">
          <button
            className="icon-button"
            aria-label="JOY account"
            aria-expanded={accountOpen}
            title={
              joySession.kind === 'ready'
                ? `Signed in · JOY account ${joySession.subject ?? ''}`
                : joySession.kind === 'no-access'
                  ? 'Signed in, JOY Media access not enabled'
                  : joySession.kind === 'signed-out'
                    ? 'Signed out'
                    : 'JOY account'
            }
            onClick={() => {
              setAccountOpen((open) => !open);
              setProcessesOpen(false);
              refreshJoySession();
            }}
          >
            <UserIcon />
            <span
              className={`session-dot session-${joySession.kind}`}
              aria-hidden="true"
            />
          </button>
          {accountOpen && (
            <section className="header-dropdown" aria-label="JOY account">
              <h3>JOY account</h3>
              {joySession.kind === 'ready' && (
                <>
                  <p>Signed in{joySession.subject !== undefined && ` · account ${joySession.subject}`}</p>
                  <button
                    className="icon-button icon-button-labeled"
                    title="Sign out of the shared JOY session"
                    onClick={() => void signOut()}
                  >
                    <LogoutIcon />
                    Sign out
                  </button>
                </>
              )}
              {joySession.kind === 'no-access' && (
                <p className="empty-hint">{joySession.message}</p>
              )}
              {joySession.kind === 'signed-out' && (
                <>
                  <p className="empty-hint">
                    Not signed in (expected without a JOY session cookie). Sign in with your JOY
                    account; this editor uses the shared JOY session. Live Whisper/TTS APIs require
                    an entitled signed-in session.
                  </p>
                  <a
                    className="icon-button icon-button-labeled"
                    href={JOY_LOGIN_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Opens joyteam.ir sign-in in a new tab; reopen this menu afterwards"
                  >
                    <UserIcon />
                    Sign in at joyteam.ir
                  </a>
                </>
              )}
              {joySession.kind === 'unknown' && <p className="empty-hint">Checking session…</p>}
            </section>
          )}
        </div>
      </header>
      {paletteOpen && (
        <section className="palette" aria-label="Command palette">
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
          timelineProject: session.timelineProject,
          visualProject: session.visualProject,
          controlPlaneProject,
          playback: scheduler.current.metrics,
          canUndo: session.canUndo,
          canRedo: session.canRedo,
          historyEntries: session.historyEntries,
          togglePlayback,
          seek,
          toggleSelection: (id) =>
            setState((current) => ({
              ...current,
              selectedIds: toggleSelection({ clipIds: current.selectedIds }, id).clipIds,
            })),
          dispatchTimeline,
          updateVisualProperty,
          dispatchProject,
          replaceVisualProject,
          audioState,
          setAudioState,
          transcribe,
          transcriptionError,
          undo,
          redo,
          agentContext,
        }}
      >
        <DockviewReact
          className="workspace"
          components={{ 'editor-panel': Panel }}
          defaultTabComponent={PanelTab}
          onReady={onReady}
        />
      </EditorPanelContext.Provider>
    </main>
  );
}

function MonitorPanel() {
  const context = useContext(EditorPanelContext);
  if (context === undefined) throw new Error('editor panel context is unavailable');
  const { state, previewVideoFrame, visualProject } = context;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<BrowserPixiRenderer | null>(null);
  const paintRef = useRef<() => void>(() => {});
  const sceneCacheRef = useRef(new HtmlSceneSurfaceCache());
  const [sceneTick, setSceneTick] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);

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
      const visualFrame = buildRenderFrameIR(
        composition.id,
        state.playheadUs,
        composition.width,
        composition.height,
        resolved,
        visualProject.transitions,
      );
    const frame =
      previewVideoFrame === undefined
        ? visualFrame
        : withVideoFrameNode(visualFrame, previewVideoFrame.node);
    const videoBitmaps = new Map(
      previewVideoFrame === undefined
        ? []
        : [[previewVideoFrame.node.id, previewVideoFrame.bitmap] as const],
    );
    for (const [id, bitmap] of sceneCacheRef.current.bitmaps()) {
      videoBitmaps.set(id, bitmap);
    }
    renderer.render(frame, videoBitmaps);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let disposed = false;
    createBrowserPixiRenderer({ parent: container })
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
  }, [previewVideoFrame, state.playheadUs, visualProject, sceneTick]);

  return (
    <article className="monitor-panel">
      {error !== undefined && <p className="monitor-error">{error}</p>}
      <div ref={containerRef} className="monitor-canvas" />
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
