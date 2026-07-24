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
  color: 'Color',
  history: 'History',
  diagnostics: 'Diagnostics',
  jobs: 'Jobs',
  agent: 'Agent',
  workflows: 'Workflows',
  plugins: 'Plugins',
};

/**
 * Dockview panel tab glyphs (black-on-transparent PNGs under
 * `public/assets/icons/`). Masked with `currentColor` so active/inactive
 * tab colors from DESIGN.md §1 apply.
 */
export const PANEL_TAB_ICONS: Readonly<Record<PanelId, string>> = {
  media: '/assets/icons/assets.png',
  monitor: '/assets/icons/monitor.png',
  timeline: '/assets/icons/timeline.png',
  captions: '/assets/icons/captions.png',
  inspector: '/assets/icons/inspect.png',
  motion: '/assets/icons/motion.png',
  camera: '/assets/icons/camera.png',
  audio: '/assets/icons/captions.png',
  effects: '/assets/icons/motion.png',
  color: '/assets/icons/diagnostic.png',
  history: '/assets/icons/history2.png',
  diagnostics: '/assets/icons/diagnostic.png',
  jobs: '/assets/icons/job.png',
  agent: '/assets/icons/agent.png',
  workflows: '/assets/icons/workflow.png',
  plugins: '/assets/icons/plugin.png',
};

export function panelLabel(panelId: string): string {
  return PANEL_LABELS[panelId as PanelId] ?? panelId;
}

export function panelTabIconUrl(panelId: string): string | undefined {
  return PANEL_TAB_ICONS[panelId as PanelId];
}
