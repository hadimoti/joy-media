import { useEffect, useId, useRef } from 'react';
import { APP_MENU_GROUPS, type AppMenuActionId, type AppMenuItem } from './app-menu.js';
import { PANEL_INTENT_LABELS } from './panel-metadata.js';
import { usePopupManager } from './popup-manager.js';
import { appMenuPopupId } from './popup-ids.js';
import { useAgentPresenceSnapshot, type JoyAgentTarget } from './agent-presence.js';
import { panelLabel } from './panel-tab-icons.js';

export interface AppMenuBarProps {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly hasSelection: boolean;
  /** True when the selected clip is a video clip, the only kind with a Speed tab. */
  readonly supportsSpeed: boolean;
  readonly exporting: boolean;
  readonly followAgentTarget: boolean;
  readonly onAction: (id: AppMenuActionId) => void;
  readonly onToggleFollowAgentTarget: () => void;
  readonly onClearFollowAgentTarget: () => void;
  readonly onShowAgentTarget?: (target: JoyAgentTarget) => void;
  readonly onStopAgentRun?: (runId: string) => void;
}

export type MenuRuleState = Pick<
  AppMenuBarProps,
  'canUndo' | 'canRedo' | 'hasSelection' | 'supportsSpeed' | 'exporting'
>;

/** Whether a menu item is greyed out right now. The command palette uses the same rule. */
export function itemDisabled(item: AppMenuItem, props: MenuRuleState): boolean {
  if (item.disabled === true) return true;
  switch (item.id) {
    case 'edit.undo':
      return !props.canUndo;
    case 'edit.redo':
      return !props.canRedo;
    case 'clip.copy':
    case 'clip.cut':
    case 'clip.delete':
    case 'clip.duplicate':
    case 'clip.split':
      return !props.hasSelection;
    case 'clip.speed':
      return !props.hasSelection || !props.supportsSpeed;
    case 'file.export':
      return props.exporting;
    default:
      return false;
  }
}

export function AppMenuBar(props: AppMenuBarProps) {
  const {
    onAction,
    onShowAgentTarget,
    onStopAgentRun,
    followAgentTarget,
    onToggleFollowAgentTarget,
    onClearFollowAgentTarget,
  } = props;
  const activity = useAgentPresenceSnapshot();
  const showTargetRef = useRef(onShowAgentTarget);
  const targetRef = useRef<JoyAgentTarget | undefined>(undefined);
  showTargetRef.current = onShowAgentTarget;
  const target =
    activity.targets.find((entry) => entry.panelId !== 'agent') ??
    activity.targets[0] ??
    activity.terminalTarget;
  const terminal =
    activity.status === 'completed' ||
    activity.status === 'failed' ||
    activity.status === 'cancelled';
  const phase =
    activity.phase === 'awaiting-approval'
      ? 'Needs approval'
      : activity.phase === 'idle'
        ? 'Idle'
        : activity.phase[0]!.toUpperCase() + activity.phase.slice(1).replaceAll('-', ' ');
  const targetText =
    target === undefined
      ? 'JOY workspace'
      : target.sectionId === undefined
        ? panelLabel(target.panelId)
        : `${panelLabel(target.panelId)} · ${target.sectionId}`;
  const targetKey =
    target === undefined
      ? ''
      : `${target.panelId}:${target.sectionId ?? ''}:${target.entity?.id ?? ''}`;
  targetRef.current = target;
  const { openId, open, toggle, close, registerRoot } = usePopupManager();
  const menuRefs = useRef(new Map<string, HTMLUListElement>());
  // The menu a hover just opened. The click that follows on the same title keeps it open instead of closing it.
  const openedByHover = useRef<string | null>(null);
  const baseId = useId();
  useEffect(() => {
    const currentTarget = targetRef.current;
    if (!followAgentTarget || terminal || currentTarget === undefined) return;
    showTargetRef.current?.(currentTarget);
  }, [followAgentTarget, terminal, targetKey]);
  useEffect(() => {
    if (terminal) onClearFollowAgentTarget();
  }, [terminal, activity.runId, onClearFollowAgentTarget]);
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
              aria-label={
                group.id === 'agent' && activity.phase === 'awaiting-approval'
                  ? 'Joy Code, approval required'
                  : group.id === 'agent' && activity.status !== 'idle'
                    ? `Joy Code, ${phase.toLowerCase()}`
                    : undefined
              }
              aria-haspopup="menu"
              aria-expanded={isOpen}
              aria-controls={menuId}
              onClick={(event) => {
                if (openedByHover.current === popupId) {
                  openedByHover.current = null;
                  return;
                }
                toggle(popupId, event.currentTarget);
              }}
              onMouseEnter={(event) => {
                if (openGroupId !== null && openGroupId !== group.id) {
                  openedByHover.current = popupId;
                  open(popupId, event.currentTarget);
                }
              }}
              onMouseLeave={() => {
                if (openedByHover.current === popupId) openedByHover.current = null;
              }}
            >
              {group.label}
              {group.id === 'agent' && (
                <span
                  className={`app-menu-activity-mark is-${activity.status} is-${activity.phase}`}
                  aria-hidden="true"
                />
              )}
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
                  const disabled =
                    item.id === 'agent.active'
                      ? activity.phase !== 'awaiting-approval' && activity.status !== 'failed'
                      : item.id === 'agent.showTarget'
                        ? target === undefined
                        : item.id === 'agent.follow'
                          ? activity.runId === undefined || terminal
                          : item.id === 'agent.stop'
                            ? activity.runId === undefined || terminal
                            : itemDisabled(item, props);
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
                        role={item.id === 'agent.follow' ? 'menuitemcheckbox' : 'menuitem'}
                        className="app-menu-item"
                        disabled={disabled}
                        aria-checked={item.id === 'agent.follow' ? followAgentTarget : undefined}
                        onClick={() => {
                          if (disabled) return;
                          if (item.id === 'agent.showTarget' && target !== undefined)
                            onShowAgentTarget?.(target);
                          else if (item.id === 'agent.follow') onToggleFollowAgentTarget();
                          else if (item.id === 'agent.stop' && activity.runId !== undefined)
                            onStopAgentRun?.(activity.runId);
                          else if (item.id === 'agent.active') onAction('agent.open');
                          else onAction(item.id);
                          close(popupId);
                        }}
                      >
                        <span className="app-menu-item-label">
                          {item.id === 'agent.active'
                            ? activity.status === 'failed'
                              ? `View error · ${targetText}`
                              : `${phase} · ${targetText}${activity.progress === undefined ? '' : ` · ${activity.progress.current} of ${activity.progress.total}`}`
                            : item.id === 'agent.stop' && terminal
                              ? 'View status'
                              : item.label}
                        </span>
                        {item.id === 'agent.follow' && (
                          <span aria-hidden="true">{followAgentTarget ? '✓' : ''}</span>
                        )}
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
