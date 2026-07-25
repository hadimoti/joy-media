import type { ComponentType } from 'react';
import { SpeakerOnIcon } from './icons.js';
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
export const PANEL_TAB_ICONS: Readonly<Partial<Record<PanelId, string>>> = {
  media: '/assets/icons/assets.png',
  monitor: '/assets/icons/monitor.png',
  timeline: '/assets/icons/timeline.png',
  captions: '/assets/icons/ui/voice-memo_24x24.png',
  inspector: '/assets/icons/ui/inspect_24x24.png',
  motion: '/assets/icons/ui/motion_24x24.png',
  camera: '/assets/icons/camera.png',
  effects: '/assets/icons/ui/effects-org_24x24.png',
  transitions: '/assets/icons/ui/blend_24x24.png',
  color: '/assets/icons/ui/contrast_24x24.png',
  history: '/assets/icons/history2.png',
  diagnostics: '/assets/icons/diagnostic.png',
  jobs: '/assets/icons/job.png',
  agent: '/assets/icons/ui/agent-ai_24x24.png',
  workflows: '/assets/icons/workflow.png',
  plugins: '/assets/icons/plugin.png',
};

/** Inline SVG tab icons (preferred over PNG masks when present). */
export const PANEL_TAB_SVG_ICONS: Readonly<Partial<Record<PanelId, ComponentType>>> = {
  audio: SpeakerOnIcon,
};

export function panelLabel(panelId: string): string {
  return PANEL_LABELS[panelId as PanelId] ?? panelId;
}

export function panelTabIconUrl(panelId: string): string | undefined {
  return PANEL_TAB_ICONS[panelId as PanelId];
}

export function panelTabSvgIcon(panelId: string): ComponentType | undefined {
  return PANEL_TAB_SVG_ICONS[panelId as PanelId];
}
