import { describe, expect, it } from 'vitest';
import { dockLayoutKey, verticalDockLayout } from './dock-layout.js';
import {
  firstRunWorkspaceLayout,
  planWorkspaceLayout,
  workspacePresetLayout,
} from './workspace-presets.js';
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
    ['enhance', 'motion'],
    ['audio-captions', 'audio'],
    ['automate', 'jobs'],
  ] as const)('keeps the %s context view reachable', (preset, requestedView) => {
    const layout = workspacePresetLayout(preset, 'vertical');
    expect(leafViews(layout, 'context')).toContain(requestedView);
    expect((layout as { grid: { root: unknown } }).grid.root).toBeDefined();
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
});
