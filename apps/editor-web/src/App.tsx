import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { DockviewReact } from 'dockview';
import type { DockviewReadyEvent, IDockviewPanelProps } from 'dockview';
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
import { toggleSelection } from '@joy-media/timeline-engine';
import type { CommandTransaction } from '@joy-media/commands';
import type {
  JoyProjectV1,
  SpikeProject,
  VideoClip,
  VisualObjectV1,
} from '@joy-media/project-schema';
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
import { EMPTY_EDITOR_STATE, searchActions } from './editor-state.js';
import { INITIAL_EDITOR_PROJECT, TIMELINE_OBJECT_IDS } from './editor-project.js';
import { EditorSession } from './editor-session.js';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { TimelinePanel } from './TimelinePanel.js';
import { CaptionsPanel } from './CaptionsPanel.js';
import { InspectorPanel } from './InspectorPanel.js';
import { MotionPanel } from './MotionPanel.js';
import { CameraPanel } from './CameraPanel.js';
import { JobsPanel } from './JobsPanel.js';
import { transcribeReferenceCaption } from './local-transcription.js';
import { DEFAULT_WORKSPACE } from './workspace.js';
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

const labels: Readonly<Record<string, string>> = {
  media: 'Media',
  monitor: 'Program Monitor',
  timeline: 'Timeline',
  captions: 'Captions',
  inspector: 'Inspector',
  motion: 'Motion',
  camera: 'Camera',
  history: 'History',
  diagnostics: 'Diagnostics',
  jobs: 'Jobs',
};

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
  readonly playback: PlaybackScheduler['metrics'];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
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
  readonly transcribe: (documentId: string, language: 'fa-IR' | 'en-US') => Promise<void>;
  readonly transcriptionError: string | undefined;
  readonly undo: () => void;
  readonly redo: () => void;
}
const EditorPanelContext = createContext<EditorPanelContextValue | undefined>(undefined);

