import type { HistoryEntry } from './editor-session.js';
import { RedoIcon, UndoIcon } from './icons.js';

interface HistoryPanelProps {
  readonly entries: readonly HistoryEntry[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}

export function HistoryPanel({ entries, canUndo, canRedo, onUndo, onRedo }: HistoryPanelProps) {
  const undoEntries = entries
    .filter((e) => e.direction === 'undo')
    .sort((a, b) => b.sequence - a.sequence);
  const redoEntries = entries
    .filter((e) => e.direction === 'redo')
    .sort((a, b) => b.sequence - a.sequence);

  return (
    <article className="history-panel">
      <div className="history-controls">
        <button
          className="icon-button"
          disabled={!canUndo}
          onClick={onUndo}
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
        >
          <UndoIcon />
        </button>
        <button
          className="icon-button"
          disabled={!canRedo}
          onClick={onRedo}
          aria-label="Redo"
          title="Redo (Ctrl+Y)"
        >
          <RedoIcon />
        </button>
      </div>

      <section className="history-section">
        <h3>Undo stack</h3>
        {undoEntries.length === 0 ? (
          <p className="history-empty">No history yet</p>
        ) : (
          <ul className="history-list">
            {undoEntries.map((entry) => (
              <HistoryEntryRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </section>

      <section className="history-section">
        <h3>Redo stack</h3>
        {redoEntries.length === 0 ? (
          <p className="history-empty">No history yet</p>
        ) : (
          <ul className="history-list">
            {redoEntries.map((entry) => (
              <HistoryEntryRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

function HistoryEntryRow({ entry }: { readonly entry: HistoryEntry }) {
  const badgeClass =
    entry.source === 'timeline'
      ? 'history-entry-badge history-entry-badge-timeline'
      : 'history-entry-badge history-entry-badge-visual-object';

  const rowClass =
    entry.direction === 'redo' ? 'history-entry history-entry-redo' : 'history-entry';

  return (
    <li className={rowClass}>
      <span className="history-entry-label">{entry.label}</span>
      <span className={badgeClass}>{entry.source}</span>
      <span className="history-entry-count">{entry.commandCount} cmd</span>
    </li>
  );
}
