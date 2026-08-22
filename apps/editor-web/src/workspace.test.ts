import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE, GA_PANEL_IDS, PANEL_IDS, recoverWorkspaceLayout } from './workspace.js';
import { searchActions } from './editor-state.js';

describe('editor workspace contracts', () => {
  it('restores a safe default for malformed layouts', () => {
    expect(recoverWorkspaceLayout({ version: 1, panels: ['timeline'] })).toEqual(DEFAULT_WORKSPACE);
  });
  it('keeps experimental platform panels out of the GA default workspace', () => {
    expect(DEFAULT_WORKSPACE.panels).toEqual(GA_PANEL_IDS);
    expect(PANEL_IDS).toEqual(
      expect.arrayContaining(['jobs', 'workflows', 'production', 'plugins', 'templates']),
    );
    expect(DEFAULT_WORKSPACE.panels).not.toEqual(
      expect.arrayContaining(['jobs', 'workflows', 'production', 'plugins', 'templates']),
    );
  });
  it('exposes command-palette actions through one shortcut registry', () => {
    expect(searchActions('undo')).toMatchObject([{ id: 'history.undo', shortcut: 'Mod+Z' }]);
  });
});
