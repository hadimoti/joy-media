import type { EditorViewMode } from './dock-layout.js';
import { seedDockLayout } from './dock-layout.js';
import type { WorkspacePresetId } from './panel-metadata.js';

export interface WorkspacePresetSpec {
  readonly id: WorkspacePresetId;
  readonly label: string;
  readonly description: string;
}

export const WORKSPACE_PRESETS: readonly WorkspacePresetSpec[] = [
  { id: 'edit', label: 'Edit', description: 'Assets, Monitor, Inspector, and Timeline' },
  { id: 'enhance', label: 'Enhance', description: 'Effects, Transitions, Color, and Motion' },
  {
    id: 'audio-captions',
    label: 'Audio & Captions',
    description: 'Audio, Captions, Monitor, and Timeline',
  },
  { id: 'automate', label: 'Automate', description: 'Joy Code, Workflows, and Jobs' },
  { id: 'custom', label: 'Custom', description: 'Your manually docked layout' },
];

export function workspacePresetLabel(id: WorkspacePresetId): string {
  return WORKSPACE_PRESETS.find((preset) => preset.id === id)?.label ?? 'Edit';
}

/** Separate keys keep a user's Custom layout independent from named presets. */
export function workspacePresetLayoutKey(mode: EditorViewMode, preset: WorkspacePresetId): string {
  return `joy-media.workspace.${preset}.${mode}.v2`;
}

export function workspacePresetLayout(preset: WorkspacePresetId, mode: EditorViewMode): unknown {
  const layout = structuredClone(seedDockLayout(mode));
  if (preset === 'edit' || preset === 'custom') return layout;

  const activeByGroup: Record<string, string> =
    preset === 'enhance'
      ? {
          browser: 'effects',
          context: 'motion',
          'monitor-row': 'monitor',
          'monitor-col': 'monitor',
        }
      : preset === 'audio-captions'
        ? {
            browser: 'captions',
            context: 'audio',
            'monitor-row': 'monitor',
            'monitor-col': 'monitor',
          }
        : {
            browser: 'media',
            context: 'jobs',
            'monitor-row': 'monitor',
            'monitor-col': 'monitor',
            'agent-col': 'agent',
          };

  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    const data = record.data;
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      const group = data as Record<string, unknown>;
      if (typeof group.id === 'string' && activeByGroup[group.id] !== undefined) {
        const requested = activeByGroup[group.id];
        const views = Array.isArray(group.views) ? group.views : [];
        if (views.includes(requested)) group.activeView = requested;
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(layout);
  return layout;
}
