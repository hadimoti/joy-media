import type { PanelId } from './workspace.js';

/** Human panel names — used for tooltips, aria-label, overflow menus, and dockview title. */
export const PANEL_LABELS: Readonly<Record<PanelId, string>> = {
  // Keep the durable Dockview ID `media` for existing saved layouts.
  media: 'Assets',
  monitor: 'Program Monitor',
  timeline: 'Timeline',
  captions: 'Captions',
  inspector: 'Inspector',
  motion: 'Motion',
  camera: 'Camera',
  audio: 'Audio',
  effects: 'Effects',
  transitions: 'Transitions',
  color: 'Color',
  history: 'History',
  diagnostics: 'Diagnostics',
  jobs: 'Jobs',
  agent: 'Agent',
  workflows: 'Workflows',
  plugins: 'Plugins',
};

/**
 * Dockview panel tab glyphs. Prefer uploaded `ui/` 24×24 PNGs where they map
 * cleanly; fall back to the older black-on-transparent set. Masked with
 * `currentColor` so active/inactive tab colors from DESIGN.md §1 apply.
 */
export const PANEL_TAB_ICONS: Readonly<Record<PanelId, string>> = {
  media: '/assets/icons/ui/4squares_24x24.png',
  monitor: '/assets/icons/monitor.png',
  timeline: '/assets/icons/timeline.png',
  captions: '/assets/icons/ui/voice-icon_24x24.png',
  inspector: '/assets/icons/ui/setting-gear_24x24.png',
  motion: '/assets/icons/ui/effects-org_24x24.png',
  camera: '/assets/icons/camera.png',
  audio: '/assets/icons/ui/speaker-on_24x24.png',
  effects: '/assets/icons/ui/effects_24x24.png',
  transitions: '/assets/icons/ui/transition_24x24.png',
  color: '/assets/icons/ui/effects2_24x24.png',
  history: '/assets/icons/history2.png',
  diagnostics: '/assets/icons/diagnostic.png',
  jobs: '/assets/icons/job.png',
  agent: '/assets/icons/ui/ai-effect_24x24.png',
  workflows: '/assets/icons/workflow.png',
  plugins: '/assets/icons/plugin.png',
};

export function panelLabel(panelId: string): string {
  return PANEL_LABELS[panelId as PanelId] ?? panelId;
}

export function panelTabIconUrl(panelId: string): string | undefined {
  return PANEL_TAB_ICONS[panelId as PanelId];
}
