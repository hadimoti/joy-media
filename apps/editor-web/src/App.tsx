import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { DockviewReact } from 'dockview';
import type { DockviewReadyEvent, IDockviewPanelProps } from 'dockview';
import { PlaybackScheduler } from '@joy-media/playback-engine';
import { toggleSelection } from '@joy-media/timeline-engine';
import type { CommandTransaction } from '@joy-media/commands';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import { EMPTY_EDITOR_STATE, searchActions } from './editor-state.js';
import { INITIAL_EDITOR_PROJECT, TIMELINE_OBJECT_IDS } from './editor-project.js';
import { EditorSession } from './editor-session.js';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { TimelinePanel } from './TimelinePanel.js';
import { CaptionsPanel } from './CaptionsPanel.js';
import { InspectorPanel } from './InspectorPanel.js';
import { MotionPanel } from './MotionPanel.js';
import { transcribeReferenceCaption } from './local-transcription.js';
import { DEFAULT_WORKSPACE } from './workspace.js';
import './app.css';
import 'dockview/dist/styles/dockview.css';

const labels: Readonly<Record<string, string>> = {
  media: 'Media',
  monitor: 'Program Monitor',
  timeline: 'Timeline',
  captions: 'Captions',
  inspector: 'Inspector',
  motion: 'Motion',
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

export function App() {
  const [state, setState] = useState<EditorRuntimeState>({ ...EMPTY_EDITOR_STATE, playing: false });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [transcriptionError, setTranscriptionError] = useState<string>();
  const [, setRevision] = useState(0);
  const sessionRef = useRef<EditorSession | null>(null);
  const scheduler = useRef(new PlaybackScheduler());
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
    setState((current) => {
      const durationUs =
        session.timelineProject.compositions.root?.durationUs ?? current.playheadUs;
      const nextPlayhead = Math.min(durationUs, current.playheadUs + 250_000);
      scheduler.current.seek(nextPlayhead);
      const token = scheduler.current.requestToken();
      scheduler.current.acceptFrame(token, true);
      return { ...current, playheadUs: nextPlayhead, playing: nextPlayhead < durationUs };
    });
    setRevision((revision) => revision + 1);
  }, [session]);
  useEffect(() => {
    if (!state.playing) return;
    const timer = window.setInterval(advancePlayback, 250);
    return () => window.clearInterval(timer);
  }, [advancePlayback, state.playing]);
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
