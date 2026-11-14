import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface LibraryRailItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly iconUrl?: string;
  readonly count?: number;
}

function tabId(panelId: string, itemId: string): string {
  return `${panelId}-tab-${itemId}`;
}

/** Props for the element that holds the cards of the selected category (the tab panel). */
export function libraryTabPanelProps(panelId: string, selectedId: string) {
  return {
    id: panelId,
    role: 'tabpanel' as const,
    'aria-labelledby': tabId(panelId, selectedId),
  };
}

export function LibraryRail({
  label,
  items,
  selectedId,
  onSelect,
  panelId,
}: {
  readonly label: string;
  readonly items: readonly LibraryRailItem[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  /** Id of the tab panel the rail controls; see `libraryTabPanelProps`. */
  readonly panelId: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const moveSelection = (event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = items.findIndex((item) => item.id === selectedId);
    if (items.length === 0) return;
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        nextIndex = (currentIndex + 1) % items.length;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        nextIndex = (currentIndex - 1 + items.length) % items.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = items[nextIndex];
    if (next === undefined) return;
    onSelect(next.id);
    listRef.current?.querySelectorAll<HTMLButtonElement>('button[role="tab"]')[nextIndex]?.focus();
  };

  return (
    <aside className="library-rail" aria-label={label}>
      <div
        ref={listRef}
        className="library-rail-list"
        role="tablist"
        aria-label={label}
        aria-orientation="vertical"
        onKeyDown={moveSelection}
      >
        {items.map((item, index) => {
          const selected = selectedId === item.id;
          const tabbable = selected || (index === 0 && !items.some((i) => i.id === selectedId));
          return (
            <button
              key={item.id}
              id={tabId(panelId, item.id)}
              type="button"
              role="tab"
              className="library-rail-item"
              data-library-category={item.id}
              aria-label={item.count === undefined ? item.label : `${item.label} (${item.count})`}
              title={item.label}
              aria-selected={selected}
              aria-current={selected ? 'true' : undefined}
              aria-controls={panelId}
              tabIndex={tabbable ? 0 : -1}
              onClick={() => onSelect(item.id)}
            >
              <span className="library-rail-icon" aria-hidden="true">
                {item.iconUrl === undefined ? (
                  item.icon
                ) : (
                  <span
                    className="library-rail-icon-mask"
                    style={{
                      maskImage: `url(${item.iconUrl})`,
                      WebkitMaskImage: `url(${item.iconUrl})`,
                    }}
                  />
                )}
              </span>
              <span className="library-rail-label">{item.label}</span>
              {item.count !== undefined && (
                <span className="library-rail-count" aria-hidden="true">
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
