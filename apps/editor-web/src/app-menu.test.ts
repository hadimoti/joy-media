import { describe, expect, it } from 'vitest';
import { APP_MENU_GROUPS, panelIdFromMenuAction, isPanelMenuAction } from './app-menu.js';
import { searchActions } from './editor-state.js';

describe('app-menu catalog', () => {
  it('puts every menu action id in the command palette', () => {
    const menuIds = APP_MENU_GROUPS.flatMap((group) => group.items.map((item) => item.id));
    // searchActions('') is the list the palette renders, so the check reads the real list.
    const paletteIds = searchActions('').map((action) => action.id);
    expect(menuIds.filter((id) => !paletteIds.includes(id))).toEqual([]);
    // Each id appears once in the palette, even when two menus share it.
    expect(new Set(paletteIds).size).toBe(paletteIds.length);
  });

  it('lists the command palette once, under Edit', () => {
    const paletteItems = APP_MENU_GROUPS.flatMap((group) =>
      group.items
        .filter((item) => item.label === 'Command Palette…')
        .map((item) => [group.id, item.id]),
    );
    expect(paletteItems).toEqual([['edit', 'edit.commandPalette']]);
  });

  it('builds the Clip menu from the clip commands that exist, with Delete shared with Edit', () => {
    const clip = APP_MENU_GROUPS.find((group) => group.id === 'clip');
    expect(clip?.items.map((item) => item.label)).toEqual([
      'Split at Playhead',
      'Duplicate Clip',
      'Delete',
      'Speed…',
    ]);
    const edit = APP_MENU_GROUPS.find((group) => group.id === 'edit');
    expect(edit?.items.map((item) => item.label)).toContain('Delete');
    expect(edit?.items.map((item) => item.label).join('|')).not.toContain('Cut');
    expect(clip?.items.find((item) => item.label === 'Delete')?.id).toBe('clip.delete');
    expect(edit?.items.find((item) => item.label === 'Delete')?.id).toBe('clip.delete');
  });

  it('finds palette entries by menu label', () => {
    expect(searchActions('split')).toMatchObject([
      { id: 'clip.split', title: 'Split at Playhead', shortcut: 'S' },
    ]);
  });

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

  it('omits account and sign-out actions from File', () => {
    const file = APP_MENU_GROUPS.find((group) => group.id === 'file');
    expect(file?.items.map((item) => item.id)).not.toContain('file.account');
    expect(file?.items.map((item) => item.id)).not.toContain('file.signOut');
  });

  it('keeps the Joy Code menu focused on the project conversation and settings', () => {
    const agent = APP_MENU_GROUPS.find((group) => group.id === 'agent');
    expect(agent?.items.map((item) => item.label)).toEqual([
      'Open Joy Code',
      'Built-in JOY Agent Engine',
      'Execution Mode…',
      'Pause / Stop',
      'Joy Code Settings…',
    ]);
  });

  it('parses panel focus actions', () => {
    expect(isPanelMenuAction('view.panel.timeline')).toBe(true);
    expect(panelIdFromMenuAction('view.panel.timeline')).toBe('timeline');
    expect(panelIdFromMenuAction('window.panel.media')).toBe('media');
    expect(panelIdFromMenuAction('edit.undo')).toBeUndefined();
  });
});
