import type { IDockviewPanelHeaderProps } from 'dockview';
import { panelLabel, panelTabIconUrl } from './panel-tab-icons.js';

/** Icon-only dockview tab; label stays on title/aria for hover and a11y. */
export function PanelTab({ api }: IDockviewPanelHeaderProps) {
  const label = panelLabel(api.id);
  const iconUrl = panelTabIconUrl(api.id);

  return (
    <div className="panel-tab" title={label} aria-label={label}>
      {iconUrl !== undefined ? (
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
    </div>
  );
}