export function App() {
  const [state, setState] = useState<EditorRuntimeState>({ ...EMPTY_EDITOR_STATE, playing: false });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [transcriptionError, setTranscriptionError] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | undefined>(undefined);
  const [previewVideoFrame, setPreviewVideoFrame] = useState<DecodedPreviewFrame | undefined>(
    undefined,
  );
  const [, setRevision] = useState(0);
  const sessionRef = useRef<EditorSession | null>(null);
  const scheduler = useRef(new PlaybackScheduler());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const decoderRef = useRef<HtmlMediaDecoder | null>(null);
  const clockRef = useRef<MediaClock | null>(null);
  if (sessionRef.current === null)
    sessionRef.current = new EditorSession(
      window.localStorage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
  const session = sessionRef.current;
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastMediaTimeUsRef = useRef<number | undefined>(undefined);
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
      const sourceTimeUs = playheadUs - clip.startUs + clip.sourceInUs;
      video.currentTime = sourceTimeUs / 1_000_000;
      scheduler.current.seek(sourceTimeUs);
      lastMediaTimeUsRef.current = undefined;
      if (play) await video.play();
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
      const sourceTimeUs = clock.timeUs;
      const compositionTimeUs = clip.startUs + sourceTimeUs - clip.sourceInUs;
      if (compositionTimeUs >= clip.startUs + clip.durationUs) {
        const nextPlayheadUs = clip.startUs + clip.durationUs;
        const durationUs = session.timelineProject.compositions.root?.durationUs ?? nextPlayheadUs;
        if (nextPlayheadUs >= durationUs) {
          video.pause();
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
      const clipSpec: VideoClipSpec = {
        id: clip.assetId,
        originalToken: resolveReferenceMediaUrl(clip.assetId),
        startUs: clip.startUs,
        durationUs: clip.durationUs,
        sourceInUs: clip.sourceInUs,
        transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
        opacity: 1,
        zIndex: 0,
      };
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
      // Real decoded-video callback when available; unlike a UI animation
      // ticker it follows the browser's media presentation cadence and stays
      // meaningful when editor panels are switched or the UI is quiet.
      if (typeof video.requestVideoFrameCallback === 'function')
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
  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setExportStatus('Building render manifest…');
    try {
      const compositionV1 =
        session.visualProject.compositions[session.visualProject.rootCompositionId];
      const width = compositionV1?.width ?? 1920;
      const height = compositionV1?.height ?? 1080;
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
        return buildRenderFrameIR(compositionV1?.id ?? 'root', timeUs, width, height, resolved);
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
          const audio = await audioContext.decodeAudioData(await audioResponse.arrayBuffer());
          return {
            clip,
            video,
            decoder: createHtmlMediaDecoder(video, captureCanvas),
            audio,
          };
        }),
      );
      const mediaForClip = new Map(exportMedia.map((media) => [media.clip.id, media]));
      const exportAudioTrack = audioDestination.stream.getAudioTracks()[0];
      if (exportAudioTrack === undefined)
        throw new Error('Export audio mix did not produce a track');
      const renderer = await createBrowserPixiRenderer({ width, height, resolution: 1 });
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
              audioSource.buffer = media.audio;
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
            renderer.render(
              withVideoFrameNode(buildFrame(timeUs), node),
              new Map([[node.id, decoded.bitmap]]),
            );
          },
          onProgress: (completed, total) => {
            if (completed === total || completed % frameRate === 0)
              setExportStatus(
                `Encoding preview-equivalent H.264/AAC… ${completed}/${total} frames`,
              );
          },
          filename: `joy-media-export-${Date.now()}.mp4`,
        });
        setExportStatus(
          `Exported ${exportResult.filename} (${width}×${height}, ${exportResult.frameCount} frames, ${exportResult.totalBytes} bytes; preview-equivalent H.264/AAC MP4).`,
        );
      } finally {
        for (const timer of startTimers) window.clearTimeout(timer);
        for (const source of audioSources) source.stop();
        for (const media of exportMedia) media.video.pause();
        renderer.destroy();
        await audioContext.close();
      }
    } catch (error) {
      setExportStatus(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExporting(false);
    }
  }, [exporting, session]);
  const onReady = useCallback((event: DockviewReadyEvent) => {
    const saved = window.localStorage.getItem('joy-media.dockview.v1');
    if (saved !== null) {
      try {
        event.api.fromJSON(JSON.parse(saved), { reuseExistingPanels: false });
      } catch {
        window.localStorage.removeItem('joy-media.dockview.v1');
      }
    }
    event.api.onDidLayoutChange(() => {
      window.localStorage.setItem('joy-media.dockview.v1', JSON.stringify(event.api.toJSON()));
    });
    // Add any default panel a saved layout predates (e.g. Captions from P03).
    for (const panel of DEFAULT_WORKSPACE.panels)
      if (event.api.getPanel(panel) === undefined)
        event.api.addPanel({ id: panel, component: 'editor-panel', title: labels[panel] ?? panel });
  }, []);
  return (
    <main>
      <header>
        <strong>JOY Media</strong>
        <span>Saved locally · {scheduler.current.metrics.quality} preview</span>
        <button disabled={!session.canUndo} onClick={undo}>
          Undo
        </button>
        <button disabled={!session.canRedo} onClick={redo}>
          Redo
        </button>
        <button onClick={() => setPaletteOpen(true)}>Commands ⌘K</button>
        <button onClick={handleExport} disabled={exporting}>
          {exporting ? 'Exporting…' : 'Export'}
        </button>
        {exportStatus !== undefined && (
          <span className="export-status" aria-live="polite">
            {exportStatus}
          </span>
        )}
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
      <video ref={videoRef} className="playback-media" playsInline />
      <EditorPanelContext.Provider
        value={{
          state,
          previewVideoFrame,
          timelineProject: session.timelineProject,
          visualProject: session.visualProject,
          playback: scheduler.current.metrics,
          canUndo: session.canUndo,
          canRedo: session.canRedo,
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
          transcribe,
          transcriptionError,
          undo,
          redo,
        }}
      >
        <DockviewReact
          className="workspace"
          components={{ 'editor-panel': Panel }}
          onReady={onReady}
        />
      </EditorPanelContext.Provider>
    </main>
  );
}

function Panel({ api }: IDockviewPanelProps) {
  const context = useContext(EditorPanelContext);
  if (context === undefined) throw new Error('editor panel context is unavailable');
  const { state, visualProject, updateVisualProperty } = context;
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
        onTogglePlayback={context.togglePlayback}
        onSeek={context.seek}
        onToggleSelection={context.toggleSelection}
        onDispatch={context.dispatchTimeline}
      />
    );
  if (api.id === 'jobs')
    return <JobsPanel projectId={visualProject.id} projectTitle={visualProject.title} />;
  if (api.id === 'history')
    return (
      <article>
        <p>Durable local command history</p>
        <button disabled={!context.canUndo} onClick={context.undo}>
          Undo
        </button>
        <button disabled={!context.canRedo} onClick={context.redo}>
          Redo
        </button>
      </article>
    );
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
  return (
    <article>
      <p>
        {api.id === 'media'
          ? 'Reference media proxies are ready.'
          : `${labels[api.id] ?? api.id} panel`}
      </p>
    </article>
  );
}

function MonitorPanel() {
  const context = useContext(EditorPanelContext);
  if (context === undefined) throw new Error('editor panel context is unavailable');
  const { state, previewVideoFrame, visualProject } = context;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<BrowserPixiRenderer | null>(null);
  const paintRef = useRef<() => void>(() => {});
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
    );
    const frame =
      previewVideoFrame === undefined
        ? visualFrame
        : withVideoFrameNode(visualFrame, previewVideoFrame.node);
    const videoBitmaps =
      previewVideoFrame === undefined
        ? undefined
        : new Map([[previewVideoFrame.node.id, previewVideoFrame.bitmap]]);
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
    paintRef.current();
  }, [previewVideoFrame, state.playheadUs, visualProject]);

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
