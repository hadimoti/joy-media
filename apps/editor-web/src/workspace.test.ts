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

  it('drops the removed Animate panel from an older v2 preference', () => {
    const priorPanels: readonly string[] = DEFAULT_WORKSPACE.panels;
    const legacy = {
      version: 2,
      panels: [...priorPanels.filter((panel) => panel !== 'motion'), 'motion'],
    };

    const migrated = recoverWorkspaceLayout(legacy);

    expect(migrated.panels).toEqual(DEFAULT_WORKSPACE.panels);
    expect(migrated.panels).not.toContain('motion');
  });

  it('drops the removed Animate panel while adding 3D to an older v1 preference', () => {
    const priorPanels: readonly string[] = DEFAULT_WORKSPACE.panels;
    const legacy = {
      version: 1,
      panels: [...priorPanels.filter((panel) => panel !== 'scene3d'), 'motion'],
    };

    const migrated = recoverWorkspaceLayout(legacy);

    expect(migrated.panels).toContain('scene3d');
    expect(migrated.panels).not.toContain('motion');
  });

  it('exposes command-palette actions through one shortcut registry', () => {
    expect(searchActions('undo')).toMatchObject([{ id: 'edit.undo', shortcut: 'Ctrl+Z' }]);
  });
});
