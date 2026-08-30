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
  /** Optional 24×24 black-on-transparent mask, tinted with currentColor. */
  readonly iconUrl?: string;
  /** Tabs stay clickable while the body is inactive (§3c.5). */
  readonly disabled?: boolean;
  /** Optional migration/accessibility alias for a renamed tab. */
  readonly ariaLabel?: string;
}

export interface PanelShellProps {
  /** Accessible panel name. Visible dock labels already identify the panel. */
  readonly title: string;
  /** Same glyph as the panel's dockview tab — pass `panelTabIconUrl(id)`. */
  readonly iconUrl?: string | undefined;
  /** For the panels whose tab glyph is an inline SVG rather than a PNG mask. */
  readonly icon?: ReactNode;
  /** Extra class on the root, for the handful of genuinely panel-specific rules. */
  readonly className?: string | undefined;
  /** Icon buttons anchored to the header's inline start, across from `actions`. */
  readonly leadingActions?: ReactNode;
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
  /**
   * Put section tabs in the header center (replacing the title + icon) instead
   * of the usual row under the header. Title is still used for aria labels.
   */
  readonly tabsInHeader?: boolean | undefined;
  /** Dims and disables the body; the shell itself stays fully visible. */
  readonly inactive?: boolean | undefined;
  /** One short line under the tabs saying why (§3c.4). Usually paired with `inactive`. */
  readonly note?: string | undefined;
  /** Skip the centered title row (dock tab already names the panel). */
  readonly hideHeader?: boolean | undefined;
  readonly children: ReactNode;
}

export function PanelShell({
  title,
  className,
  leadingActions,
  actions,
  search,
  tabs,
  activeTab,
  onTabChange,
  tabsInHeader = false,
  inactive = false,
  note,
  hideHeader = false,
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
  const tabButtons =
    tabs !== undefined && tabs.length > 0
      ? tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className="joy-panel-tab"
            data-panel-tab-id={tab.id}
            aria-selected={activeTab === tab.id}
            aria-label={(tab.ariaLabel ?? tab.label) || tab.id}
            disabled={tab.disabled === true}
            tabIndex={activeTab === tab.id || (activeTab === undefined && index === 0) ? 0 : -1}
            onClick={() => onTabChange?.(tab.id)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              const siblings = Array.from(
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]:not(:disabled)',
                ) ?? [],
              );
              if (siblings.length === 0) return;
              event.preventDefault();
              const currentIndex = siblings.indexOf(event.currentTarget);
              const nextIndex =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? siblings.length - 1
                    : (currentIndex + (event.key === 'ArrowLeft' ? -1 : 1) + siblings.length) %
                      siblings.length;
              siblings[nextIndex]?.focus();
              const nextId = siblings[nextIndex]?.dataset.panelTabId;
              if (nextId !== undefined) onTabChange?.(nextId);
            }}
          >
            {tab.iconUrl !== undefined && (
              <span
                className="joy-panel-tab-icon"
                style={{
                  maskImage: `url(${tab.iconUrl})`,
                  WebkitMaskImage: `url(${tab.iconUrl})`,
                }}
                aria-hidden="true"
              />
            )}
            {tab.label}
          </button>
        ))
      : null;

  const hasHeaderActions =
    leadingActions !== undefined || actions !== undefined || search !== undefined;

  return (
    <article
      className={className === undefined ? 'joy-panel-root' : `joy-panel-root ${className}`}
      aria-label={title}
    >
      {!hideHeader && (tabsInHeader || hasHeaderActions) && (
        <div className="joy-panel-header">
          {leadingActions !== undefined && (
            <div className="joy-panel-leading-actions">{leadingActions}</div>
          )}
          {tabsInHeader && tabButtons !== null ? (
            <div
              className="joy-panel-tabs joy-panel-tabs-in-header"
              role="tablist"
              aria-label={`${title} sections`}
            >
              {tabButtons}
            </div>
          ) : !tabsInHeader ? (
            <span className="sr-only">{title}</span>
          ) : null}
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
      )}

      {search !== undefined && searchOpen && (
        <div className="joy-panel-search" id={`${searchFieldId}-wrap`}>
          <input
            id={searchFieldId}
            ref={searchInputRef}
            type="search"
            role="searchbox"
            placeholder={search.placeholder ?? 'Search…'}
            aria-label={`Search ${title}`}
            aria-controls={`${searchFieldId}-results`}
            value={search.value}
            onChange={(event) => search.onChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeSearch();
            }}
          />
        </div>
      )}

      {!tabsInHeader && tabButtons !== null && (
        <div className="joy-panel-tabs" role="tablist" aria-label={`${title} sections`}>
          {tabButtons}
        </div>
      )}

      {note !== undefined && (
        <p className="joy-panel-note" role="status" aria-live="polite">
          {note}
        </p>
      )}

      <div
        id={search !== undefined ? `${searchFieldId}-results` : undefined}
        className={inactive ? 'joy-panel-body is-inactive' : 'joy-panel-body'}
        aria-disabled={inactive ? true : undefined}
      >
        {children}
      </div>
    </article>
  );
}
