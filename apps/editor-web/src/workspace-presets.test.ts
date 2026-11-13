import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW_MODE, dockLayoutKey, verticalDockLayout } from './dock-layout.js';
import {
  firstRunWorkspaceLayout,
  planWorkspaceLayout,
  persistWorkspacePresetLayout,
  resetWorkspaceTarget,
  workspacePresetLayoutKey,
  workspacePresetLayout,
} from './workspace-presets.js';
import { DEFAULT_EDITOR_UI_PREFERENCES } from './ui-preferences.js';
import { PANEL_IDS } from './workspace.js';

function leafIds(layout: unknown): string[] {
  const ids: string[] = [];
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === 'leaf' && record.data && typeof record.data === 'object') {
      const data = record.data as Record<string, unknown>;
      if (typeof data.id === 'string') ids.push(data.id);
    }
    Object.values(record).forEach(visit);
  };
  visit(layout);
  return ids;
}

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
    entries() {
      return [...map.entries()];
    },
  };
}

function leafViews(layout: unknown, id: string): string[] {
  const views: string[] = [];
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === 'leaf' && record.data && typeof record.data === 'object') {
      const data = record.data as Record<string, unknown>;
      if (data.id === id && Array.isArray(data.views)) {
        views.push(...data.views.filter((view): view is string => typeof view === 'string'));
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(layout);
  return views;
}

function leafActiveView(layout: unknown, id: string): string | undefined {
  let activeView: string | undefined;
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === 'leaf' && record.data && typeof record.data === 'object') {
      const data = record.data as Record<string, unknown>;
      if (data.id === id && typeof data.activeView === 'string') activeView = data.activeView;
    }
    Object.values(record).forEach(visit);
  };
  visit(layout);
  return activeView;
}

describe('workspace presets', () => {
  it('keeps the edit preset as the normal seeded layout', () => {
    expect(workspacePresetLayout('edit', 'vertical')).toBeDefined();
  });

  it('changes the active group to the task intent without changing panel IDs', () => {
    const editLayout = workspacePresetLayout('edit', 'vertical') as {
      readonly panels: Record<string, unknown>;
    };
    const layout = workspacePresetLayout('audio-captions', 'vertical') as {
      readonly panels: Record<string, unknown>;
    };
    expect(Object.keys(layout.panels).sort()).toEqual(Object.keys(editLayout.panels).sort());
  });

  it.each([
    ['audio-captions', 'audio'],
    ['automate', 'jobs'],
  ] as const)('keeps the %s context view reachable', (preset, requestedView) => {
    const layout = workspacePresetLayout(preset, 'vertical');
    expect(leafViews(layout, 'context')).toContain(requestedView);
    expect((layout as { grid: { root: unknown } }).grid.root).toBeDefined();
  });

  it('opens the Animate tool in the Enhance hub with Inspector selected', () => {
    const layout = workspacePresetLayout('enhance', 'vertical');

    expect(leafViews(layout, 'browser')).toContain('effects');
    expect(leafViews(layout, 'context')).toContain('inspector');
    expect(leafActiveView(layout, 'context')).toBe('inspector');
    expect(JSON.stringify(layout)).not.toContain('"motion"');
  });
});

