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

import { PANEL_IDS, type PanelId } from './workspace.js';
import { panelLabel } from './panel-tab-icons.js';

export type EditorViewMode = 'vertical' | 'widescreen';

export const VIEW_MODE_KEY = 'joy-media.view-mode.v1';

/** Per-mode Dockview JSON keys (bump when a seed changes). */
export const DOCK_LAYOUT_VERSION = 11;
export const DOCK_LAYOUT_SCHEMA_VERSION = 2;

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
  'joy-media.dockview.v9',
  'joy-media.dockview.v10',
];

/**
 * Panels use icon-only tabs, so the dock can stay operable in a narrow editor
 * viewport without Dockview's default 100 px-per-group overflow.
 */
export const DOCK_PANEL_MINIMUM_WIDTH = 64;
export const DOCK_PANEL_MINIMUM_HEIGHT = 72;

const BROWSER_GROUP = ['media', 'effects'] as const;

const CONTEXT_GROUP = ['inspector'] as const;

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
  for (const id of PANEL_IDS) {
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
    if (!PANEL_IDS.includes(id as PanelId) || !isRecord(panel)) {
      panels[id] = panel;
      continue;
    }

    panels[id] = {
      ...panel,
      minimumWidth: DOCK_PANEL_MINIMUM_WIDTH,
      minimumHeight: DOCK_PANEL_MINIMUM_HEIGHT,
    };
    changed = true;
  }

  return changed ? { ...layout, panels } : layout;
}

const PANEL_ALIASES: Readonly<Record<string, string>> = {
  'color-grading': 'color',
  'motion-studio': 'motion',
  'dual-lens': 'flow',
  processes: 'jobs',
  library: 'templates',
};

/** Migrates renamed panels while retaining every unrelated Dockview field. */
export function migrateDockLayoutAliases(layout: unknown): unknown {
  if (!isRecord(layout)) return layout;
  const migrate = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(migrate);
    if (!isRecord(value)) return value;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) next[key] = migrate(child);
    if (Array.isArray(next.views))
      next.views = next.views.map((id) =>
        typeof id === 'string' ? (PANEL_ALIASES[id] ?? id) : id,
      );
    if (typeof next.activeView === 'string')
      next.activeView = PANEL_ALIASES[next.activeView] ?? next.activeView;
    if (typeof next.id === 'string') next.id = PANEL_ALIASES[next.id] ?? next.id;
    return next;
  };
  const migrated = migrate(layout) as Record<string, unknown>;
  if (isRecord(migrated.panels)) {
    const nextPanels: Record<string, unknown> = {};
    for (const [id, panel] of Object.entries(migrated.panels)) {
      const nextId = PANEL_ALIASES[id] ?? id;
      if (nextPanels[nextId] === undefined) nextPanels[nextId] = panel;
    }
    migrated.panels = nextPanels;
  }
  return { ...migrated, joyLayoutVersion: DOCK_LAYOUT_SCHEMA_VERSION };
}

/** Applies aliases, compact constraints, and the explicit saved-layout marker. */
export function migrateDockLayout(layout: unknown): unknown {
  return normalizeDockLayoutConstraints(migrateDockLayoutAliases(layout));
}

export function serializeDockLayout(layout: unknown): string {
  return JSON.stringify(migrateDockLayout(layout));
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
                    data: { views: ['agent'], activeView: 'agent', id: 'agent-col' },
                  },
                ],
              },
              {
                type: 'leaf',
                size: 476,
                data: { views: ['timeline', 'flow'], activeView: 'timeline', id: 'timeline-row' },
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
                data: { views: ['timeline', 'flow'], activeView: 'timeline', id: 'timeline-row' },
              },
              {
                type: 'leaf',
                size: 704,
                data: { views: ['agent'], activeView: 'agent', id: 'agent-col' },
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
