/**
 * The panel shell — DESIGN.md §3a / §3c.
 *
 * Header (centered title, actions at the inline end) → optional search →
 * centered tabs → scrolling body. Every panel renders through this so the
 * structure cannot drift per panel, which is exactly what happened when the
 * layout was a convention copied by hand.
 *
 * §3c: the shell is always mounted. A panel that needs a selection it does not
 * have passes `inactive` + `note` — it keeps its header, tabs and previews and
 * only the body goes quiet. It never swaps itself for a sentence.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { SearchIcon } from './icons.js';

export interface PanelTabSpec {
  readonly id: string;
  readonly label: string;
  /** Tabs stay clickable while the body is inactive (§3c.5). */
  readonly disabled?: boolean;
}

export interface PanelShellProps {
  /** Panel name, centered. Keep it to one word where the tab icon carries meaning. */
  readonly title: string;
  /** Same glyph as the panel's dockview tab — pass `panelTabIconUrl(id)`. */
  readonly iconUrl?: string | undefined;
  /** For the panels whose tab glyph is an inline SVG rather than a PNG mask. */
  readonly icon?: ReactNode;
  /** Extra class on the root, for the handful of genuinely panel-specific rules. */
  readonly className?: string | undefined;
  /** Icon buttons for the header's inline end. Order: create · favourites · filter. */
  readonly actions?: ReactNode;
  /** Renders the ⌕ toggle and the collapsible field when provided. */
  readonly search?:
    | {
        readonly value: string;
        readonly onChange: (next: string) => void;
        readonly placeholder?: string | undefined;
      }
    | undefined;
  readonly tabs?: readonly PanelTabSpec[] | undefined;
  readonly activeTab?: string | undefined;
  readonly onTabChange?: ((id: string) => void) | undefined;
  /** Dims and disables the body; the shell itself stays fully visible. */
  readonly inactive?: boolean | undefined;
  /** One short line under the tabs saying why (§3c.4). Usually paired with `inactive`. */
  readonly note?: string | undefined;
  readonly children: ReactNode;
}

export function PanelShell({
  title,
  iconUrl,
  icon,
  className,
  actions,
  search,
  tabs,
  activeTab,
  onTabChange,
  inactive = false,
  note,
  children,
}: PanelShellProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const closeSearch = useCallback(() => {
    search?.onChange('');
    setSearchOpen(false);
  }, [search]);

  const searchFieldId = `${title.toLowerCase().replace(/\s+/g, '-')}-panel-search`;

  return (
    <article className={className === undefined ? 'joy-panel-root' : `joy-panel-root ${className}`}>
      <div className="joy-panel-header">
        <h3 className="joy-panel-title">
          {icon !== undefined ? (
            <span className="joy-panel-title-icon" aria-hidden="true">
              {icon}
            </span>
          ) : (
            iconUrl !== undefined && (
              // The panel-tab PNGs are black-on-transparent and are meant to be
              // masked with currentColor (DESIGN.md §3) — as a plain <img> they
              // render black on a black panel and vanish.
              <span
                className="joy-panel-title-icon joy-panel-title-icon-mask"
                style={{ maskImage: `url(${iconUrl})`, WebkitMaskImage: `url(${iconUrl})` }}
                aria-hidden="true"
              />
            )
          )}
          {title}
        </h3>
        <div className="joy-panel-actions">
          {actions}
          {search !== undefined && (
            <button
              type="button"
              className="icon-button"
              aria-label={searchOpen ? `Close ${title} search` : `Search ${title}`}
              title={searchOpen ? 'Close search' : 'Search'}
              aria-expanded={searchOpen}
              aria-controls={searchFieldId}
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            >
              <SearchIcon />
            </button>
          )}
        </div>
      </div>

      {search !== undefined && searchOpen && (
        <div className="joy-panel-search">
          <input
            id={searchFieldId}
            ref={searchInputRef}
            type="search"
            placeholder={search.placeholder ?? `Search ${title.toLowerCase()}…`}
            aria-label={`Search ${title}`}
            value={search.value}
            onChange={(event) => search.onChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeSearch();
            }}
          />
        </div>
      )}

      {tabs !== undefined && tabs.length > 0 && (
        <div className="joy-panel-tabs" role="tablist" aria-label={`${title} sections`}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className="joy-panel-tab"
              aria-selected={activeTab === tab.id}
              disabled={tab.disabled === true}
              onClick={() => onTabChange?.(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {note !== undefined && (
        <p className="joy-panel-note" aria-live="polite">
          {note}
        </p>
      )}

      <div
        className={inactive ? 'joy-panel-body is-inactive' : 'joy-panel-body'}
        aria-disabled={inactive ? true : undefined}
      >
        {children}
      </div>
    </article>
  );
}