describe('first-run layout', () => {
  it('leaves Joy Code out of the dock on the very first run', () => {
    const cases = [
      ['vertical', 'monitor-col'],
      ['widescreen', 'monitor-row'],
    ] as const;
    for (const [mode, monitorGroup] of cases) {
      const layout = firstRunWorkspaceLayout('edit', mode);

      expect(leafIds(layout)).not.toContain('agent-col');
      // Every panel stays registered, so "Open Joy Code" can still bring it back.
      expect(Object.keys((layout as { panels: Record<string, unknown> }).panels).sort()).toEqual(
        [...PANEL_IDS].sort(),
      );
      expect(leafIds(layout)).toContain(monitorGroup);
    }
  });

  it('keeps Joy Code in the Automate workspace, which is about Joy Code', () => {
    expect(leafIds(firstRunWorkspaceLayout('automate', 'vertical'))).toContain('agent-col');
  });

  it('lets a saved layout win over the first-run collapse', () => {
    const saved = JSON.stringify(verticalDockLayout());
    const storage = memoryStorage({ [dockLayoutKey('vertical')]: saved });

    const plan = planWorkspaceLayout(storage, 'edit', 'vertical');

    expect(plan.restored).toBe(true);
    expect(plan.key).toBe(dockLayoutKey('vertical'));
    expect(leafIds(plan.layout)).toContain('agent-col');
    // The saved layout fixture is untouched.
    expect(storage.getItem(dockLayoutKey('vertical'))).toBe(saved);
  });

  it('uses the collapsed first-run layout when nothing is saved', () => {
    const storage = memoryStorage();

    const plan = planWorkspaceLayout(storage, 'edit', 'vertical');

    expect(plan.restored).toBe(false);
    expect(plan.key).toBe(dockLayoutKey('vertical'));
    expect(leafIds(plan.layout)).not.toContain('agent-col');
  });

  it('drops a saved layout it cannot read and falls back to the first run', () => {
    const storage = memoryStorage({ [dockLayoutKey('vertical')]: '{not json' });

    const plan = planWorkspaceLayout(storage, 'edit', 'vertical');

    expect(plan.restored).toBe(false);
    expect(storage.getItem(dockLayoutKey('vertical'))).toBeNull();
    expect(leafIds(plan.layout)).not.toContain('agent-col');
  });

  it('gives a fresh profile the preview-first Edit layout (T-D12)', () => {
    const storage = memoryStorage();

    const plan = planWorkspaceLayout(storage, 'edit', DEFAULT_VIEW_MODE);

    expect(DEFAULT_VIEW_MODE).toBe('widescreen');
    expect(plan.restored).toBe(false);
    expect(plan.key).toBe(dockLayoutKey('widescreen'));
    // The widescreen seed puts the monitor in the top row, centre of the screen.
    expect(leafIds(plan.layout)).toContain('monitor-row');
    expect(leafIds(plan.layout)).not.toContain('agent-col');
  });

  it('restores a stored layout from the old default exactly as it was saved (T-D12)', () => {
    // A layout saved before this change: the old vertical default, Joy Code in its column.
    const oldLayout = JSON.stringify(verticalDockLayout());
    const storage = memoryStorage({ [dockLayoutKey('vertical')]: oldLayout });

    const plan = planWorkspaceLayout(storage, 'edit', 'vertical');

    expect(plan.restored).toBe(true);
    // The old vertical seed's monitor column is 500 wide, beside a 1000-wide tool area: kept as saved.
    const root = (plan.layout as { grid: { root: { data: { size: number; data: unknown }[] } } })
      .grid.root;
    expect(root.data[1]?.size).toBe(500);
    expect(leafIds(plan.layout)).toContain('monitor-col');
    expect(leafIds(plan.layout)).toContain('agent-col');
    // The stored bytes are not rewritten by the restore.
    expect(storage.getItem(dockLayoutKey('vertical'))).toBe(oldLayout);
  });

  it('the preview-first Edit layout puts the monitor top-centre and large (T-D12 round 2)', () => {
    const layout = planWorkspaceLayout(memoryStorage(), 'edit', 'widescreen').layout as {
      grid: { root: { data: { size: number; data: { id?: string } & unknown }[] } };
    };
    const [topRow, bottomRow] = layout.grid.root.data as unknown as [
      { size: number; data: { size: number; data: { id: string } }[] },
      { size: number },
    ];
    // The top row is 550 of 1000: the picture is the first thing on screen.
    expect(topRow.size).toBe(550);
    expect(bottomRow.size).toBe(450);
    // Browser, monitor, context across the top; the monitor is the middle and the largest.
    const row = topRow.data as unknown as { size: number; data: { id: string } }[];
    expect(row.map((cell) => cell.data.id)).toEqual(['browser', 'monitor-row', 'context']);
    expect(row[1]!.size).toBeGreaterThan(row[0]!.size);
    expect(row[1]!.size).toBeGreaterThan(row[2]!.size);
  });

  it('Reset Workspace applies the mode and preset the preferences are reset to (T-D12 round 2)', async () => {
    expect(resetWorkspaceTarget()).toEqual({
      mode: DEFAULT_EDITOR_UI_PREFERENCES.viewMode,
      preset: DEFAULT_EDITOR_UI_PREFERENCES.workspacePreset,
    });
    const appSource = await readFile(new URL('./App.tsx', import.meta.url), 'utf8');
    const start = appSource.indexOf('const resetWorkspace = useCallback');
    const end = appSource.indexOf('const switchEditorView = useCallback', start);
    expect(start).toBeGreaterThanOrEqual(0);
    const block = appSource.slice(start, end);
    expect(block).toContain('applyDockLayout(api, target.mode, target.preset)');
    expect(block).not.toContain("applyDockLayout(api, 'vertical'");
  });

  it('a stored widescreen layout also loads unchanged (T-D12)', () => {
    const savedWidescreen = JSON.stringify(firstRunWorkspaceLayout('edit', 'widescreen'));
    const storage = memoryStorage({ [dockLayoutKey('widescreen')]: savedWidescreen });

    const plan = planWorkspaceLayout(storage, 'edit', 'widescreen');

    expect(plan.restored).toBe(true);
    expect(storage.getItem(dockLayoutKey('widescreen'))).toBe(savedWidescreen);
  });
});

