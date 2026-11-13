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
export const DOCK_LAYOUT_VERSION = 12;
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
  'joy-media.dockview.v11',
];

/**
 * Panels use icon-only tabs, so the dock can stay operable in a narrow editor
 * viewport without Dockview's default 100 px-per-group overflow.
 */
export const DOCK_PANEL_MINIMUM_WIDTH = 64;
export const DOCK_PANEL_MINIMUM_HEIGHT = 72;

const BROWSER_GROUP = ['media', 'effects'] as const;

// Keep specialist context panels in one reachable tab group. Animate is a tool
// inside the Enhance hub; the context group keeps its normal Inspector tab.
const CONTEXT_GROUP = ['inspector', 'scene3d', 'audio', 'jobs'] as const;

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

/** The view mode of a profile with no saved choice: widescreen, the preview-first layout (T-D12). */
export const DEFAULT_VIEW_MODE: EditorViewMode = 'widescreen';

export function loadViewMode(storage: ViewModeStorage): EditorViewMode {
  const raw = storage.getItem(VIEW_MODE_KEY);
  if (isEditorViewMode(raw)) return raw;
  return DEFAULT_VIEW_MODE;
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

/** The Dockview group that holds the Joy Code panel in both seeds. */
const JOY_CODE_GROUP_ID = 'agent-col';

/**
 * Takes the Joy Code group out of the grid.
 *
 * Joy Code is optional, so the editor does not reserve a column for it before
 * the user asks for it. The panel stays registered in `panels`, so the saved
 * layout still knows it and "Open Joy Code" can bring it back.
 */
export function collapseJoyCodeGroup(layout: unknown): unknown {
  if (!isRecord(layout) || !isRecord(layout.grid)) return layout;
  const grid = layout.grid;
  const root = grid.root;
  if (!isRecord(root) || !Array.isArray(root.data)) return layout;

  const strip = (nodes: readonly unknown[]): unknown[] =>
    nodes.flatMap((node) => {
      if (!isRecord(node)) return [node];
      const data = node.data;
      if (node.type === 'leaf' && isRecord(data) && data.id === JOY_CODE_GROUP_ID) {
        return [];
      }
      if (node.type === 'branch' && Array.isArray(data)) {
        const next = strip(data);
        // A branch that lost every child goes with it.
        return next.length === 0 ? [] : [{ ...node, data: next }];
      }
      return [node];
    });

  const nextRoot = { ...root, data: strip(root.data) };
  const nextLayout = { ...layout, grid: { ...grid, root: nextRoot } };
  if (layout.activeGroup === JOY_CODE_GROUP_ID) {
    return { ...nextLayout, activeGroup: 'monitor' };
  }
  return nextLayout;
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
  'creative-brief': 'agent',
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
      next.views = dedupeViewIds(
        next.views.map((id) => (typeof id === 'string' ? (PANEL_ALIASES[id] ?? id) : id)),
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
  return ensureScene3DInContextGroup(
    normalizeDockLayoutConstraints(removeRetiredMotionPanel(migrateDockLayoutAliases(layout))),
  );
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
                data: { views: [...CONTEXT_GROUP], activeView: 'inspector', id: 'context' },
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

function dedupeViewIds(values: readonly unknown[]): readonly unknown[] {
  const seen = new Set<string>();
  const next: unknown[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      next.push(value);
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    next.push(value);
  }
  return next;
}

/**
 * Existing Dockview saves are user-owned. Add the new 3D workspace tab to its
 * familiar Inspector group without replacing a custom grid or moving any tab.
 */
function removeRetiredMotionPanel(layout: unknown): unknown {
  if (!isRecord(layout)) return layout;
  const nextLayout: Record<string, unknown> = { ...layout };
  const removedGroupIds = new Set<string>();

  if (isRecord(layout.panels)) {
    const panels = { ...layout.panels };
    delete panels.motion;
    nextLayout.panels = panels;
  }

  const stripGroupData = (
    data: unknown,
    defaultActiveView: boolean,
  ): Record<string, unknown> | undefined => {
    if (!isRecord(data) || !Array.isArray(data.views)) return isRecord(data) ? data : undefined;
    const hadMotion = data.views.includes('motion');
    const views = data.views.filter((view) => view !== 'motion');
    const id = typeof data.id === 'string' ? data.id : undefined;
    if (views.length === 0) {
      if (!hadMotion) return data;
      if (id === 'context') return { ...data, views: ['inspector'], activeView: 'inspector' };
      if (id !== undefined) removedGroupIds.add(id);
      return undefined;
    }

    const activeView =
      typeof data.activeView === 'string' && views.includes(data.activeView)
        ? data.activeView
        : views.includes('inspector')
          ? 'inspector'
          : views[0];
    return {
      ...data,
      views,
      ...((typeof data.activeView === 'string' || defaultActiveView) && activeView !== undefined
        ? { activeView }
        : {}),
    };
  };

  const stripGridNode = (node: unknown, isRoot = false): unknown | undefined => {
    if (!isRecord(node)) return node;
    if (node.type === 'leaf' && isRecord(node.data) && Array.isArray(node.data.views)) {
      const data = stripGroupData(node.data, true);
      if (data === undefined) return undefined;
      return { ...node, data };
    }
    if (node.type === 'branch' && Array.isArray(node.data)) {
      const children = node.data
        .map((child) => stripGridNode(child))
        .filter((child) => child !== undefined);
      if (children.length === 0) return undefined;
      if (!isRoot && children.length === 1 && children.length < node.data.length)
        return children[0];
      return { ...node, data: children };
    }
    return node;
  };

  const stripSerializedGroups = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    return value
      .map((group) => {
        if (!isRecord(group) || !isRecord(group.data) || !Array.isArray(group.data.views)) {
          return group;
        }
        const data = stripGroupData(group.data, false);
        return data === undefined ? undefined : { ...group, data };
      })
      .filter((group) => group !== undefined);
  };

  if (Array.isArray(layout.floatingGroups)) {
    nextLayout.floatingGroups = stripSerializedGroups(layout.floatingGroups);
  }
  if (Array.isArray(layout.popoutGroups)) {
    nextLayout.popoutGroups = stripSerializedGroups(layout.popoutGroups);
  }

  const grid = layout.grid;
  if (isRecord(grid) && 'root' in grid) {
    const root = stripGridNode(grid.root, true);
    if (root === undefined) {
      const hasDetachedGroups =
        (Array.isArray(nextLayout.floatingGroups) && nextLayout.floatingGroups.length > 0) ||
        (Array.isArray(nextLayout.popoutGroups) && nextLayout.popoutGroups.length > 0);
      if (hasDetachedGroups) {
        const hasRemovedPopoutAnchor =
          Array.isArray(nextLayout.popoutGroups) &&
          nextLayout.popoutGroups.some(
            (group) =>
              isRecord(group) &&
              typeof group.gridReferenceGroup === 'string' &&
              removedGroupIds.has(group.gridReferenceGroup),
          );
        const detachedGroupIds = new Set<string>();
        for (const groups of [nextLayout.floatingGroups, nextLayout.popoutGroups]) {
          if (!Array.isArray(groups)) continue;
          for (const group of groups) {
            if (isRecord(group) && isRecord(group.data) && typeof group.data.id === 'string') {
              detachedGroupIds.add(group.data.id);
            }
          }
        }

        const rootSize =
          isRecord(grid.root) && typeof grid.root.size === 'number' ? grid.root.size : 1000;
        let root: Record<string, unknown> = {
          ...(isRecord(grid.root) ? grid.root : {}),
          type: 'branch',
          data: [],
        };
        if (hasRemovedPopoutAnchor) {
          let anchorId = 'motion-migration-root';
          let suffix = 1;
          while (detachedGroupIds.has(anchorId)) anchorId = `motion-migration-root-${suffix++}`;
          root = {
            ...root,
            data: [
              {
                type: 'leaf',
                size: rootSize,
                data: { id: anchorId, views: [] },
              },
            ],
          };
        }
        nextLayout.grid = { ...grid, root };
      } else {
        const mode = grid.orientation === 'VERTICAL' ? 'widescreen' : 'vertical';
        const seeded = seedDockLayout(mode) as Record<string, unknown>;
        const seededGrid = seeded.grid as Record<string, unknown>;
        nextLayout.grid = { ...seededGrid, ...grid, root: seededGrid.root };
        nextLayout.panels = {
          ...(isRecord(seeded.panels) ? seeded.panels : {}),
          ...(isRecord(nextLayout.panels) ? nextLayout.panels : {}),
        };
      }
    } else {
      nextLayout.grid = { ...grid, root };
    }
  }

  const groupIds: string[] = [];
  const activeGroupIds: string[] = [];
  const collectGridGroups = (
    node: unknown,
    includeEmptyGroups: boolean,
    groups: string[],
  ): void => {
    if (!isRecord(node)) return;
    if (node.type === 'leaf' && isRecord(node.data) && typeof node.data.id === 'string') {
      if (includeEmptyGroups || !Array.isArray(node.data.views) || node.data.views.length > 0) {
        groups.push(node.data.id);
      }
      return;
    }
    if (node.type === 'branch' && Array.isArray(node.data)) {
      node.data.forEach((child) => collectGridGroups(child, includeEmptyGroups, groups));
    }
  };
  const nextGrid = nextLayout.grid;
  if (isRecord(nextGrid)) {
    collectGridGroups(nextGrid.root, true, groupIds);
    collectGridGroups(nextGrid.root, false, activeGroupIds);
  }
  for (const groups of [nextLayout.floatingGroups, nextLayout.popoutGroups]) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (isRecord(group) && isRecord(group.data) && typeof group.data.id === 'string') {
        groupIds.push(group.data.id);
        if (!Array.isArray(group.data.views) || group.data.views.length > 0) {
          activeGroupIds.push(group.data.id);
        }
      }
    }
  }

  const fallbackGroup = activeGroupIds.includes('context')
    ? 'context'
    : (activeGroupIds[0] ?? groupIds[0]);
  if (
    typeof nextLayout.activeGroup === 'string' &&
    !groupIds.includes(nextLayout.activeGroup) &&
    (removedGroupIds.has(nextLayout.activeGroup) || nextLayout.activeGroup === 'motion')
  ) {
    if (fallbackGroup === undefined) delete nextLayout.activeGroup;
    else nextLayout.activeGroup = fallbackGroup;
  }

  if (Array.isArray(nextLayout.popoutGroups)) {
    nextLayout.popoutGroups = nextLayout.popoutGroups.map((group) => {
      if (!isRecord(group) || !removedGroupIds.has(String(group.gridReferenceGroup))) return group;
      const gridGroups: string[] = [];
      if (isRecord(nextGrid)) collectGridGroups(nextGrid.root, true, gridGroups);
      const gridReferenceGroup = gridGroups.includes('context') ? 'context' : gridGroups[0];
      const { gridReferenceGroup: _removedReference, ...withoutRemovedReference } = group;
      return gridReferenceGroup === undefined
        ? withoutRemovedReference
        : { ...withoutRemovedReference, gridReferenceGroup };
    });
  }

  return nextLayout;
}

function ensureScene3DInContextGroup(layout: unknown): unknown {
  if (!isRecord(layout)) return layout;
  const migrate = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(migrate);
    if (!isRecord(value)) return value;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) next[key] = migrate(child);
    if (next.id === 'context' && Array.isArray(next.views) && !next.views.includes('scene3d')) {
      const inspectorIndex = next.views.indexOf('inspector');
      const insertionIndex = inspectorIndex < 0 ? next.views.length : inspectorIndex + 1;
      next.views = [
        ...next.views.slice(0, insertionIndex),
        'scene3d',
        ...next.views.slice(insertionIndex),
      ];
    }
    return next;
  };
  const migrated = migrate(layout) as Record<string, unknown>;
  if (!isRecord(migrated.panels) || migrated.panels.scene3d !== undefined) return migrated;
  return {
    ...migrated,
    panels: {
      ...migrated.panels,
      scene3d: panelEntries().scene3d,
    },
  };
}
