import type { ReactNode } from 'react';
import { CutIcon, DuplicateIcon, FreezeIcon, SelectIcon, SpeedIcon, TrashIcon } from './icons.js';

export const SPEED_PRESETS = [0.5, 0.75, 1, 1.5, 2] as const;

export interface ContextMenuItem {
  readonly label: string;
  readonly action: () => void;
  readonly disabled?: boolean;
  readonly dividerBefore?: boolean;
  readonly icon?: React.ComponentType<{ className?: string }>;
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
        className="timeline-context-menu"
        role="menu"
        style={{ left: menu.x, top: menu.y }}
        onClick={(event) => event.stopPropagation()}
      >
        {menu.items.map((item, index) => {
          if (item.dividerBefore) {
            return (
              <div key={`divider-${index}`} className="timeline-context-sep" role="separator" />
            );
          }
          return (
            <button
              key={index}
              type="button"
              role="menuitem"
              className="timeline-context-item"
              disabled={item.disabled}
              onClick={() => {
                item.action();
                onClose();
              }}
            >
              <span className="timeline-context-icon">{item.icon ? <item.icon /> : null}</span>
              {item.label}
            </button>
          );
        })}
      </div>
    </>
  );
}
