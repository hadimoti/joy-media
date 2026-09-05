import type { PanelId } from './workspace.js';
import { PANEL_LABELS } from './panel-tab-icons.js';

export type PanelIntent = 'media' | 'edit' | 'enhance' | 'automation' | 'system';
export type WorkspacePresetId = 'edit' | 'enhance' | 'audio-captions' | 'automate' | 'custom';

export interface PanelMetadata {
  readonly id: PanelId;
  readonly label: string;
  readonly intent: PanelIntent;
  readonly command: string;
  readonly defaultPresets: readonly WorkspacePresetId[];
  /** Feature is reached inside a hub and omitted from the top-level View menu. */
  readonly nested?: boolean;
}

const panel = (
  id: PanelId,
  intent: PanelIntent,
  command: string,
  defaultPresets: readonly WorkspacePresetId[],
  nested = false,
): PanelMetadata => ({
  id,
  label: PANEL_LABELS[id],
  intent,
  command,
  defaultPresets,
  ...(nested ? { nested: true } : {}),
});

/**
 * The single discoverability map for View, the command palette, Dockview
 * affordances, and workspace presets. Durable panel IDs stay unchanged.
 */
export const PANEL_METADATA: readonly PanelMetadata[] = [
  panel('media', 'media', 'Open Create', ['edit', 'enhance', 'audio-captions', 'automate']),
  panel('captions', 'media', 'Open Captions', ['audio-captions', 'edit'], true),
  panel('text', 'media', 'Open Text', ['edit', 'enhance'], true),
  panel('audio', 'media', 'Open Audio', ['audio-captions', 'edit'], true),
  panel('monitor', 'edit', 'Open Program Monitor', [
    'edit',
    'enhance',
    'audio-captions',
    'automate',
  ]),
  panel('timeline', 'edit', 'Open Timeline', ['edit', 'enhance', 'audio-captions', 'automate']),
  panel('inspector', 'edit', 'Open Inspector', ['edit', 'enhance']),
  panel('scene3d', 'edit', 'Open 3D Scene', ['edit', 'enhance']),
  panel('history', 'edit', 'Open History', ['edit']),
  panel('flow', 'edit', 'Open Flow', ['edit', 'automate']),
  panel('effects', 'enhance', 'Open Enhance', ['enhance', 'edit']),
  panel('transitions', 'enhance', 'Open Transitions', ['enhance', 'edit'], true),
  panel('color', 'enhance', 'Open Color', ['enhance'], true),
  panel('motion', 'enhance', 'Open Animate', ['enhance'], true),
  panel('camera', 'enhance', 'Open Camera', ['enhance']),
  panel('templates', 'media', 'Open Library', ['edit', 'enhance'], true),
  panel('agent', 'automation', 'Open Joy Code', ['automate']),
  panel('workflows', 'automation', 'Open Workflows', ['automate']),
  panel('jobs', 'automation', 'Open Jobs', ['automate']),
  panel('diagnostics', 'system', 'Open Diagnostics', ['edit', 'automate']),
  panel('plugins', 'system', 'Open Plugins', ['edit', 'automate']),
];

export const PANEL_METADATA_BY_ID: Readonly<Record<PanelId, PanelMetadata>> = Object.fromEntries(
  PANEL_METADATA.map((entry) => [entry.id, entry]),
) as Record<PanelId, PanelMetadata>;

export const PANEL_INTENT_LABELS: Readonly<Record<PanelIntent, string>> = {
  media: 'Media',
  edit: 'Edit',
  enhance: 'Enhance',
  automation: 'Automation',
  system: 'System',
};

export const PANEL_INTENT_ORDER: readonly PanelIntent[] = [
  'media',
  'edit',
  'enhance',
  'automation',
  'system',
];

export function panelsForIntent(intent: PanelIntent): readonly PanelMetadata[] {
  return PANEL_METADATA.filter((entry) => entry.intent === intent && entry.nested !== true);
}

export function panelMetadata(panelId: PanelId): PanelMetadata {
  return PANEL_METADATA_BY_ID[panelId];
}
