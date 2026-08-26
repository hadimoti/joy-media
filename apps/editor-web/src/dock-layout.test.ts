import { describe, expect, it } from 'vitest';
import {
  DOCK_LAYOUT_KEY,
  DOCK_PANEL_MINIMUM_HEIGHT,
  DOCK_PANEL_MINIMUM_WIDTH,
  defaultDockLayout,
  dockLayoutKey,
  loadViewMode,
  migrateLegacyDockLayout,
  normalizeDockLayoutConstraints,
  saveViewMode,
  seedDockLayout,
  verticalDockLayout,
  widescreenDockLayout,
} from './dock-layout.js';
import { PERSISTED_LAYOUT_PANEL_IDS } from './workspace.js';

type LayoutWithPanels = {
  readonly panels: Record<string, Record<string, unknown>>;
  readonly grid?: {
    readonly orientation?: string;
    readonly root?: {
      readonly data?: ReadonlyArray<{
        readonly data?: ReadonlyArray<{
          readonly data?: { readonly id?: string; readonly activeView?: string };
        }>;
      }>;
    };
  };
  readonly activeGroup?: string;
};

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    removeItem(key: string) {
      map.delete(key);
    },
    snapshot() {
      return Object.fromEntries(map);
    },
  };
}

function leafIds(layout: LayoutWithPanels): string[] {
  const ids: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record.type === 'leaf' && isRecord(record.data) && typeof record.data.id === 'string') {
      ids.push(record.data.id);
      return;
    }
    if (record.type === 'branch' && Array.isArray(record.data)) {
      for (const child of record.data) walk(child);
    }
  };
  walk(layout.grid?.root);
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

describe('dock layout constraints', () => {
  it('seeds every editor panel with compact, resize-safe minimums', () => {
    const layout = defaultDockLayout() as LayoutWithPanels;

    expect(Object.keys(layout.panels)).toEqual(PERSISTED_LAYOUT_PANEL_IDS);
    for (const panel of Object.values(layout.panels)) {
      expect(panel.minimumWidth).toBe(DOCK_PANEL_MINIMUM_WIDTH);
      expect(panel.minimumHeight).toBe(DOCK_PANEL_MINIMUM_HEIGHT);
    }
  });

  it('migrates saved editor panels and drops unknown panels in production', () => {
    const savedLayout = {
      grid: { root: { type: 'branch', data: ['keep-this-grid'] } },
      panels: {
        media: {
          id: 'media',
          minimumWidth: 100,
          minimumHeight: 100,
          maximumWidth: 500,
        },
        futurePanel: { id: 'futurePanel', minimumWidth: 999 },
      },
    };

    const migrated = normalizeDockLayoutConstraints(savedLayout) as LayoutWithPanels;

    expect(migrated).not.toBe(savedLayout);
    expect(migrated.grid).toEqual(savedLayout.grid);
    expect(migrated.panels.media).toMatchObject({
      id: 'media',
      minimumWidth: DOCK_PANEL_MINIMUM_WIDTH,
      minimumHeight: DOCK_PANEL_MINIMUM_HEIGHT,
      maximumWidth: 500,
    });
    expect(migrated.panels).not.toHaveProperty('futurePanel');
    expect(savedLayout.panels.media.minimumWidth).toBe(100);
    expect(savedLayout.panels.media.minimumHeight).toBe(100);
  });

  it('removes hidden experimental panels from persisted layout state', () => {
    const migrated = normalizeDockLayoutConstraints({
      grid: {
        root: {
          type: 'leaf',
          data: { views: ['timeline', 'flow', 'plugins'], activeView: 'plugins', id: 'saved' },
        },
      },
      panels: {
        timeline: { id: 'timeline' },
        flow: { id: 'flow' },
        plugins: { id: 'plugins' },
      },
    }) as LayoutWithPanels;

    expect(migrated.panels).not.toHaveProperty('flow');
    expect(migrated.panels).not.toHaveProperty('plugins');
    expect((migrated.grid?.root as Record<string, unknown>).data).toMatchObject({
      views: ['timeline'],
      activeView: 'timeline',
    });
  });

  it('removes leaves whose views are all stale so no fallback placeholder can mount', () => {
    const migrated = normalizeDockLayoutConstraints({
      grid: {
        root: {
          type: 'branch',
          data: [
            {
              type: 'leaf',
              data: { views: ['flow', 'plugins'], activeView: 'plugins', id: 'stale-only' },
            },
            {
              type: 'leaf',
              data: {
                views: ['timeline', 'unknown-panel'],
                activeView: 'unknown-panel',
                id: 'valid',
              },
            },
          ],
        },
      },
      panels: {
        flow: { id: 'flow' },
        plugins: { id: 'plugins' },
        timeline: { id: 'timeline' },
        'unknown-panel': { id: 'unknown-panel' },
      },
    }) as LayoutWithPanels;

    const leaves: Array<Record<string, unknown>> = [];
    const walk = (node: unknown): void => {
      if (!isRecord(node)) return;
      if (node.type === 'leaf') {
        leaves.push(node);
        return;
      }
      if (Array.isArray(node.data)) for (const child of node.data) walk(child);
    };
    walk(migrated.grid?.root);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.data).toMatchObject({
      views: ['timeline'],
      activeView: 'timeline',
    });
    expect(leaves.some((leaf) => (leaf.data as Record<string, unknown>).id === 'stale-only')).toBe(
      false,
    );
  });
});

