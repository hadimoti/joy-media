import { APP_MENU_GROUPS } from './app-menu.js';

/**
 * Every popup the app registers on the shared popup manager (OB-18).
 *
 * Components take their ids from here. `popup-manager.test.tsx` reads the component
 * sources and fails if one registers an id that this list does not contain.
 */
export const POPUP_IDS = {
  commandPalette: 'command-palette',
  monitorZoom: 'monitor-zoom',
  monitorView: 'monitor-view',
  projectMenu: 'project-menu',
  exportPreset: 'export-preset',
  recentProcesses: 'recent-processes',
  workspaceSwitcher: 'workspace-switcher',
  canvasFormat: 'canvas-format',
} as const;

const APP_MENU_PREFIX = 'app-menu:';
const ACTION_OVERFLOW_PREFIX = 'action-overflow:';

/** Id of one menu-bar group: File, Edit, Clip, Joy Code (`agent`), View or Window. */
export function appMenuPopupId(groupId: string): string {
  return `${APP_MENU_PREFIX}${groupId}`;
}

/** Id of one panel-header overflow menu. `key` must be unique per instance. */
export function actionOverflowPopupId(key: string): string {
  return `${ACTION_OVERFLOW_PREFIX}${key}`;
}

/**
 * Every popup id that exists in the app, with one entry per menu-bar group.
 * Panel-header overflow menus are created per instance, so they are not listed here;
 * `actionOverflowPopupId` builds them.
 */
export const REGISTERED_POPUP_IDS: readonly string[] = [
  ...Object.values(POPUP_IDS),
  ...APP_MENU_GROUPS.map((group) => appMenuPopupId(group.id)),
];
