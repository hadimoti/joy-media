import { useEffect, useId, useRef, useState } from 'react';
import {
  APP_MENU_GROUPS,
  type AppMenuActionId,
  type AppMenuItem,
} from './app-menu.js';

export interface AppMenuBarProps {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly hasSelection: boolean;
  readonly exporting: boolean;
  readonly signedIn: boolean;
  readonly onAction: (id: AppMenuActionId) => void;
}

function itemDisabled(
  item: AppMenuItem,
  props: Pick<
    AppMenuBarProps,
    'canUndo' | 'canRedo' | 'hasSelection' | 'exporting' | 'signedIn'
  >,
): boolean {
  switch (item.id) {
    case 'edit.undo':
      return !props.canUndo;
    case 'edit.redo':
      return !props.canRedo;
    case 'edit.delete':
    case 'edit.duplicate':
    case 'clip.split':
      return !props.hasSelection;
    case 'file.export':
      return props.exporting;
    case 'file.signOut':
      return !props.signedIn;
    default:
      return false;
  }
}

export function AppMenuBar(props: AppMenuBarProps) {
  const { onAction, signedIn } = props;
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const baseId = useId();

  useEffect(() => {
    if (openMenu === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root === null || root.contains(event.target as Node)) return;
      setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenu]);

  return (
    <nav className="app-menubar" aria-label="Application menu" ref={rootRef}>
      {APP_MENU_GROUPS.map((group) => {
        const menuId = `${baseId}-${group.id}`;
        const isOpen = openMenu === group.id;
        const items = group.items.filter(
          (item) => !(item.requiresSignedIn === true && !signedIn),
        );
        return (
          <div key={group.id} className="app-menu">
            <button
              type="button"
              className="app-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              aria-controls={menuId}
              onClick={() => setOpenMenu(isOpen ? null : group.id)}
              onMouseEnter={() => {
                if (openMenu !== null) setOpenMenu(group.id);
              }}
            >
              {group.label}
            </button>
            {isOpen && (
              <ul className="app-menu-dropdown" role="menu" id={menuId}>
                {items.map((item, index) => {
                  const disabled = itemDisabled(item, props);
                  const showSeparator =
                    item.separatorAfter === true && index < items.length - 1;
                  return (
                    <li key={item.id} role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="app-menu-item"
                        disabled={disabled}
                        onClick={() => {
                          if (disabled) return;
                          onAction(item.id);
                          setOpenMenu(null);
                        }}
                      >
                        <span className="app-menu-item-label">{item.label}</span>
                        {item.shortcut !== undefined && (
                          <kbd className="app-menu-item-shortcut">{item.shortcut}</kbd>
                        )}
                      </button>
                      {showSeparator && (
                        <hr className="app-menu-separator" aria-hidden="true" />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
