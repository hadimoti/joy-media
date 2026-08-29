import { useEffect, useRef, useState } from 'react';

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
}: {
  readonly label?: string;
  readonly items: readonly ActionOverflowMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
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
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', keys);
    window.setTimeout(
      () => menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus(),
      0,
    );
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', keys);
    };
  }, [open]);

  return (
    <div className="action-overflow-menu" ref={rootRef}>
      <button
        type="button"
        className="icon-button icon-button-labeled action-overflow-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((current) => !current)}
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
                setOpen(false);
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
