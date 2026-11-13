import { describe, expect, it } from 'vitest';
import {
  DOCK_LAYOUT_KEY,
  DOCK_PANEL_MINIMUM_HEIGHT,
  DOCK_PANEL_MINIMUM_WIDTH,
  collapseJoyCodeGroup,
  defaultDockLayout,
  dockLayoutKey,
  loadViewMode,
  migrateLegacyDockLayout,
  normalizeDockLayoutConstraints,
  migrateDockLayout,
  migrateDockLayoutAliases,
  serializeDockLayout,
  saveViewMode,
  seedDockLayout,
  verticalDockLayout,
  widescreenDockLayout,
} from './dock-layout.js';
import { PANEL_IDS } from './workspace.js';

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

function leafViews(layout: LayoutWithPanels, id: string): string[] {
  let views: string[] = [];
  const walk = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (node.type === 'leaf' && isRecord(node.data) && node.data.id === id) {
      views = Array.isArray(node.data.views)
        ? node.data.views.filter((view): view is string => typeof view === 'string')
        : [];
      return;
    }
    if (node.type === 'branch' && Array.isArray(node.data)) {
      for (const child of node.data) walk(child);
    }
  };
  walk(layout.grid?.root);
  return views;
}

function leafActiveView(layout: LayoutWithPanels, id: string): string | undefined {
  let activeView: string | undefined;
  const walk = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (node.type === 'leaf' && isRecord(node.data) && node.data.id === id) {
      activeView = typeof node.data.activeView === 'string' ? node.data.activeView : undefined;
      return;
    }
    if (node.type === 'branch' && Array.isArray(node.data)) {
      for (const child of node.data) walk(child);
    }
  };
  walk(layout.grid?.root);
  return activeView;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

describe('dock layout constraints', () => {
  it('seeds every editor panel with compact, resize-safe minimums', () => {
    const layout = defaultDockLayout() as LayoutWithPanels;

    expect(Object.keys(layout.panels)).toEqual(PANEL_IDS);
    for (const panel of Object.values(layout.panels)) {
      expect(panel.minimumWidth).toBe(DOCK_PANEL_MINIMUM_WIDTH);
      expect(panel.minimumHeight).toBe(DOCK_PANEL_MINIMUM_HEIGHT);
    }
  });

  it('migrates saved editor panels without disturbing the user layout', () => {
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
    expect(migrated.panels.futurePanel).toBe(savedLayout.panels.futurePanel);
    expect(savedLayout.panels.media.minimumWidth).toBe(100);
    expect(savedLayout.panels.media.minimumHeight).toBe(100);
  });

  it('migrates renamed panels and stamps the saved layout version', () => {
    const migrated = migrateDockLayoutAliases({
      panels: { 'color-grading': { id: 'color-grading' }, media: { id: 'media' } },
      grid: {
        root: {
          type: 'leaf',
          data: { views: ['color-grading', 'dual-lens'], activeView: 'color-grading' },
        },
      },
    }) as Record<string, unknown>;
    expect(migrated.joyLayoutVersion).toBe(2);
    expect((migrated.panels as Record<string, unknown>).color).toBeDefined();
    expect(JSON.stringify(migrated)).not.toContain('color-grading');
    const normalized = migrateDockLayout(migrated) as Record<string, unknown>;
    expect(normalized.joyLayoutVersion).toBe(2);
    expect(normalized.panels).toMatchObject({
      color: { minimumWidth: DOCK_PANEL_MINIMUM_WIDTH, minimumHeight: DOCK_PANEL_MINIMUM_HEIGHT },
    });
    expect(JSON.parse(serializeDockLayout(migrated)).joyLayoutVersion).toBe(2);
  });

  it('migrates legacy Creative Brief tabs into Joy Code without duplicate tabs', () => {
    const migrated = migrateDockLayoutAliases({
      panels: {
        agent: { id: 'agent' },
        'creative-brief': { id: 'creative-brief' },
      },
      grid: {
        root: {
          type: 'leaf',
          data: {
            id: 'agent-col',
            views: ['agent', 'creative-brief'],
            activeView: 'creative-brief',
          },
        },
      },
    }) as Record<string, unknown>;

    expect((migrated.panels as Record<string, unknown>).agent).toBeDefined();
    expect((migrated.panels as Record<string, unknown>)['creative-brief']).toBeUndefined();
    expect(JSON.stringify(migrated)).not.toContain('creative-brief');
    expect(migrated.grid).toMatchObject({
      root: {
        data: {
          views: ['agent'],
          activeView: 'agent',
        },
      },
    });
  });

  it('drops the retired Animate tab and adds 3D Scene to the saved context group', () => {
    const migrated = migrateDockLayout({
      panels: { inspector: { id: 'inspector' }, motion: { id: 'motion' } },
      grid: {
        root: {
          type: 'leaf',
          data: { id: 'context', views: ['inspector', 'motion'], activeView: 'motion' },
        },
      },
    }) as LayoutWithPanels;
    expect(leafViews(migrated, 'context')).toEqual(['inspector', 'scene3d']);
    expect(migrated.panels.motion).toBeUndefined();
    expect(leafActiveView(migrated, 'context')).toBe('inspector');
    expect(migrated.panels.scene3d).toMatchObject({ id: 'scene3d' });
  });

  it('prunes an old Animate-only group and repairs the saved active group', () => {
    const migrated = migrateDockLayout({
      grid: {
        orientation: 'HORIZONTAL',
        root: {
          type: 'branch',
          size: 1000,
          data: [
            {
              type: 'branch',
              size: 500,
              data: [
                {
                  type: 'leaf',
                  size: 300,
                  data: { id: 'context', views: ['inspector', 'motion'], activeView: 'motion' },
                },
                {
                  type: 'leaf',
                  size: 200,
                  data: { id: 'motion-only', views: ['motion'], activeView: 'motion' },
                },
              ],
            },
            {
              type: 'leaf',
              size: 500,
              data: { id: 'monitor-col', views: ['monitor'], activeView: 'monitor' },
            },
          ],
        },
      },
      panels: {
        inspector: { id: 'inspector' },
        motion: { id: 'motion' },
        monitor: { id: 'monitor' },
      },
      activeGroup: 'motion-only',
    }) as LayoutWithPanels;

    expect(leafIds(migrated)).not.toContain('motion-only');
    expect(leafIds(migrated)).toContain('context');
    expect(leafViews(migrated, 'context')).toEqual(['inspector', 'scene3d']);
    expect(migrated.activeGroup).toBe('context');
    expect(migrated.panels.motion).toBeUndefined();
    expect(JSON.stringify(migrated)).not.toContain('"motion"');
  });

  it('preserves existing single-child branches when no Animate group is removed', () => {
    const migrated = migrateDockLayout({
      grid: {
        orientation: 'HORIZONTAL',
        root: {
          type: 'branch',
          data: [
            {
              type: 'branch',
              data: [
                {
                  type: 'leaf',
                  data: { id: 'context', views: ['inspector'], activeView: 'inspector' },
                },
              ],
            },
            {
              type: 'leaf',
              data: { id: 'monitor-col', views: ['monitor'], activeView: 'monitor' },
            },
          ],
        },
      },
      panels: { inspector: { id: 'inspector' }, monitor: { id: 'monitor' } },
    }) as LayoutWithPanels;

    const root = migrated.grid?.root as unknown as { data?: readonly { type?: string }[] };
    expect(root.data?.[0]?.type).toBe('branch');
  });
});

