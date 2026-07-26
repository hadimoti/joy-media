import { PANEL_IDS, type PanelId } from './workspace.js';
import { PANEL_LABELS } from './panel-tab-icons.js';

export type AppMenuActionId =
  | 'file.projects'
  | 'file.export'
  | 'file.signOut'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.delete'
  | 'edit.duplicate'
  | 'edit.commandPalette'
  | 'clip.split'
  | 'agent.open'
  | 'agent.newTask'
  | 'agent.active'
  | 'agent.executionMode'
  | 'agent.stop'
  | 'agent.activity'
  | 'agent.settings'
  | 'view.commandPalette'
  | `view.panel.${PanelId}`
  | `window.panel.${PanelId}`;

export interface AppMenuItem {
  readonly id: AppMenuActionId;
  readonly label: string;
  readonly shortcut?: string;
  readonly separatorAfter?: boolean;
  readonly disabled?: boolean;
  /** Hide when signed out / no session logout available. */
  readonly requiresSignedIn?: boolean;
}

export interface AppMenuGroup {
  readonly id: 'file' | 'edit' | 'clip' | 'agent' | 'view' | 'window';
  readonly label: string;
  readonly items: readonly AppMenuItem[];
}

const WINDOW_PANELS = [
  'media',
  'monitor',
  'timeline',
  'inspector',
] as const satisfies readonly PanelId[];

function panelViewItems(): readonly AppMenuItem[] {
  return PANEL_IDS.map((panelId) => ({
    id: `view.panel.${panelId}` as const,
    label: PANEL_LABELS[panelId],
  }));
}

function windowPanelItems(): readonly AppMenuItem[] {
  return WINDOW_PANELS.map((panelId) => ({
    id: `window.panel.${panelId}` as const,
    label: `Focus ${PANEL_LABELS[panelId]}`,
  }));
}

/** Adobe-style menubar catalog — labels are the discoverability surface. */
export const APP_MENU_GROUPS: readonly AppMenuGroup[] = [
  {
    id: 'file',
    label: 'File',
    items: [
      { id: 'file.projects', label: 'Projects Library…', separatorAfter: true },
      { id: 'file.export', label: 'Export', separatorAfter: true },
      { id: 'file.signOut', label: 'Sign Out', requiresSignedIn: true },
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      { id: 'edit.undo', label: 'Undo', shortcut: 'Ctrl+Z' },
      { id: 'edit.redo', label: 'Redo', shortcut: 'Ctrl+Y', separatorAfter: true },
      { id: 'edit.delete', label: 'Cut / Delete Clip', shortcut: 'Del' },
      { id: 'edit.duplicate', label: 'Duplicate Clip', shortcut: 'Ctrl+D', separatorAfter: true },
      { id: 'edit.commandPalette', label: 'Command Palette…', shortcut: 'Ctrl+K' },
    ],
  },
  {
    id: 'clip',
    label: 'Clip',
    items: [{ id: 'clip.split', label: 'Split at Playhead', shortcut: 'S' }],
  },
  {
    id: 'agent',
    label: 'Agent',
    items: [
      { id: 'agent.open', label: 'Open Agent Panel' },
      { id: 'agent.newTask', label: 'New Task', separatorAfter: true },
      { id: 'agent.active', label: 'Active Agent: KiloCode', disabled: true },
      { id: 'agent.executionMode', label: 'Execution Mode…', separatorAfter: true },
      { id: 'agent.stop', label: 'Pause / Stop Task' },
      { id: 'agent.activity', label: 'Agent Activity', separatorAfter: true },
      { id: 'agent.settings', label: 'Agent Settings…' },
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [
      {
        id: 'view.commandPalette',
        label: 'Command Palette…',
        shortcut: 'Ctrl+K',
        separatorAfter: true,
      },
      ...panelViewItems(),
    ],
  },
  {
    id: 'window',
    label: 'Window',
    items: windowPanelItems(),
  },
];

export function isPanelMenuAction(
  id: string,
): id is `view.panel.${PanelId}` | `window.panel.${PanelId}` {
  return id.startsWith('view.panel.') || id.startsWith('window.panel.');
}

export function panelIdFromMenuAction(id: string): PanelId | undefined {
  if (!isPanelMenuAction(id)) return undefined;
  const panelId = id.slice(id.indexOf('panel.') + 'panel.'.length) as PanelId;
  return PANEL_IDS.includes(panelId) ? panelId : undefined;
}
