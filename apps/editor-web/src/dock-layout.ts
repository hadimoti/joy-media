/**
 * Dockview arrangement seeds (DESIGN.md §3).
 *
 * Two named view modes — panel placement only; composition size is unchanged.
 *
 * Vertical (default) — Monitor full-height right for 1080×1920 short-form:
 *
 *   ┌──────────┬──────────┬──────────┬─────────┐
 *   │ Assets   │ Inspector│ Agent    │         │
 *   │ Effects  │ Motion   │          │ Program │
 *   │ …        │ …        │          │ Monitor │
 *   ├──────────┴──────────┴──────────┤         │
 *   │ Timeline · Dual Lens           │         │
 *   └────────────────────────────────┴─────────┘
 *
 * Widescreen — Monitor top-center:
 *
 *   ┌──────────┬─────────────────────┬──────────┐
 *   │ Assets   │ Program Monitor     │ Motion   │
 *   │ …        │                     │ …        │
 *   ├──────────┴──────────┬──────────┴──────────┤
 *   │ Timeline · Dual Lens│ Agent (Joy Code)    │
 *   └─────────────────────┴─────────────────────┘
 *
 * Seeded as JSON rather than sequential `addPanel` splits so proportions
 * survive. Sizes are relative — Dockview rescales them to the real container
 * against `grid.width` / `grid.height`.
 */

import { PERSISTED_LAYOUT_PANEL_IDS, type PanelId } from './workspace.js';
import { panelLabel } from './panel-tab-icons.js';

export type EditorViewMode = 'vertical' | 'widescreen';

export const VIEW_MODE_KEY = 'joy-media.view-mode.v1';

/** Per-mode Dockview JSON keys (bump when a seed changes). */
export const DOCK_LAYOUT_VERSION = 10;

/** @deprecated Prefer `dockLayoutKey(mode)` — kept for migration of v8 saves. */
export const DOCK_LAYOUT_KEY = 'joy-media.dockview.v8';

export const SUPERSEDED_DOCK_LAYOUT_KEYS: readonly string[] = [
  'joy-media.dockview.v1',
  'joy-media.dockview.v2',
  'joy-media.dockview.v3',
  'joy-media.dockview.v4',
  'joy-media.dockview.v5',
  'joy-media.dockview.v6',
  'joy-media.dockview.v7',
  'joy-media.dockview.v8',
];

/**
 * Panels use icon-only tabs, so the dock can stay operable in a narrow editor
 * viewport without Dockview's default 100 px-per-group overflow.
 */
export const DOCK_PANEL_MINIMUM_WIDTH = 64;
export const DOCK_PANEL_MINIMUM_HEIGHT = 72;

const BROWSER_GROUP = ['media', 'effects', 'transitions', 'captions', 'audio', 'color'] as const;

const CONTEXT_GROUP = ['inspector', 'motion', 'history', 'diagnostics', 'camera'] as const;

export interface ViewModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function dockLayoutKey(mode: EditorViewMode): string {
  return `joy-media.dockview.${mode}.v${DOCK_LAYOUT_VERSION}`;
}

export function isEditorViewMode(value: unknown): value is EditorViewMode {
  return value === 'vertical' || value === 'widescreen';
}

export function loadViewMode(storage: ViewModeStorage): EditorViewMode {
  const raw = storage.getItem(VIEW_MODE_KEY);
  if (isEditorViewMode(raw)) return raw;
  return 'vertical';
}

export function saveViewMode(storage: ViewModeStorage, mode: EditorViewMode): void {
  storage.setItem(VIEW_MODE_KEY, mode);
}

/** Copy legacy single-key v8 layout into the vertical per-mode slot once. */
export function migrateLegacyDockLayout(storage: ViewModeStorage): void {
  const verticalKey = dockLayoutKey('vertical');
  if (storage.getItem(verticalKey) !== null) return;
  const legacy = storage.getItem(DOCK_LAYOUT_KEY);
  if (legacy === null) return;
  storage.setItem(verticalKey, legacy);
}

export function seedDockLayout(mode: EditorViewMode): unknown {
  return mode === 'widescreen' ? widescreenDockLayout() : verticalDockLayout();
}

/** @deprecated Alias for vertical seed — tests and older call sites. */
export function defaultDockLayout(): unknown {
  return verticalDockLayout();
}

/** Dockview serialises every panel the same way; derive it so nothing drifts. */
function panelEntries(): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const id of PERSISTED_LAYOUT_PANEL_IDS) {
    entries[id] = {
      id,
      contentComponent: 'editor-panel',
      tabComponent: 'props.defaultTabComponent',
      title: panelLabel(id),
      minimumWidth: DOCK_PANEL_MINIMUM_WIDTH,
      minimumHeight: DOCK_PANEL_MINIMUM_HEIGHT,
    };
  }
  return entries;
}

/**
 * Saved Dockview JSON predates compact panel constraints. Add them while
 * preserving the user's grid, tabs, and any unknown future panel state.
 */
