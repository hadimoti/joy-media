import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE, recoverWorkspaceLayout } from './workspace.js';
import { searchActions } from './editor-state.js';

describe('editor workspace contracts', () => {
  it('restores a safe default for malformed layouts', () => {
    expect(recoverWorkspaceLayout({ version: 1, panels: ['timeline'] })).toEqual(DEFAULT_WORKSPACE);
  });
  it('adds 3D Scene beside Inspector for an intact v1 preference', () => {
    const legacy = {
      version: 1,
      panels: DEFAULT_WORKSPACE.panels.filter((panel) => panel !== 'scene3d'),
    };
    expect(recoverWorkspaceLayout(legacy)).toMatchObject({ version: 2 });
    expect(recoverWorkspaceLayout(legacy).panels).toContain('scene3d');
  });
  it('exposes command-palette actions through one shortcut registry', () => {
    expect(searchActions('undo')).toMatchObject([{ id: 'history.undo', shortcut: 'Mod+Z' }]);
  });
});
