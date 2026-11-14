import type { ReactNode } from 'react';

export interface LibraryRailItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly iconUrl?: string;
  readonly count?: number;
}

export function LibraryRail({
  label,
  items,
  selectedId,
  onSelect,
}: {
  readonly label: string;
  readonly items: readonly LibraryRailItem[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <aside className="library-rail" aria-label={label}>
      <div className="library-rail-list" role="tablist" aria-label={label}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            className="library-rail-item"
            data-library-category={item.id}
            aria-label={item.count === undefined ? item.label : `${item.label} (${item.count})`}
            title={item.label}
            aria-selected={selectedId === item.id}
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
        ))}
      </div>
    </aside>
  );
}
