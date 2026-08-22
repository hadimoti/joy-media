export const PANEL_IDS = [
  'media',
  'monitor',
  'timeline',
  'flow',
  'captions',
  'inspector',
  'motion',
  'camera',
  'audio',
  'effects',
  'transitions',
  'color',
  'history',
  'diagnostics',
  'jobs',
  'agent',
  'workflows',
  'production',
  'plugins',
  'templates',
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export const GA_PANEL_IDS = [
  'media',
  'monitor',
  'timeline',
  'flow',
  'captions',
  'inspector',
  'motion',
  'camera',
  'audio',
  'effects',
  'transitions',
  'color',
  'history',
  'diagnostics',
  'agent',
] as const satisfies readonly PanelId[];

export interface WorkspaceLayout {
  readonly version: 1;
  readonly panels: readonly PanelId[];
}

export const DEFAULT_WORKSPACE: WorkspaceLayout = {
  version: 1,
  panels: GA_PANEL_IDS,
};

export const WORKSPACE_STORAGE_KEY = 'joy-media.editor-workspace.v1';
export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Layout is a user preference, isolated from the creative project document. */
export function recoverWorkspaceLayout(value: unknown): WorkspaceLayout {
  if (!isLayout(value)) return DEFAULT_WORKSPACE;
  return value;
}

export function loadWorkspacePreference(storage: WorkspaceStorage): WorkspaceLayout {
  const saved = storage.getItem(WORKSPACE_STORAGE_KEY);
  if (saved === null) return DEFAULT_WORKSPACE;
  try {
    return recoverWorkspaceLayout(JSON.parse(saved));
  } catch {
    return DEFAULT_WORKSPACE;
  }
}
export function saveWorkspacePreference(storage: WorkspaceStorage, layout: WorkspaceLayout): void {
  storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(layout));
}

function isLayout(value: unknown): value is WorkspaceLayout {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { version?: unknown; panels?: unknown };
  const panels = candidate.panels;
  const panelSet =
    Array.isArray(panels) &&
    panels.every((panel) => typeof panel === 'string' && PANEL_IDS.includes(panel as PanelId))
      ? new Set(panels)
      : undefined;
  const isDefaultGaShape =
    panelSet !== undefined &&
    Array.isArray(panels) &&
    panels.length === GA_PANEL_IDS.length &&
    GA_PANEL_IDS.every((panel) => panelSet.has(panel));
  const isFullRegistryShape =
    panelSet !== undefined &&
    Array.isArray(panels) &&
    panels.length === PANEL_IDS.length &&
    PANEL_IDS.every((panel) => panelSet.has(panel));
  return (
    candidate.version === 1 &&
    Array.isArray(panels) &&
    (isDefaultGaShape || isFullRegistryShape) &&
    new Set(panels).size === panels.length &&
    panels.every((panel) => typeof panel === 'string' && PANEL_IDS.includes(panel as PanelId))
  );
}
