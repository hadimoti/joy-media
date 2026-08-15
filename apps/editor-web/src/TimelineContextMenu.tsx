import { useEffect, useRef } from 'react';
import type { ComponentType } from 'react';

export const SPEED_PRESETS = [0.5, 0.75, 1, 1.5, 2] as const;

export interface ContextMenuItem {
  readonly label: string;
  readonly action?: () => void;
  readonly disabled?: boolean;
  readonly dividerBefore?: boolean;
  readonly icon?: ComponentType<{ className?: string }>;
  readonly shortcut?: string;
}

export interface TimelineContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly items: readonly ContextMenuItem[];
}

export function TimelineContextMenu({
  menu,
  onClose,
}: {
  readonly menu: TimelineContextMenuState;
  readonly onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const focusedIndexRef = useRef(-1);

  useEffect(() => {
    const clampToViewport = () => {
      const element = menuRef.current;
      if (!element) return;

      const padding = 8;
      const bounds = element.getBoundingClientRect();
      const maxLeft = Math.max(padding, window.innerWidth - bounds.width - padding);
      const maxTop = Math.max(padding, window.innerHeight - bounds.height - padding);
      element.style.left = `${Math.min(Math.max(menu.x, padding), maxLeft)}px`;
      element.style.top = `${Math.min(Math.max(menu.y, padding), maxTop)}px`;
    };

    clampToViewport();
    window.addEventListener('resize', clampToViewport);
    return () => window.removeEventListener('resize', clampToViewport);
  }, [menu.x, menu.y]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      const enabledIndexes = menu.items
        .map((item, index) => (item.action && !item.disabled ? index : -1))
        .filter((index) => index >= 0);
      if (enabledIndexes.length === 0) return;

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const candidates =
          event.key === 'ArrowDown' ? enabledIndexes : [...enabledIndexes].reverse();
        const next =
          candidates.find((index) =>
            event.key === 'ArrowDown'
              ? index > focusedIndexRef.current
              : index < focusedIndexRef.current,
          ) ?? candidates[0]!;
        focusedIndexRef.current = next;
        menuRef.current?.querySelector<HTMLElement>(`[data-menu-index="${next}"]`)?.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menu.items, onClose]);

  return (
    <>
      <button
        type="button"
        className="timeline-context-backdrop"
        aria-label="Dismiss context menu"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className="timeline-context-menu"
        role="menu"
        style={{ left: menu.x, top: menu.y }}
        onClick={(event) => event.stopPropagation()}
      >
        {menu.items.map((item, index) => {
          return (
            <div key={`${item.label}-${index}`}>
              {item.dividerBefore && <div className="timeline-context-sep" role="separator" />}
              {item.action && (
                <button
                  type="button"
                  role="menuitem"
                  className="timeline-context-item"
                  disabled={item.disabled}
                  data-menu-index={index}
                  onFocus={() => {
                    focusedIndexRef.current = index;
                  }}
                  onClick={() => {
                    item.action?.();
                    onClose();
                  }}
                >
                  <span className="timeline-context-icon" aria-hidden="true">
                    {item.icon ? <item.icon /> : null}
                  </span>
                  <span className="timeline-context-label">{item.label}</span>
                  {item.shortcut && (
                    <span className="timeline-context-shortcut">{item.shortcut}</span>
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
