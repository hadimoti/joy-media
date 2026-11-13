import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { POPUP_TRIGGER_ATTRIBUTE, usePopup } from './popup-manager.js';
import { actionOverflowPopupId } from './popup-ids.js';

export interface ActionOverflowMenuItem {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly tooltip?: string;
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
  const popupId = actionOverflowPopupId(popupKey);
  const popup = usePopup(actionOverflowPopupId(popupKey));
  const open = popup.open;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>();

  useLayoutEffect(() => {
    if (!open) {
      setPopoverStyle(undefined);
      return;
    }
    const updatePosition = (): void => {
      const trigger = triggerRef.current;
      if (trigger === null) return;
      const bounds = trigger.getBoundingClientRect();
      const availableWidth = Math.max(0, window.innerWidth - 16);
      const measuredMenuWidth = menuRef.current?.getBoundingClientRect().width ?? 0;
      const menuWidth = Math.min(measuredMenuWidth, availableWidth);
      const furthestRight = Math.max(8, window.innerWidth - menuWidth - 8);
      const left = Math.max(8, Math.min(bounds.right - menuWidth, furthestRight));
      const roomBelow = Math.max(0, window.innerHeight - bounds.bottom - 8);
      const roomAbove = Math.max(0, bounds.top - 8);
      const placeAbove = roomBelow < 240 && roomAbove > roomBelow;
      setPopoverStyle({
        position: 'fixed',
        left,
        right: 'auto',
        boxSizing: 'border-box',
        top: placeAbove ? 'auto' : bounds.bottom + 4,
        bottom: placeAbove ? window.innerHeight - bounds.top + 4 : 'auto',
        maxWidth: availableWidth,
        maxHeight: placeAbove ? roomAbove : roomBelow,
        overflowY: 'auto',
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

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
        ref={triggerRef}
        onClick={(event) => popup.toggle(event.currentTarget)}
      >
        <span aria-hidden="true">⋯</span>
        <span className="action-overflow-trigger-label">More</span>
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="action-overflow-popover"
            ref={menuRef}
            role="menu"
            aria-label={label}
            style={popoverStyle}
            {...{ [POPUP_TRIGGER_ATTRIBUTE]: popupId }}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={item.destructive ? 'is-destructive' : undefined}
                title={item.disabled ? item.disabledReason : item.tooltip}
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
          </div>,
          document.body,
        )}
    </div>
  );
}
