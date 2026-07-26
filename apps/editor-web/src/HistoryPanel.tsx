/**
 * Photoshop-style history: one linear list of restore points. Click a row to
 * jump there. Undo/redo chrome stays in the app header / menubar — not here.
 */

import type { HistoryEntry } from './editor-session.js';
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';

interface HistoryPanelProps {
  readonly entries: readonly HistoryEntry[];
  readonly onJumpTo: (sequence: number) => void;
}

export function HistoryPanel({ entries, onJumpTo }: HistoryPanelProps) {
  const isFresh =
    entries.length <= 1 && entries[0]?.sequence === 0 && entries[0]?.direction === 'current';

  return (
    <PanelShell
      title="History"
      iconUrl={panelTabIconUrl('history')}
      className="history-panel"
      {...(isFresh ? { note: 'No edits yet — restore points appear here.' } : {})}
    >
      <ol className="history-list" aria-label="History restore points">
        {entries.map((entry) => (
          <HistoryEntryRow key={entry.id} entry={entry} onJumpTo={onJumpTo} />
        ))}
      </ol>
    </PanelShell>
  );
}

function HistoryEntryRow({
  entry,
  onJumpTo,
}: {
  readonly entry: HistoryEntry;
  readonly onJumpTo: (sequence: number) => void;
}) {
  const isCurrent = entry.direction === 'current';
  const isFuture = entry.direction === 'redo';
  const badgeClass =
    entry.source === 'timeline'
      ? 'history-entry-badge history-entry-badge-timeline'
      : entry.source === 'visual-object'
        ? 'history-entry-badge history-entry-badge-visual-object'
        : 'history-entry-badge history-entry-badge-document';

  const rowClass = [
    'history-entry',
    isCurrent ? 'history-entry-current' : '',
    isFuture ? 'history-entry-future' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li>
      <button
        type="button"
        className={rowClass}
        aria-current={isCurrent ? 'step' : undefined}
        aria-label={
          isCurrent
            ? `Current state: ${entry.label}`
            : `Restore to: ${entry.label}`
        }
        title={isCurrent ? 'Current state' : `Restore to “${entry.label}”`}
        onClick={() => {
          if (!isCurrent) onJumpTo(entry.sequence);
        }}
      >
        <span className="history-entry-marker" aria-hidden="true" />
        <span className="history-entry-label">{entry.label}</span>
        {entry.source !== 'document' && (
          <span className={badgeClass}>{entry.source === 'timeline' ? 'timeline' : 'visual'}</span>
        )}
      </button>
    </li>
  );
}
