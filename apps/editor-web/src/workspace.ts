export const PANEL_IDS = [
  'media',
  'monitor',
  'timeline',
  'inspector',
  'history',
  'diagnostics',
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export interface WorkspaceLayout {
  readonly version: 1;
  readonly panels: readonly PanelId[];
}

export const DEFAULT_WORKSPACE: WorkspaceLayout = {
  version: 1,
  panels: ['media', 'monitor', 'timeline', 'inspector', 'history', 'diagnostics'],
};

/** Layout is a user preference, isolated from the creative project document. */
export function recoverWorkspaceLayout(value: unknown): WorkspaceLayout {
  if (!isLayout(value)) return DEFAULT_WORKSPACE;
  return value;
}

function isLayout(value: unknown): value is WorkspaceLayout {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { version?: unknown; panels?: unknown };
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.panels) &&
    candidate.panels.length === PANEL_IDS.length &&
    new Set(candidate.panels).size === PANEL_IDS.length &&
    candidate.panels.every(
      (panel) => typeof panel === 'string' && PANEL_IDS.includes(panel as PanelId),
    )
  );
}
