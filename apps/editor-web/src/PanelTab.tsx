import type { IDockviewPanelHeaderProps } from 'dockview';
import { panelLabel, panelTabIconUrl, panelTabSvgIcon } from './panel-tab-icons.js';

/** Icon-only dock tab; the label becomes visible in Dockview's overflow menu. */
export function PanelTab({ api }: IDockviewPanelHeaderProps) {
  const label = panelLabel(api.id);
  const SvgIcon = panelTabSvgIcon(api.id);
  const iconUrl = panelTabIconUrl(api.id);

  return (
    <div className="panel-tab" title={label} aria-label={label}>
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
    </div>
  );
}
