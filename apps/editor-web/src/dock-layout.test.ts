import { describe, expect, it } from 'vitest';
import {
  DOCK_PANEL_MINIMUM_HEIGHT,
  DOCK_PANEL_MINIMUM_WIDTH,
  defaultDockLayout,
  normalizeDockLayoutConstraints,
} from './dock-layout.js';
import { PANEL_IDS } from './workspace.js';

type LayoutWithPanels = {
  readonly panels: Record<string, Record<string, unknown>>;
  readonly grid?: unknown;
};

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
});
