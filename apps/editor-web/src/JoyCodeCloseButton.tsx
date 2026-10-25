import type { IDockviewPanelProps } from 'dockview';
import { useAgentPanelPresence } from './agent-presence.js';
import type { PanelId } from './workspace.js';

/**
 * Closes the Joy Code panel from inside the panel. It is not part of the dock
 * tab, because a control inside a tab is a nested interactive control. It is
 * disabled while an agent run is active, so a run is never closed silently.
 */
export function JoyCodeCloseButton({ api }: Pick<IDockviewPanelProps, 'api'>) {
  const presence = useAgentPanelPresence(api.id as PanelId);
  return (
    <button
      type="button"
      className="joy-code-close"
      aria-label="Close Joy Code panel"
      title={presence.active ? 'Stop Joy Code before closing it' : 'Close Joy Code'}
      disabled={presence.active}
      onClick={() => api.close()}
    >
      <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" focusable="false">
        <path
          d="M3 3l10 10M13 3L3 13"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
