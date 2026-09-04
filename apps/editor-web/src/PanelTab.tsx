import type { IDockviewPanelHeaderProps } from 'dockview';
import { panelLabel, panelTabIconUrl, panelTabSvgIcon } from './panel-tab-icons.js';
import { useAgentPanelPresence } from './agent-presence.js';
import type { PanelId } from './workspace.js';

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
      {presence.active && (
        <span
          className="panel-tab-agent-marker"
          aria-label={presence.awaitingApproval ? 'Agent needs approval' : `Agent ${presence.phase}`}
          title={presence.awaitingApproval ? 'Agent needs approval' : `Agent ${presence.phase}`}
        >
          <span aria-hidden="true" />
        </span>
      )}
    </div>
  );
}
