import { describe, expect, it } from 'vitest';
import { APP_MENU_GROUPS, panelIdFromMenuAction, isPanelMenuAction } from './app-menu.js';

describe('app-menu catalog', () => {
  it('exposes Adobe-style top-level menus', () => {
    expect(APP_MENU_GROUPS.map((group) => group.id)).toEqual([
      'file',
      'edit',
      'clip',
      'agent',
      'view',
      'window',
    ]);
  });

  it('includes Projects Library under File', () => {
    const file = APP_MENU_GROUPS.find((group) => group.id === 'file');
    expect(file?.items.some((item) => item.id === 'file.projects')).toBe(true);
  });

  it('keeps the Joy Code menu focused on KiloCode task entry points and settings', () => {
    const agent = APP_MENU_GROUPS.find((group) => group.id === 'agent');
    expect(agent?.items.map((item) => item.label)).toEqual([
      'Open Joy Code',
      'New Task',
      'Editing Host: KiloCode',
      'Execution Mode…',
      'Pause / Stop Task',
      'Joy Code History',
      'Joy Code Settings…',
    ]);
  });

  it('parses panel focus actions', () => {
    expect(isPanelMenuAction('view.panel.timeline')).toBe(true);
    expect(panelIdFromMenuAction('view.panel.timeline')).toBe('timeline');
    expect(panelIdFromMenuAction('window.panel.media')).toBe('media');
    expect(panelIdFromMenuAction('edit.undo')).toBeUndefined();
  });

  it('advertises Production in View and Window while keeping experimental panels hidden', () => {
    const view = APP_MENU_GROUPS.find((group) => group.id === 'view');
    const window = APP_MENU_GROUPS.find((group) => group.id === 'window');
    expect(view?.items.map((item) => item.id)).toEqual(
      expect.arrayContaining(['view.panel.production']),
    );
    expect(window?.items.map((item) => item.id)).toEqual(
      expect.arrayContaining(['window.panel.production']),
    );
    expect(view?.items.map((item) => item.id)).not.toEqual(
      expect.arrayContaining([
        'view.panel.jobs',
        'view.panel.workflows',
        'view.panel.plugins',
        'view.panel.templates',
      ]),
    );
  });
});