describe('view modes', () => {
  it('defaults view mode to vertical and persists widescreen', () => {
    const storage = memoryStorage();
    expect(loadViewMode(storage)).toBe('vertical');
    saveViewMode(storage, 'widescreen');
    expect(loadViewMode(storage)).toBe('widescreen');
  });

  it('migrates legacy v8 layout into the vertical per-mode key once', () => {
    const storage = memoryStorage({ [DOCK_LAYOUT_KEY]: '{"grid":{"legacy":true}}' });
    migrateLegacyDockLayout(storage);
    expect(storage.getItem(dockLayoutKey('vertical'))).toBe('{"grid":{"legacy":true}}');
    storage.setItem(dockLayoutKey('vertical'), '{"grid":{"kept":true}}');
    migrateLegacyDockLayout(storage);
    expect(storage.getItem(dockLayoutKey('vertical'))).toBe('{"grid":{"kept":true}}');
  });

  it('widescreen seed includes every panel and distinct grid shape', () => {
    const vertical = verticalDockLayout() as LayoutWithPanels;
    const wide = widescreenDockLayout() as LayoutWithPanels;

    expect(Object.keys(wide.panels)).toEqual(PERSISTED_LAYOUT_PANEL_IDS);
    for (const panel of Object.values(wide.panels)) {
      expect(panel.minimumWidth).toBe(DOCK_PANEL_MINIMUM_WIDTH);
      expect(panel.minimumHeight).toBe(DOCK_PANEL_MINIMUM_HEIGHT);
    }

    expect(vertical.grid?.orientation).toBe('HORIZONTAL');
    expect(wide.grid?.orientation).toBe('VERTICAL');
    expect(leafIds(vertical)).toContain('monitor-col');
    expect(leafIds(wide)).toContain('monitor-row');
    expect(leafIds(wide)).not.toContain('monitor-col');
    expect(wide.activeGroup).toBe('monitor-row');
    expect(seedDockLayout('widescreen')).toEqual(wide);
    expect(seedDockLayout('vertical')).toEqual(vertical);
  });

  it('seeds Production in both GA layouts while keeping experimental panels closed', () => {
    const experimental = new Set(['flow', 'jobs', 'workflows', 'plugins', 'templates']);
    const views = (layout: unknown): string[] => {
      const out: string[] = [];
      const walk = (node: unknown): void => {
        if (!isRecord(node)) return;
        if (isRecord(node.data) && Array.isArray(node.data.views)) {
          out.push(...node.data.views.filter((view): view is string => typeof view === 'string'));
        }
        if (Array.isArray(node.data)) for (const child of node.data) walk(child);
      };
      walk((layout as LayoutWithPanels).grid?.root);
      return out;
    };

    expect(views(verticalDockLayout()).some((view) => experimental.has(view))).toBe(false);
    expect(views(widescreenDockLayout()).some((view) => experimental.has(view))).toBe(false);
    expect(views(verticalDockLayout())).toContain('production');
    expect(views(widescreenDockLayout())).toContain('production');
  });
});
