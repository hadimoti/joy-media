import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { DockviewReact } from 'dockview';
import type { DockviewReadyEvent, IDockviewPanelProps } from 'dockview';
import { EMPTY_EDITOR_STATE, searchActions } from './editor-state.js';
import { toggleSelection } from '@joy-media/timeline-engine';
import { TRANSFORM_INSPECTOR } from './inspector.js';
import { INITIAL_EDITOR_PROJECT, TIMELINE_OBJECT_IDS } from './editor-project.js';
import { applyVisualObjectProjectTransaction } from '@joy-media/property-system';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { TimelinePanel } from './TimelinePanel.js';
import { DEFAULT_WORKSPACE } from './workspace.js';
import './app.css';
import 'dockview/dist/styles/dockview.css';

const labels: Readonly<Record<string, string>> = {
  media: 'Media',
  monitor: 'Program Monitor',
  timeline: 'Timeline',
  inspector: 'Inspector',
  history: 'History',
  diagnostics: 'Diagnostics',
};

interface EditorPanelContextValue {
  readonly state: typeof EMPTY_EDITOR_STATE;
  readonly project: JoyProjectV1;
  readonly advance: () => void;
  readonly toggleSelection: (id: string) => void;
  readonly updateVisualProperty: (
    objectId: string,
    key: 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotationDeg' | 'opacity',
    value: number,
  ) => void;
}
const EditorPanelContext = createContext<EditorPanelContextValue | undefined>(undefined);

export function App() {
  const [state, setState] = useState(EMPTY_EDITOR_STATE);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState('');
  const project = useRef(INITIAL_EDITOR_PROJECT);
  const [, setProjectRevision] = useState(0);
  const updateVisualProperty = useCallback(
    (
      objectId: string,
      key: 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotationDeg' | 'opacity',
      value: number,
    ) => {
      project.current = applyVisualObjectProjectTransaction(project.current, {
        label: `Set ${key}`,
        commands: [{ type: 'object.setTransformProperty', payload: { objectId, key, value } }],
      });
      setProjectRevision((revision) => revision + 1);
    },
    [],
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
    if (event.api.totalPanels > 0) return;
    for (const panel of DEFAULT_WORKSPACE.panels)
      event.api.addPanel({ id: panel, component: 'editor-panel', title: labels[panel] ?? panel });
  }, []);
  return (
    <main>
      <header>
        <strong>JOY Media</strong>
        <span>Saved locally</span>
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
            <button key={action.id} onClick={() => setPaletteOpen(false)}>
              {action.title}
              <kbd>{action.shortcut}</kbd>
            </button>
          ))}
        </section>
      )}
      <EditorPanelContext.Provider
        value={{
          state,
          project: project.current,
          advance: () =>
            setState((current) => ({ ...current, playheadUs: current.playheadUs + 1_000_000 })),
          toggleSelection: (id) =>
            setState((current) => ({
              ...current,
              ...toggleSelection({ clipIds: current.selectedIds }, id),
            })),
          updateVisualProperty,
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
  const { state, advance, project, updateVisualProperty } = context;
  if (api.id === 'inspector') {
    const objectId = state.selectedIds.flatMap((clipId) => TIMELINE_OBJECT_IDS[clipId] ?? [])[0];
    const object = objectId === undefined ? undefined : project.visualObjects[objectId];
    return (
      <article>
        <p>{object === undefined ? 'Select a visual clip to edit.' : `Editing ${object.id}`}</p>
        {object !== undefined &&
          TRANSFORM_INSPECTOR.filter((property) => property.kind === 'number').map((property) => (
            <label key={property.key}>
              {property.label}
              <input
                type="number"
                min={property.min}
                max={property.max}
                value={object.transform[property.key as Exclude<typeof property.key, 'crop'>]}
                onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber;
                  if (Number.isFinite(value))
                    updateVisualProperty(
                      object.id,
                      property.key as 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotationDeg' | 'opacity',
                      value,
                    );
                }}
              />
            </label>
          ))}
      </article>
    );
  }
  if (api.id === 'timeline')
    return (
      <TimelinePanel
        playheadUs={state.playheadUs}
        selectedIds={state.selectedIds}
        onAdvance={advance}
        onToggleSelection={context.toggleSelection}
      />
    );
  return (
    <article>
      <p>
        {api.id === 'history'
          ? 'Durable command history appears here.'
          : api.id === 'diagnostics'
            ? 'No diagnostics.'
            : `${labels[api.id] ?? api.id} panel`}
      </p>
    </article>
  );
}
