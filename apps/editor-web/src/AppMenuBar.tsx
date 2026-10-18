import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { APP_MENU_GROUPS, type AppMenuActionId, type AppMenuItem } from './app-menu.js';
import { PANEL_INTENT_LABELS } from './panel-metadata.js';

type MenuEntry =
  | { readonly kind: 'item'; readonly item: AppMenuItem; readonly index: number }
  | {
      readonly kind: 'section';
      readonly section: NonNullable<AppMenuItem['section']>;
      readonly items: { readonly item: AppMenuItem; readonly index: number }[];
    };

function groupMenuItems(items: readonly AppMenuItem[]): MenuEntry[] {
  const entries: MenuEntry[] = [];
  items.forEach((item, index) => {
    if (item.section === undefined) {
      entries.push({ kind: 'item', item, index });
      return;
    }
    const last = entries[entries.length - 1];
    if (last?.kind === 'section' && last.section === item.section) {
      last.items.push({ item, index });
    } else {
      entries.push({ kind: 'section', section: item.section, items: [{ item, index }] });
    }
  });
  return entries;
}

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
  props: Pick<AppMenuBarProps, 'canUndo' | 'canRedo' | 'hasSelection' | 'exporting' | 'signedIn'>,
): boolean {
  if (item.disabled === true) return true;
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
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const menuRefs = useRef(new Map<string, HTMLUListElement>());
  const baseId = useId();

  useEffect(() => {
    if (openMenu === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root === null || root.contains(event.target as Node)) return;
      setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (openMenu !== null) triggerRefs.current.get(openMenu)?.focus();
        setOpenMenu(null);
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const menu = openMenu === null ? undefined : menuRefs.current.get(openMenu);
      if (menu === undefined) return;
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (buttons.length === 0) return;
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
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenu]);

  useEffect(() => {
    if (openMenu === null) return;
    window.setTimeout(() => {
      menuRefs.current
        .get(openMenu)
        ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
        ?.focus();
    }, 0);
  }, [openMenu]);

  return (
    <nav className="app-menubar" aria-label="Application menu" ref={rootRef}>
      {APP_MENU_GROUPS.map((group) => {
        const menuId = `${baseId}-${group.id}`;
        const isOpen = openMenu === group.id;
        const items = group.items.filter((item) => !(item.requiresSignedIn === true && !signedIn));
        const entries = groupMenuItems(items);
        const renderMenuItem = (item: AppMenuItem, index: number) => {
          const disabled = itemDisabled(item, props);
          const showSeparator = item.separatorAfter === true && index < items.length - 1;
          return (
            <>
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
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') return;
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    triggerRefs.current.get(group.id)?.focus();
                    setOpenMenu(null);
                  }
                }}
              >
                <span className="app-menu-item-label">{item.label}</span>
                {item.shortcut !== undefined && (
                  <kbd className="app-menu-item-shortcut">{item.shortcut}</kbd>
                )}
              </button>
              {showSeparator && <hr className="app-menu-separator" aria-hidden="true" />}
            </>
          );
        };
        return (
          <div key={group.id} className="app-menu">
            <button
              type="button"
              className="app-menu-trigger"
              ref={(element) => {
                if (element === null) triggerRefs.current.delete(group.id);
                else triggerRefs.current.set(group.id, element);
              }}
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
              <ul
                className="app-menu-dropdown"
                role="menu"
                id={menuId}
                ref={(element) => {
                  if (element === null) menuRefs.current.delete(group.id);
                  else menuRefs.current.set(group.id, element);
                }}
              >
                {entries.map((entry) =>
                  entry.kind === 'section' ? (
                    <li key={`section-${entry.section}`} role="none">
                      <div
                        className="app-menu-section-group"
                        role="group"
                        aria-label={PANEL_INTENT_LABELS[entry.section]}
                      >
                        <span className="app-menu-section-heading" aria-hidden="true">
                          {PANEL_INTENT_LABELS[entry.section]}
                        </span>
                        {entry.items.map(({ item, index }) => (
                          <Fragment key={item.id}>{renderMenuItem(item, index)}</Fragment>
                        ))}
                      </div>
                    </li>
                  ) : (
                    <li key={entry.item.id} role="none">
                      {renderMenuItem(entry.item, entry.index)}
                    </li>
                  ),
                )}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
