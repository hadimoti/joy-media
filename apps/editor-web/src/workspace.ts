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

export type PanelSurfaceStatus = 'production' | 'hidden' | 'experimental' | 'demo-only';

export interface PanelManifestEntry {
  readonly id: PanelId;
  readonly status: PanelSurfaceStatus;
  readonly gaVisible: boolean;
  readonly navigationEligible: boolean;
  readonly windowMenu: boolean;
  readonly persistedLayoutEligible: boolean;
}

/** The only production-surface registry. Keep source-only panels explicit here. */
export const PANEL_MANIFEST: readonly PanelManifestEntry[] = [
  'media',
  'monitor',
  'timeline',
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
  'production',
]
  .map<PanelManifestEntry>((id) => ({
    id: id as PanelId,
    status: 'production' as const,
    gaVisible: true,
    navigationEligible: true,
    windowMenu: ['media', 'monitor', 'timeline', 'inspector', 'production'].includes(id),
    persistedLayoutEligible: true,
  }))
  .concat(
    ['flow', 'jobs', 'workflows', 'plugins', 'templates'].map<PanelManifestEntry>((id) => ({
      id: id as PanelId,
      status: 'hidden' as const,
      gaVisible: false,
      navigationEligible: false,
      windowMenu: false,
      persistedLayoutEligible: false,
    })),
  );

const manifestIds = (predicate: (entry: PanelManifestEntry) => boolean): readonly PanelId[] =>
  PANEL_MANIFEST.filter(predicate).map((entry) => entry.id);

export const GA_PANEL_IDS = manifestIds((entry) => entry.gaVisible);
export const NAVIGABLE_PANEL_IDS = manifestIds((entry) => entry.navigationEligible);
export const WINDOW_MENU_PANEL_IDS = manifestIds((entry) => entry.windowMenu);
export const PERSISTED_LAYOUT_PANEL_IDS = manifestIds((entry) => entry.persistedLayoutEligible);

/** Panels retained in source for migrations/tests but never exposed by the production shell. */
export const PRODUCTION_HIDDEN_PANEL_IDS = PANEL_MANIFEST.filter(
  (entry) => !entry.persistedLayoutEligible,
).map((entry) => entry.id);

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
export interface WorkspaceRecoveryOptions {
  /** Development-only escape hatch for source-registry layouts. */
  readonly development?: boolean;
}

export function recoverWorkspaceLayout(
  value: unknown,
  options: WorkspaceRecoveryOptions = {},
): WorkspaceLayout {
  if (!isLayout(value, options.development === true)) return DEFAULT_WORKSPACE;
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

function isLayout(value: unknown, development: boolean): value is WorkspaceLayout {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { version?: unknown; panels?: unknown };
  const panels = candidate.panels;
  const allowedPanelIds = development ? PANEL_IDS : PERSISTED_LAYOUT_PANEL_IDS;
  const panelSet =
    Array.isArray(panels) &&
    panels.every((panel) => typeof panel === 'string' && allowedPanelIds.includes(panel as PanelId))
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
    (isDefaultGaShape || (development && isFullRegistryShape)) &&
    new Set(panels).size === panels.length &&
    panels.every((panel) => typeof panel === 'string' && allowedPanelIds.includes(panel as PanelId))
  );
}
