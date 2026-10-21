import type { IDockviewPanelHeaderProps } from 'dockview';
import { panelLabel, panelTabIconUrl, panelTabSvgIcon } from './panel-tab-icons.js';
import { useAgentPanelPresence } from './agent-presence.js';
import type { PanelId } from './workspace.js';

function CloseGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" focusable="false">
      <path
        d="M3 3l10 10M13 3L3 13"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Icon-only dock tab; the label becomes visible in Dockview's overflow menu. */
export function PanelTab({ api }: IDockviewPanelHeaderProps) {
  const label = panelLabel(api.id);
  const SvgIcon = panelTabSvgIcon(api.id);
  const iconUrl = panelTabIconUrl(api.id);
  const presence = useAgentPanelPresence(api.id as PanelId);

  return (
    <div
      className={`panel-tab${presence.active ? ' is-agent-active' : ''}${presence.awaitingApproval ? ' is-agent-awaiting' : ''}`}
      title={label}
      aria-label={label}
      data-agent-active={presence.active ? 'true' : undefined}
      data-agent-phase={presence.active ? presence.phase : undefined}
    >
      {SvgIcon !== undefined ? (
        <span className="panel-tab-svg" aria-hidden>
          <SvgIcon />
        </span>
      ) : iconUrl !== undefined ? (
        <span
          className="panel-tab-icon"
          style={{
            WebkitMaskImage: `url(${iconUrl})`,
            maskImage: `url(${iconUrl})`,
          }}
          aria-hidden
        />
      ) : (
        <span className="panel-tab-fallback">{label}</span>
      )}
      <span className="panel-tab-label">{label}</span>
      {api.id === 'agent' && (
        <button
          type="button"
          className="panel-tab-close"
          aria-label="Close Joy Code panel"
          title={presence.active ? 'Stop Joy Code before closing it' : 'Close Joy Code'}
          disabled={presence.active}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            api.close();
          }}
        >
          <CloseGlyph />
        </button>
      )}
      {presence.active && (
        <span
          className="panel-tab-agent-marker"
          aria-label={
            presence.awaitingApproval ? 'Agent needs approval' : `Agent ${presence.phase}`
          }
          title={presence.awaitingApproval ? 'Agent needs approval' : `Agent ${presence.phase}`}
        >
          <span aria-hidden="true" />
        </span>
      )}
    </div>
  );
}
