export const PANEL_IDS = [
  'media',
  'monitor',
  'timeline',
  'flow',
  'captions',
  'text',
  'inspector',
  'scene3d',
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
  'plugins',
  'templates',
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

/** The professional default surface; specialist panels remain available from View on demand. */
export const CORE_WORKSPACE_PANELS = [
  'media',
  'effects',
  'inspector',
  'scene3d',
  'agent',
  'timeline',
  'flow',
  'monitor',
] as const satisfies readonly PanelId[];

export interface WorkspaceLayout {
  readonly version: 2;
  readonly panels: readonly PanelId[];
}

export const DEFAULT_WORKSPACE: WorkspaceLayout = {
  version: 2,
  panels: [
    'media',
    'monitor',
    'timeline',
    'flow',
    'captions',
    'text',
    'inspector',
    'scene3d',
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
    'plugins',
    'templates',
  ],
};

export const WORKSPACE_STORAGE_KEY = 'joy-media.editor-workspace.v1';
export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Layout is a user preference, isolated from the creative project document. */
export function recoverWorkspaceLayout(value: unknown): WorkspaceLayout {
  if (isLayout(value)) return value;
  if (isLegacyLayout(value)) {
    const panels: PanelId[] = [...value.panels];
    panels.splice(panels.indexOf('inspector') + 1, 0, 'scene3d');
    return { version: 2, panels };
  }
  return DEFAULT_WORKSPACE;
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
  return (
    candidate.version === 2 &&
    Array.isArray(candidate.panels) &&
    candidate.panels.length === PANEL_IDS.length &&
    new Set(candidate.panels).size === PANEL_IDS.length &&
    candidate.panels.every(
      (panel) => typeof panel === 'string' && PANEL_IDS.includes(panel as PanelId),
    )
  );
}

function isLegacyLayout(
  value: unknown,
): value is { readonly version: 1; readonly panels: readonly Exclude<PanelId, 'scene3d'>[] } {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { version?: unknown; panels?: unknown };
  const legacyPanelIds = PANEL_IDS.filter((panelId) => panelId !== 'scene3d');
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.panels) &&
    candidate.panels.length === legacyPanelIds.length &&
    new Set(candidate.panels).size === legacyPanelIds.length &&
    candidate.panels.every(
      (panel) =>
        typeof panel === 'string' && legacyPanelIds.includes(panel as Exclude<PanelId, 'scene3d'>),
    )
  );
}
