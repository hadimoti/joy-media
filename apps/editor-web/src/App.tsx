import { useCallback, useState } from 'react';
import { DockviewReact } from 'dockview';
import type { DockviewReadyEvent, IDockviewPanelProps } from 'dockview';
import { EMPTY_EDITOR_STATE, searchActions } from './editor-state.js';
import { TRANSFORM_INSPECTOR } from './inspector.js';
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

export function App() {
  const [state, setState] = useState(EMPTY_EDITOR_STATE);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState('');
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
      <DockviewReact
        className="workspace"
        components={{
          'editor-panel': (props) => (
            <Panel
              {...props}
              state={state}
              advance={() => setState({ ...state, playheadUs: state.playheadUs + 1_000_000 })}
            />
          ),
        }}
        onReady={onReady}
      />
    </main>
  );
}

function Panel({
  params,
  state,
  advance,
}: IDockviewPanelProps & { state: typeof EMPTY_EDITOR_STATE; advance: () => void }) {
  if (params.id === 'inspector')
    return (
      <article>
        {TRANSFORM_INSPECTOR.map((property) => (
          <label key={property.key}>
            {property.label}
            <input
              type="number"
              min={property.min}
              max={property.max}
              defaultValue={property.key === 'opacity' ? 1 : 0}
            />
          </label>
        ))}
      </article>
    );
  if (params.id === 'timeline')
    return (
      <article>
        <button onClick={advance}>Advance playhead</button>
        <p>
          {state.playheadUs} µs · {state.selectedIds.length} selected
        </p>
      </article>
    );
  return (
    <article>
      <p>
        {params.id === 'history'
          ? 'Durable command history appears here.'
          : params.id === 'diagnostics'
            ? 'No diagnostics.'
            : `${labels[params.id] ?? params.id} panel`}
      </p>
    </article>
  );
}