describe('workspace preset layout persistence', () => {
  it('keeps each preset and view mode in its own storage slot', () => {
    const storage = memoryStorage();
    const editVertical = '{"layoutMarker":"saved edit vertical"}';
    const automateVertical = '{"layoutMarker":"saved automate vertical"}';
    const automateWidescreen = '{"layoutMarker":"saved automate widescreen"}';

    storage.setItem(workspacePresetLayoutKey('vertical', 'edit'), editVertical);
    storage.setItem(workspacePresetLayoutKey('vertical', 'automate'), automateVertical);
    storage.setItem(workspacePresetLayoutKey('widescreen', 'automate'), automateWidescreen);

    expect(workspacePresetLayoutKey('vertical', 'edit')).toBe('joy-media.dockview.vertical.v12');
    expect(storage.getItem('joy-media.dockview.vertical.v12')).toBe(editVertical);
    expect(storage.getItem('joy-media.workspace.automate.vertical.v2')).toBe(automateVertical);
    expect(storage.getItem('joy-media.workspace.automate.widescreen.v2')).toBe(automateWidescreen);
    expect(
      (planWorkspaceLayout(storage, 'edit', 'vertical').layout as { layoutMarker: string })
        .layoutMarker,
    ).toBe('saved edit vertical');
    expect(
      (planWorkspaceLayout(storage, 'automate', 'vertical').layout as { layoutMarker: string })
        .layoutMarker,
    ).toBe('saved automate vertical');
    expect(
      (planWorkspaceLayout(storage, 'automate', 'widescreen').layout as { layoutMarker: string })
        .layoutMarker,
    ).toBe('saved automate widescreen');
  });

  it('keeps the collapsed first-run Edit layout after visiting Automate', () => {
    const storage = memoryStorage();
    const firstEdit = planWorkspaceLayout(storage, 'edit', 'vertical');
    expect(firstEdit.key).toBe(workspacePresetLayoutKey('vertical', 'edit'));
    storage.setItem(firstEdit.key, JSON.stringify(firstEdit.layout));

    const automate = planWorkspaceLayout(storage, 'automate', 'vertical');
    storage.setItem(
      workspacePresetLayoutKey('vertical', 'automate'),
      JSON.stringify(automate.layout),
    );

    const editAfterAutomate = planWorkspaceLayout(storage, 'edit', 'vertical');

    expect(editAfterAutomate.restored).toBe(true);
    expect(leafIds(editAfterAutomate.layout)).not.toContain('agent-col');
  });

  it('never changes a saved Edit layout while Automate is active', () => {
    const storage = memoryStorage();
    const savedEdit = JSON.stringify(verticalDockLayout());
    const editKey = workspacePresetLayoutKey('vertical', 'edit');
    storage.setItem(editKey, savedEdit);

    storage.setItem(
      workspacePresetLayoutKey('vertical', 'automate'),
      JSON.stringify(workspacePresetLayout('automate', 'vertical')),
    );

    expect(storage.getItem(editKey)).toBe(savedEdit);
    const edit = planWorkspaceLayout(storage, 'edit', 'vertical');
    expect(edit.key).toBe(editKey);
    expect(edit.restored).toBe(true);
    expect(leafIds(edit.layout)).toContain('agent-col');
  });

  it('keeps the saved Edit layout byte-for-byte intact while Automate persists its layout', () => {
    const storage = memoryStorage();
    const editKey = workspacePresetLayoutKey('vertical', 'edit');
    const automateKey = workspacePresetLayoutKey('vertical', 'automate');
    const savedEdit = JSON.stringify(firstRunWorkspaceLayout('edit', 'vertical'));
    storage.setItem(editKey, savedEdit);

    const changedAutomateLayout = {
      ...(workspacePresetLayout('automate', 'vertical') as Record<string, unknown>),
      layoutMarker: 'automate layout changed',
    };
    persistWorkspacePresetLayout(storage, 'automate', 'vertical', changedAutomateLayout);

    expect(storage.getItem(editKey)).toBe(savedEdit);
    expect(
      storage
        .entries()
        .map(([key]) => key)
        .sort(),
    ).toEqual([editKey, automateKey].sort());
    expect(JSON.parse(storage.getItem(automateKey) ?? 'null').layoutMarker).toBe(
      'automate layout changed',
    );

    const editAfterAutomate = planWorkspaceLayout(storage, 'edit', 'vertical');
    expect(editAfterAutomate.restored).toBe(true);
    expect(leafIds(editAfterAutomate.layout)).not.toContain('agent-col');
    expect(storage.getItem(editKey)).toBe(savedEdit);
  });

  it('routes App layout-change and view-mode saves through preset-aware persistence', async () => {
    const appSource = await readFile(new URL('./App.tsx', import.meta.url), 'utf8');
    const switchStart = appSource.indexOf('const switchEditorView = useCallback');
    const switchEnd = appSource.indexOf('const recordExportEntry = useCallback', switchStart);
    const layoutListenerStart = appSource.indexOf('const persistDockLayout = () =>');
    const layoutListenerEnd = appSource.indexOf(
      'event.api.onDidLayoutChange(persistDockLayout)',
      layoutListenerStart,
    );

    expect(switchStart).toBeGreaterThanOrEqual(0);
    expect(switchEnd).toBeGreaterThan(switchStart);
    expect(layoutListenerStart).toBeGreaterThanOrEqual(0);
    expect(layoutListenerEnd).toBeGreaterThan(layoutListenerStart);
    expect(appSource.slice(switchStart, switchEnd)).toMatch(
      /persistWorkspacePresetLayout\(\s*storage,\s*workspacePresetRef\.current,\s*current,\s*api\.toJSON\(\),?\s*\)/,
    );
    expect(appSource.slice(layoutListenerStart, layoutListenerEnd)).toMatch(
      /persistWorkspacePresetLayout\(\s*storage,\s*workspacePresetRef\.current,\s*viewModeRef\.current,\s*event\.api\.toJSON\(\),?\s*\)/,
    );
  });
});
