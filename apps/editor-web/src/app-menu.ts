import { PANEL_IDS, type PanelId } from './workspace.js';
import {
  PANEL_INTENT_ORDER,
  PANEL_METADATA,
  panelsForIntent,
  type PanelIntent,
} from './panel-metadata.js';

export type AppMenuActionId =
  | 'file.projects'
  | 'file.projectImport'
  | 'file.projectExport'
  | 'file.export'
  | 'file.signOut'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.delete'
  | 'edit.duplicate'
  | 'edit.commandPalette'
  | 'edit.assetLibrarySettings'
  | 'clip.split'
  | 'agent.open'
  | 'agent.active'
  | 'agent.executionMode'
  | 'agent.stop'
  | 'agent.settings'
  | 'view.commandPalette'
  | 'view.fullscreen'
  | 'window.minimize'
  | 'window.maximize'
  | 'window.close'
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
  readonly section?: PanelIntent;
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
  return PANEL_INTENT_ORDER.flatMap((intent) =>
    panelsForIntent(intent).map((entry) => ({
      id: `view.panel.${entry.id}` as const,
      label: entry.label,
      section: intent,
    })),
  );
}

function windowPanelItems(): readonly AppMenuItem[] {
  return WINDOW_PANELS.map((panelId) => ({
    id: `window.panel.${panelId}` as const,
    label: `Focus ${PANEL_METADATA.find((entry) => entry.id === panelId)?.label ?? panelId}`,
  }));
}

/** Adobe-style menubar catalog — labels are the discoverability surface. */
export const APP_MENU_GROUPS: readonly AppMenuGroup[] = [
  {
    id: 'file',
    label: 'File',
    items: [
      { id: 'file.projects', label: 'Projects Library…', separatorAfter: true },
      { id: 'file.projectImport', label: 'Import Editable Project…' },
      { id: 'file.projectExport', label: 'Export Editable Project…', separatorAfter: true },
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
      { id: 'edit.assetLibrarySettings', label: 'Asset Library Folder…', separatorAfter: true },
    ],
  },
  {
    id: 'clip',
    label: 'Clip',
    items: [{ id: 'clip.split', label: 'Split at Playhead', shortcut: 'S' }],
  },
  {
    id: 'agent',
    label: 'Joy Code',
    items: [
      { id: 'agent.open', label: 'Open Joy Code', separatorAfter: true },
      { id: 'agent.active', label: 'Built-in JOY Agent Engine', disabled: true },
      { id: 'agent.executionMode', label: 'Execution Mode…', separatorAfter: true },
      { id: 'agent.stop', label: 'Pause / Stop' },
      { id: 'agent.settings', label: 'Joy Code Settings…' },
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
      {
        id: 'view.fullscreen',
        label: 'Toggle Full Screen',
        shortcut: 'F11',
        separatorAfter: true,
      },
      ...panelViewItems(),
    ],
  },
  {
    id: 'window',
    label: 'Window',
    items: [
      { id: 'window.minimize', label: 'Minimize', shortcut: 'Ctrl+M' },
      { id: 'window.maximize', label: 'Zoom / Maximize' },
      { id: 'window.close', label: 'Close Window', shortcut: 'Alt+F4', separatorAfter: true },
      ...windowPanelItems(),
    ],
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
