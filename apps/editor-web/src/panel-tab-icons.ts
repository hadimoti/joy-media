import type { ComponentType } from 'react';
import { SpeakerOnIcon, TimelineClassicIcon } from './icons.js';
import type { PanelId } from './workspace.js';
import { iconUrl } from './icon-assets.js';

/** Human panel names — used for tooltips, aria-label, overflow menus, and dockview title. */
export const PANEL_LABELS: Readonly<Record<PanelId, string>> = {
  // Keep the durable Dockview ID `media` for existing saved layouts.
  media: 'Assets',
  monitor: 'Program Monitor',
  timeline: 'Timeline',
  flow: 'Dual Lens',
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
  agent: 'Joy Code',
  workflows: 'Workflows',
  plugins: 'Plugins',
  templates: 'Library',
};

/**
 * Dockview panel tab glyphs. Prefer uploaded `ui/` 24×24 PNGs where they map
 * cleanly; fall back to the older black-on-transparent set. Masked with
 * `currentColor` so active/inactive tab colors from DESIGN.md §1 apply.
 */
export const PANEL_TAB_ICONS: Readonly<Partial<Record<PanelId, string>>> = {
  media: iconUrl('assets.png'),
  monitor: iconUrl('monitor.png'),
  // Timeline draws from the shared SVG set below; Flow keeps the node-graph
  // mask. The two lenses sit in one dock group and must not share a glyph.
  flow: iconUrl('timeline.png'),
  captions: iconUrl('captions.png'),
  inspector: iconUrl('ui/inspect_24x24.png'),
  motion: iconUrl('ui/motion_24x24.png'),
  camera: iconUrl('camera.png'),
  effects: iconUrl('ui/effects-org_24x24.png'),
  transitions: iconUrl('ui/blend_24x24.png'),
  color: iconUrl('ui/contrast_24x24.png'),
  history: iconUrl('history2.png'),
  diagnostics: iconUrl('diagnostic.png'),
  jobs: iconUrl('job.png'),
  agent: iconUrl('ui/agent-ai_24x24.png'),
  workflows: iconUrl('workflow.png'),
  plugins: iconUrl('plugin.png'),
  templates: iconUrl('24_library.png'),
};

/** Inline SVG tab icons (preferred over PNG masks when present). */
export const PANEL_TAB_SVG_ICONS: Readonly<Partial<Record<PanelId, ComponentType>>> = {
  audio: SpeakerOnIcon,
  timeline: TimelineClassicIcon,
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
