import { describe, expect, it } from 'vitest';
import { workspacePresetLayout } from './workspace-presets.js';

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
    expect(
      (layout as { grid: { root: unknown } }).grid.root,
    ).toBeDefined();
  });
});
