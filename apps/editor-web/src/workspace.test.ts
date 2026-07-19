import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE, recoverWorkspaceLayout } from './workspace.js';
import { searchActions } from './editor-state.js';

describe('editor workspace contracts', () => {
  it('restores a safe default for malformed layouts', () => {
    expect(recoverWorkspaceLayout({ version: 1, panels: ['timeline'] })).toEqual(DEFAULT_WORKSPACE);
  });
  it('exposes command-palette actions through one shortcut registry', () => {
    expect(searchActions('undo')).toMatchObject([{ id: 'history.undo', shortcut: 'Mod+Z' }]);
  });
});
