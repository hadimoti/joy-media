import type { ComponentType } from 'react';
import {
  AgentIcon,
  AutoCaptionIcon,
  CameraIcon,
  ColorAdjustIcon,
  DiagnosticsIcon,
  DissolveIcon,
  EnhanceIcon,
  FlowGraphIcon,
  HistoryIcon,
  InspectorIcon,
  JobsIcon,
  LibraryIcon,
  MediaGridIcon,
  MonitorIcon,
  MotionPathIcon,
  PlugIcon,
  SpeakerOnIcon,
  TextTabIcon,
  TimelineClassicIcon,
  WorkflowPathIcon,
} from './icons.js';
import type { PanelId } from './workspace.js';
import { iconUrl } from './icon-assets.js';

/** Human panel names — used for tooltips, aria-label, overflow menus, and dockview title. */
export const PANEL_LABELS: Readonly<Record<PanelId, string>> = {
  // Keep the durable Dockview ID `media` for existing saved layouts.
  media: 'Create',
  monitor: 'Program Monitor',
  timeline: 'Timeline',
  flow: 'Flow',
  captions: 'Captions',
  text: 'Text',
  inspector: 'Inspector',
  scene3d: '3D Scene',
  motion: 'Animate',
  camera: 'Camera',
  audio: 'Audio',
  effects: 'Enhance',
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
 * The one PNG mask that stays: the 3D tab has its own cube outline (T-P01).
 * Every other panel draws an inline SVG from the shared outline set, so the
 * whole app has one weight, one grid and one colour.
 */
export const PANEL_TAB_ICONS: Readonly<Partial<Record<PanelId, string>>> = {
  scene3d: iconUrl('ui/cube-3d_24x24.png'),
};

/**
 * The panel tab glyphs: one outline set at 16 px with a 1.5 px stroke. Every
 * panel gets its own glyph, so two panels in the same dock group never show
 * the same picture.
 */
export const PANEL_TAB_SVG_ICONS: Readonly<Partial<Record<PanelId, ComponentType>>> = {
  media: MediaGridIcon,
  monitor: MonitorIcon,
  timeline: TimelineClassicIcon,
  flow: FlowGraphIcon,
  captions: AutoCaptionIcon,
  text: TextTabIcon,
  inspector: InspectorIcon,
  motion: MotionPathIcon,
  camera: CameraIcon,
  audio: SpeakerOnIcon,
  effects: EnhanceIcon,
  transitions: DissolveIcon,
  color: ColorAdjustIcon,
  history: HistoryIcon,
  diagnostics: DiagnosticsIcon,
  jobs: JobsIcon,
  agent: AgentIcon,
  workflows: WorkflowPathIcon,
  plugins: PlugIcon,
  templates: LibraryIcon,
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
