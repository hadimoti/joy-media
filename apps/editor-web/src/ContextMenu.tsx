import { useEffect, useRef } from 'react';
import './app.css';

export interface ContextMenuItem {
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: () => void;
  shortcut?: string;
  disabled?: boolean;
  dividerBefore?: boolean;
}

export interface ContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly items: readonly ContextMenuItem[];
  readonly onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const focusedIndexRef = useRef(-1);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      const enabledItems = items
        .map((item, i) => (item.action && !item.disabled ? i : -1))
        .filter((i) => i >= 0);

      if (enabledItems.length === 0) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const currentIdx = focusedIndexRef.current;
        const nextIdx = enabledItems.find((i) => i > currentIdx) ?? enabledItems[0]!;
        focusedIndexRef.current = nextIdx;
        (menuRef.current?.querySelectorAll('[data-menu-index]')[nextIdx] as HTMLElement)?.focus?.();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        const currentIdx = focusedIndexRef.current;
        const prevIdx = [...enabledItems].reverse().find((i) => i < currentIdx) ?? enabledItems[enabledItems.length - 1]!;
        focusedIndexRef.current = prevIdx;
        (menuRef.current?.querySelectorAll('[data-menu-index]')[prevIdx] as HTMLElement)?.focus?.();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const currentIdx = focusedIndexRef.current;
        const action = currentIdx >= 0 ? items[currentIdx]?.action : undefined;
        if (action) {
          action();
          onClose();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [items, onClose]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: x, top: y }}
      role="menu"
      tabIndex={-1}
    >
      {items.map((item, index) => {
        if (item.dividerBefore) {
          return <div key={`divider-${index}`} className="context-menu-divider" role="separator" />;
        }
        if (!item.action) {
          return null;
        }
        return (
          <button
            key={index}
            className={`context-menu-item ${item.disabled ? 'disabled' : ''}`}
            disabled={item.disabled}
            onClick={() => { item.action?.(); onClose(); }}
            data-menu-index={index}
            tabIndex={-1}
            role="menuitem"
            onFocus={() => { focusedIndexRef.current = index; }}
          >
            {item.icon && <span className="context-menu-icon"><item.icon className="icon" /></span>}
            <span className="context-menu-label">{item.label}</span>
            {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}