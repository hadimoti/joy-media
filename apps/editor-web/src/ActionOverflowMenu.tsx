import { useEffect, useId, useRef } from 'react';
import { usePopup } from './popup-manager.js';
import { actionOverflowPopupId } from './popup-ids.js';

export interface ActionOverflowMenuItem {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly destructive?: boolean;
}

export function ActionOverflowMenu({
  label = 'More timeline actions',
  items,
  className,
}: {
  readonly label?: string;
  readonly items: readonly ActionOverflowMenuItem[];
  readonly className?: string;
}) {
  // A panel-header menu is one popup among the app's popups (OB-18): opening
  // another popup closes it, and outside click or Escape closes it.
  const popupKey = useId();
  const popup = usePopup(actionOverflowPopupId(popupKey));
  const open = popup.open;
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const keys = (event: KeyboardEvent) => {
      const buttons = [
        ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
      ];
      if (buttons.length === 0) return;
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    document.addEventListener('keydown', keys);
    window.setTimeout(
      () => menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(),
      0,
    );
    return () => {
      document.removeEventListener('keydown', keys);
    };
  }, [open]);

  return (
    <div
      className={`action-overflow-menu${className === undefined ? '' : ` ${className}`}`}
      ref={popup.rootRef}
    >
      <button
        type="button"
        className="icon-button icon-button-labeled action-overflow-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={(event) => popup.toggle(event.currentTarget)}
      >
        <span aria-hidden="true">⋯</span>
        <span className="action-overflow-trigger-label">More</span>
      </button>
      {open && (
        <div className="action-overflow-popover" ref={menuRef} role="menu" aria-label={label}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={item.destructive ? 'is-destructive' : undefined}
              title={item.disabled ? item.disabledReason : undefined}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect();
                popup.close();
              }}
            >
              <span>{item.label}</span>
              {item.disabled && item.disabledReason !== undefined && (
                <small>{item.disabledReason}</small>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