describe('Joy Code collapsed layout', () => {
  it('takes the Joy Code group out of the grid but keeps the panel registered', () => {
    const collapsed = collapseJoyCodeGroup(verticalDockLayout()) as LayoutWithPanels;

    expect(leafIds(collapsed)).not.toContain('agent-col');
    expect(Object.keys(collapsed.panels)).toEqual(PANEL_IDS);
    // The rest of the workspace is untouched.
    expect(leafIds(collapsed)).toContain('monitor-col');
    expect(leafIds(collapsed)).toContain('timeline-row');
    expect(collapsed.activeGroup).toBe('monitor-col');
  });

  it('collapses the widescreen seed as well', () => {
    const collapsed = collapseJoyCodeGroup(widescreenDockLayout()) as LayoutWithPanels;

    expect(leafIds(collapsed)).not.toContain('agent-col');
    expect(leafIds(collapsed)).toContain('monitor-row');
    expect(Object.keys(collapsed.panels)).toEqual(PANEL_IDS);
  });

  it('leaves a layout without a Joy Code group alone', () => {
    const withoutJoyCode = {
      grid: { root: { type: 'leaf', data: { id: 'monitor-col', views: ['monitor'] } } },
      panels: { monitor: { id: 'monitor' } },
    };

    expect(collapseJoyCodeGroup(withoutJoyCode)).toEqual(withoutJoyCode);
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

    expect(Object.keys(wide.panels)).toEqual(PANEL_IDS);
    for (const panel of Object.values(wide.panels)) {
      expect(panel.minimumWidth).toBe(DOCK_PANEL_MINIMUM_WIDTH);
      expect(panel.minimumHeight).toBe(DOCK_PANEL_MINIMUM_HEIGHT);
    }

    expect(vertical.grid?.orientation).toBe('HORIZONTAL');
    expect(wide.grid?.orientation).toBe('VERTICAL');
    expect(leafIds(vertical)).toContain('monitor-col');
    expect(leafIds(wide)).toContain('monitor-row');
    expect(leafIds(wide)).not.toContain('monitor-col');
    expect(leafViews(vertical, 'monitor-col')).toEqual(['monitor']);
    expect(leafViews(wide, 'monitor-row')).toEqual(['monitor']);
    expect(wide.activeGroup).toBe('monitor-row');
    expect(seedDockLayout('widescreen')).toEqual(wide);
    expect(seedDockLayout('vertical')).toEqual(vertical);
  });
});
