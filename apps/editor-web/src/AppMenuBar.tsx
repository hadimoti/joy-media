import { useEffect, useId, useRef } from 'react';
import { APP_MENU_GROUPS, type AppMenuActionId, type AppMenuItem } from './app-menu.js';
import { PANEL_INTENT_LABELS } from './panel-metadata.js';
import { usePopupManager } from './popup-manager.js';
import { appMenuPopupId } from './popup-ids.js';

export interface AppMenuBarProps {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly hasSelection: boolean;
  readonly exporting: boolean;
  readonly onAction: (id: AppMenuActionId) => void;
}

/** Whether a menu item is greyed out right now. The command palette uses the same rule. */
export function itemDisabled(
  item: AppMenuItem,
  props: Pick<AppMenuBarProps, 'canUndo' | 'canRedo' | 'hasSelection' | 'exporting'>,
): boolean {
  if (item.disabled === true) return true;
  switch (item.id) {
    case 'edit.undo':
      return !props.canUndo;
    case 'edit.redo':
      return !props.canRedo;
    case 'clip.delete':
    case 'clip.duplicate':
    case 'clip.split':
    case 'clip.speed':
      return !props.hasSelection;
    case 'file.export':
      return props.exporting;
    default:
      return false;
  }
}

export function AppMenuBar(props: AppMenuBarProps) {
  const { onAction } = props;
  const { openId, open, toggle, close, registerRoot } = usePopupManager();
  const menuRefs = useRef(new Map<string, HTMLUListElement>());
  const baseId = useId();
  // Which menu-bar group is open, if any. Outside click and Escape are handled by the manager.
  const openGroupId =
    APP_MENU_GROUPS.find((group) => appMenuPopupId(group.id) === openId)?.id ?? null;

  useEffect(() => {
    if (openGroupId === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const menu = menuRefs.current.get(openGroupId);
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
    window.addEventListener('keydown', onKeyDown);
    window.setTimeout(() => {
      menuRefs.current
        .get(openGroupId)
        ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
        ?.focus();
    }, 0);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openGroupId]);

  return (
    <nav className="app-menubar" aria-label="Application menu">
      {APP_MENU_GROUPS.map((group) => {
        const popupId = appMenuPopupId(group.id);
        const menuId = `${baseId}-${group.id}`;
        const isOpen = openGroupId === group.id;
        const items = group.items;
        return (
          <div key={group.id} className="app-menu" ref={registerRoot(popupId)}>
            <button
              type="button"
              className="app-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              aria-controls={menuId}
              onClick={(event) => toggle(popupId, event.currentTarget)}
              onMouseEnter={(event) => {
                if (openGroupId !== null) open(popupId, event.currentTarget);
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
                {items.map((item, index) => {
                  const disabled = itemDisabled(item, props);
                  const showSeparator = item.separatorAfter === true && index < items.length - 1;
                  const previous = items[index - 1];
                  const sectionHeading =
                    item.section !== undefined && item.section !== previous?.section
                      ? PANEL_INTENT_LABELS[item.section]
                      : undefined;
                  return (
                    <li key={item.id} role="none">
                      {sectionHeading !== undefined && (
                        <h4 className="app-menu-section-heading">{sectionHeading}</h4>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        className="app-menu-item"
                        disabled={disabled}
                        onClick={() => {
                          if (disabled) return;
                          onAction(item.id);
                          close(popupId);
                        }}
                      >
                        <span className="app-menu-item-label">{item.label}</span>
                        {item.shortcut !== undefined && (
                          <kbd className="app-menu-item-shortcut">{item.shortcut}</kbd>
                        )}
                      </button>
                      {showSeparator && <hr className="app-menu-separator" aria-hidden="true" />}
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
