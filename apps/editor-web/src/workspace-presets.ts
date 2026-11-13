import type { EditorViewMode, ViewModeStorage } from './dock-layout.js';
import {
  collapseJoyCodeGroup,
  dockLayoutKey,
  migrateDockLayout,
  serializeDockLayout,
  seedDockLayout,
} from './dock-layout.js';
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

/**
 * Separate keys keep each preset and view mode independent.
 *
 * Edit keeps using its established dock-layout key so saved layouts continue
 * to work without copying or deleting them during this migration.
 */
export function workspacePresetLayoutKey(mode: EditorViewMode, preset: WorkspacePresetId): string {
  if (preset === 'edit') return dockLayoutKey(mode);
  return `joy-media.workspace.${preset}.${mode}.v2`;
}

/** Persists one dock layout under the owning preset's key for that view mode. */
export function persistWorkspacePresetLayout(
  storage: ViewModeStorage,
  preset: WorkspacePresetId,
  mode: EditorViewMode,
  layout: unknown,
): string {
  const key = workspacePresetLayoutKey(mode, preset);
  storage.setItem(key, serializeDockLayout(layout));
  return key;
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

/**
 * The layout for a workspace that has never been saved.
 *
 * Joy Code is optional, so it stays out of the dock until the user asks for
 * it. `automate` is the Joy Code workspace and keeps it.
 */
export function firstRunWorkspaceLayout(preset: WorkspacePresetId, mode: EditorViewMode): unknown {
  const layout = preset === 'edit' ? seedDockLayout(mode) : workspacePresetLayout(preset, mode);
  if (preset === 'automate') return layout;
  return collapseJoyCodeGroup(layout);
}

export interface WorkspaceLayoutPlan {
  /** The layout to hand to Dockview. */
  readonly layout: unknown;
  /** True when the layout came from the user's own saved dock layout. */
  readonly restored: boolean;
  /** The storage key the layout is saved under. */
  readonly key: string;
}

/**
 * Which layout the editor opens with.
 *
 * A saved layout always wins: the user's own docking is never replaced by the
 * first-run default. Only when nothing is saved does the first-run layout
 * apply, and that one leaves Joy Code out of the dock (T-D06).
 */
export function planWorkspaceLayout(
  storage: ViewModeStorage,
  preset: WorkspacePresetId,
  mode: EditorViewMode,
): WorkspaceLayoutPlan {
  const key = workspacePresetLayoutKey(mode, preset);
  const saved = storage.getItem(key);
  if (saved !== null) {
    try {
      return { key, layout: migrateDockLayout(JSON.parse(saved)), restored: true };
    } catch {
      // A layout the editor cannot read is worse than no layout: drop it and
      // fall back to the first-run default.
      storage.removeItem(key);
    }
  }
  return { key, layout: firstRunWorkspaceLayout(preset, mode), restored: false };
}