export function normalizeDockLayoutConstraints(layout: unknown): unknown {
  if (!isRecord(layout) || !isRecord(layout.panels)) return layout;

  let changed = false;
  const panels: Record<string, unknown> = {};
  for (const [id, panel] of Object.entries(layout.panels)) {
    if (!PERSISTED_LAYOUT_PANEL_IDS.includes(id as PanelId) || !isRecord(panel)) {
      changed = true;
      continue;
    }

    panels[id] = {
      ...panel,
      minimumWidth: DOCK_PANEL_MINIMUM_WIDTH,
      minimumHeight: DOCK_PANEL_MINIMUM_HEIGHT,
    };
    changed = true;
  }

  const sanitized = sanitizeHiddenViews(layout.grid);
  if (sanitized.changed) changed = true;
  return changed ? { ...layout, grid: sanitized.value, panels } : layout;
}

function sanitizeHiddenViews(value: unknown): {
  readonly value: unknown;
  readonly changed: boolean;
} {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.flatMap((entry) => {
      const sanitized = sanitizeHiddenViews(entry);
      changed ||= sanitized.changed;
      return sanitized.value === undefined ? [] : [sanitized.value];
    });
    return { value: next, changed };
  }
  if (!isRecord(value)) return { value, changed: false };

  // A stale leaf containing only hidden/unknown panels is not a valid
  // Dockview node. Remove it instead of allowing Dockview to mount a
  // fallback placeholder component for one of its invalid views.
  if (value.type === 'leaf' && isRecord(value.data) && Array.isArray(value.data.views)) {
    const validViews = value.data.views.filter(
      (view): view is string =>
        typeof view === 'string' && PERSISTED_LAYOUT_PANEL_IDS.includes(view as PanelId),
    );
    if (validViews.length === 0) return { value: undefined, changed: true };
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'views' && Array.isArray(child)) {
      const filtered = child.filter(
        (view): view is string =>
          typeof view === 'string' && PERSISTED_LAYOUT_PANEL_IDS.includes(view as PanelId),
      );
      changed ||= filtered.length !== child.length;
      next[key] = filtered;
      continue;
    }
    const sanitized = sanitizeHiddenViews(child);
    changed ||= sanitized.changed;
    next[key] = sanitized.value;
  }
  if (value.type === 'branch' && Array.isArray(next.data) && next.data.length === 0) {
    return { value: undefined, changed: true };
  }
  if (Array.isArray(next.views) && next.views.length > 0) {
    const activeView = next.activeView;
    if (
      typeof activeView === 'string' &&
      !PERSISTED_LAYOUT_PANEL_IDS.includes(activeView as PanelId)
    ) {
      next.activeView = next.views[0];
      changed = true;
    }
  }
  return { value: changed ? next : value, changed };
}

export function verticalDockLayout(): unknown {
  return {
    grid: {
      orientation: 'HORIZONTAL',
      width: 2200,
      height: 1000,
      root: {
        type: 'branch',
        size: 1000,
        data: [
          {
            // Everything except the monitor, stacked: tool row above timeline.
            type: 'branch',
            size: 1700,
            data: [
              {
                type: 'branch',
                size: 524,
                data: [
                  {
                    type: 'leaf',
                    size: 566,
                    data: { views: [...BROWSER_GROUP], activeView: 'media', id: 'browser' },
                  },
                  {
                    type: 'leaf',
                    size: 567,
                    data: { views: [...CONTEXT_GROUP], activeView: 'inspector', id: 'context' },
                  },
                  {
                    type: 'leaf',
                    size: 567,
                    // Production stays in the Joy Code utility stack so it is
                    // present on first launch without displacing the monitor
                    // or timeline from their primary positions.
                    data: { views: ['agent', 'production'], activeView: 'agent', id: 'agent-col' },
                  },
                ],
              },
              {
                type: 'leaf',
                size: 476,
                data: { views: ['timeline'], activeView: 'timeline', id: 'timeline-row' },
              },
            ],
          },
          {
            type: 'leaf',
            size: 500,
            data: { views: ['monitor'], activeView: 'monitor', id: 'monitor-col' },
          },
        ],
      },
    },
    panels: panelEntries(),
    activeGroup: 'monitor-col',
  };
}

export function widescreenDockLayout(): unknown {
  // Seed canvas 2200×1000 — top ~55% / bottom ~45%; top row browser|monitor|context.
  return {
    grid: {
      orientation: 'VERTICAL',
      width: 2200,
      height: 1000,
      root: {
        type: 'branch',
        size: 2200,
        data: [
          {
            type: 'branch',
            size: 550,
            data: [
              {
                type: 'leaf',
                size: 616,
                data: { views: [...BROWSER_GROUP], activeView: 'media', id: 'browser' },
              },
              {
                type: 'leaf',
                size: 968,
                data: { views: ['monitor'], activeView: 'monitor', id: 'monitor-row' },
              },
              {
                type: 'leaf',
                size: 616,
                data: { views: [...CONTEXT_GROUP], activeView: 'motion', id: 'context' },
              },
            ],
          },
          {
            type: 'branch',
            size: 450,
            data: [
              {
                type: 'leaf',
                size: 1496,
                data: { views: ['timeline'], activeView: 'timeline', id: 'timeline-row' },
              },
              {
                type: 'leaf',
                size: 704,
                // Keep the board discoverable beside Joy Code in widescreen.
                data: { views: ['agent', 'production'], activeView: 'agent', id: 'agent-col' },
              },
            ],
          },
        ],
      },
    },
    panels: panelEntries(),
    activeGroup: 'monitor-row',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
