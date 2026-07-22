import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { DockviewReact } from 'dockview';
import type { DockviewReadyEvent, IDockviewPanelProps } from 'dockview';
import {
  createHtmlMediaDecoder,
  createHtmlVideoMediaClock,
  importedClipToMediaSource,
  PlaybackScheduler,
  videoFrameNodeFromDecoded,
  withVideoFrameNode,
  type FrameDecoder,
  type MediaClock,
  type VideoClipSpec,
} from '@joy-media/playback-engine';
import { toggleSelection } from '@joy-media/timeline-engine';
import type { CommandTransaction } from '@joy-media/commands';
import type { JoyProjectV1, SpikeProject, VisualObjectV1 } from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import { evaluateCameraExpressionTransform } from '@joy-media/evaluator';
import { buildRenderFrameIR, type ResolvedObject } from '@joy-media/visual-object-renderer';
import {
  createBrowserPixiRenderer,
  type BrowserPixiRenderer,
} from '@joy-media/renderer-pixi/browser';
import { renderHeadlessFrame } from '@joy-media/renderer-headless';
import {
  downloadBrowserExport,
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
import { transcribeReferenceCaption } from './local-transcription.js';
import { DEFAULT_WORKSPACE } from './workspace.js';
import './app.css';
import 'dockview/dist/styles/dockview.css';

/**
 * WP-11.2: resolves a timeline clip's assetId to a real, browser-fetchable
 * URL for HTMLVideoElement decode. Only `asset-intro` has a real fixture
 * committed (`public/media/reference/asset-intro.mp4`, generated via
 * `ffmpeg -f lavfi -i testsrc`); other reference-project asset ids will 404,
 * which the decoder already treats as a dropped frame, not a crash.
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
};

interface EditorRuntimeState {
  readonly selectedIds: readonly string[];
  readonly playheadUs: number;
  readonly playing: boolean;
}

interface EditorPanelContextValue {
  readonly state: EditorRuntimeState;
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
const EditorRefsContext = createContext<
  | {
      readonly videoRef: React.MutableRefObject<HTMLVideoElement | null>;
      readonly onMediaReady: (decoder: FrameDecoder, clock: MediaClock) => void;
    }
  | undefined
>(undefined);

export function App() {
  const [state, setState] = useState<EditorRuntimeState>({ ...EMPTY_EDITOR_STATE, playing: false });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [transcriptionError, setTranscriptionError] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | undefined>(undefined);
  const [, setRevision] = useState(0);
  const sessionRef = useRef<EditorSession | null>(null);
  const scheduler = useRef(new PlaybackScheduler());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const decoderRef = useRef<FrameDecoder | null>(null);
  const clockRef = useRef<MediaClock | null>(null);
  if (sessionRef.current === null)
    sessionRef.current = new EditorSession(
      window.localStorage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
  const session = sessionRef.current;
  const seek = useCallback((timeUs: number) => {
    scheduler.current.seek(timeUs);
    setState((current) => ({ ...current, playheadUs: timeUs }));
  }, []);
  const advancePlayback = useCallback(() => {
    const clock = clockRef.current;
    const decoder = decoderRef.current;
    const composition = session.timelineProject.compositions.root;
    const durationUs = composition?.durationUs ?? 0;
    if (clock === null || decoder === null) {
      setState((current) => {
        const nextPlayhead = Math.min(durationUs, current.playheadUs + 250_000);
        scheduler.current.seek(nextPlayhead);
        const token = scheduler.current.requestToken();
        scheduler.current.acceptFrame(token, true);
        return { ...current, playheadUs: nextPlayhead, playing: nextPlayhead < durationUs };
      });
      setRevision((revision) => revision + 1);
      return;
    }
    const playheadUs = clock.timeUs;
    const activeClip =
      composition === undefined
        ? undefined
        : composition.tracks
            .flatMap((t) => t.clips)
            .find(
              (c) =>
                c.kind === 'video' &&
                playheadUs >= c.startUs &&
                playheadUs < c.startUs + c.durationUs,
            );
    if (activeClip !== undefined && activeClip.kind === 'video' && composition !== undefined) {
      const clipSpec: VideoClipSpec = {
        id: activeClip.assetId,
        originalToken: resolveReferenceMediaUrl(activeClip.assetId),
        startUs: activeClip.startUs,
        durationUs: activeClip.durationUs,
        sourceInUs: activeClip.sourceInUs,
        transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
        opacity: 1,
        zIndex: 0,
      };
      const source = importedClipToMediaSource(clipSpec);
      const sourceTimeUs = playheadUs - activeClip.startUs + activeClip.sourceInUs;
      decoder
        .decode(source.originalToken, sourceTimeUs, scheduler.current.requestToken())
        .then((frame) => {
          const activeVideo = videoRef.current;
          const node = videoFrameNodeFromDecoded(clipSpec, frame, {
            // WP-11.2: no capture canvas is wired yet (frame.bitmap is always
            // undefined), so videoFrameNodeFromDecoded's own intrinsic-size
            // fallback is what's actually used. Without this, it defaults to
            // 0x0, which validateRenderFrameIR rejects — every decode was
            // silently counted as a dropped frame despite succeeding.
            width: activeVideo?.videoWidth ?? 0,
            height: activeVideo?.videoHeight ?? 0,
          });
          const compositionV1 =
            session.visualProject.compositions[session.visualProject.rootCompositionId];
          const width = compositionV1?.width ?? 1920;
          const height = compositionV1?.height ?? 1080;
          withVideoFrameNode(
            {
              version: 1,
              compositionId: compositionV1?.id ?? 'root',
              timeUs: playheadUs,
              viewport: { width, height, dpr: 1 },
              background: { r: 0, g: 0, b: 0, a: 0 },
              nodes: [],
            },
            node,
          );
          scheduler.current.driveTick(clock, true);
        })
        .catch(() => {
          scheduler.current.driveTick(clock, false);
        });
    } else {
      scheduler.current.driveTick(clock, false);
    }
    setState((current) => ({ ...current, playheadUs, playing: playheadUs < durationUs }));
    setRevision((revision) => revision + 1);
  }, [session]);
  useEffect(() => {
    if (!state.playing) return;
    const timer = window.setInterval(advancePlayback, 250);
    return () => window.clearInterval(timer);
  }, [advancePlayback, state.playing]);
  const handleMediaReady = useCallback((decoder: FrameDecoder, clock: MediaClock) => {
    decoderRef.current = decoder;
    clockRef.current = clock;
  }, []);
  const togglePlayback = useCallback(() => {
    setState((current) => ({ ...current, playing: !current.playing }));
  }, []);
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
      setExportStatus(`Rendering ${totalFrames} frames…`);
      const exportFrames: Uint8Array[] = [];
      const exportDigests: string[] = [];
      for (let index = 0; index < totalFrames; index++) {
        const timeUs = Math.floor((index * 1_000_000) / frameRate);
        const headless = renderHeadlessFrame(buildFrame(timeUs));
        exportFrames.push(headless.pixels);
        exportDigests.push(await sha256Hex(headless.pixels));
      }
      setExportStatus('Comparing preview↔export digests…');
      let mismatched = 0;
      for (let index = 0; index < totalFrames; index++) {
        const timeUs = Math.floor((index * 1_000_000) / frameRate);
        const previewDigest = await sha256Hex(renderHeadlessFrame(buildFrame(timeUs)).pixels);
        if (previewDigest !== exportDigests[index]) mismatched++;
      }
      if (mismatched > 0)
        throw new Error(`preview↔export digest mismatch on ${mismatched}/${totalFrames} frames`);
      setExportStatus('Packaging browser export…');
      const exportResult: BrowserExportResult = downloadBrowserExport({
        manifest: {
          width: manifest.width,
          height: manifest.height,
          frameRate: manifest.frameRate,
          durationUs: manifest.durationUs,
        },
        frames: exportFrames,
        filename: `joy-media-export-${Date.now()}.rgba`,
      });
      setExportStatus(
        `Exported ${exportResult.filename} (${width}×${height}, ${exportResult.frameCount} frames, ${exportResult.totalBytes} bytes; ffprobe skipped — browser cannot probe raw RGBA containers).`,
      );
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
      <EditorPanelContext.Provider
        value={{
          state,
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
        <EditorRefsContext.Provider value={{ videoRef, onMediaReady: handleMediaReady }}>
          <DockviewReact
            className="workspace"
            components={{ 'editor-panel': Panel }}
            onReady={onReady}
          />
        </EditorRefsContext.Provider>
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
  const refs = useContext(EditorRefsContext);
  if (context === undefined) throw new Error('editor panel context is unavailable');
  if (refs === undefined) throw new Error('editor refs context is unavailable');
  const { state, visualProject, timelineProject } = context;
  const { videoRef, onMediaReady } = refs;
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
    const frame = buildRenderFrameIR(
      composition.id,
      state.playheadUs,
      composition.width,
      composition.height,
      resolved,
    );
    renderer.render(frame);
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
    const video = videoRef.current;
    if (video === null) return;
    const decoder = createHtmlMediaDecoder(video);
    const clock = createHtmlVideoMediaClock(video);
    onMediaReady(decoder, clock);
    const firstClip = timelineProject.compositions.root?.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.kind === 'video');
    if (firstClip !== undefined && firstClip.kind === 'video') {
      video.src = resolveReferenceMediaUrl(firstClip.assetId);
    }
  }, [onMediaReady, timelineProject, videoRef]);

  useEffect(() => {
    paintRef.current();
  }, [state.playheadUs, visualProject]);

  return (
    <article className="monitor-panel">
      {error !== undefined && <p className="monitor-error">{error}</p>}
      <video ref={videoRef} muted playsInline style={{ display: 'none' }} />
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
