import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE,
  GA_PANEL_IDS,
  PANEL_IDS,
  PANEL_MANIFEST,
  PERSISTED_LAYOUT_PANEL_IDS,
  WINDOW_MENU_PANEL_IDS,
  recoverWorkspaceLayout,
} from './workspace.js';
import { searchActions } from './editor-state.js';

describe('editor workspace contracts', () => {
  it('restores a safe default for malformed layouts', () => {
    expect(recoverWorkspaceLayout({ version: 1, panels: ['timeline'] })).toEqual(DEFAULT_WORKSPACE);
  });
  it('keeps experimental platform panels out of the GA default workspace while surfacing Production', () => {
    expect(DEFAULT_WORKSPACE.panels).toEqual(GA_PANEL_IDS);
    expect(PANEL_IDS).toEqual(
      expect.arrayContaining(['jobs', 'workflows', 'production', 'plugins', 'templates']),
    );
    expect(DEFAULT_WORKSPACE.panels).toEqual(expect.arrayContaining(['production']));
    expect(DEFAULT_WORKSPACE.panels).not.toEqual(
      expect.arrayContaining(['jobs', 'workflows', 'plugins', 'templates']),
    );
  });
  it('uses one manifest for GA and persisted production panels', () => {
    expect(GA_PANEL_IDS).toEqual(PERSISTED_LAYOUT_PANEL_IDS);
    expect(PANEL_MANIFEST.filter((entry) => entry.gaVisible).map((entry) => entry.id)).toEqual(
      DEFAULT_WORKSPACE.panels,
    );
    expect(PANEL_MANIFEST).toHaveLength(PANEL_IDS.length);
    expect(WINDOW_MENU_PANEL_IDS).toEqual(
      PANEL_MANIFEST.filter((entry) => entry.windowMenu).map((entry) => entry.id),
    );
  });
  it('rejects full source-registry layouts unless development is explicit', () => {
    const full = { version: 1, panels: [...PANEL_IDS] };
    expect(recoverWorkspaceLayout(full)).toEqual(DEFAULT_WORKSPACE);
    expect(recoverWorkspaceLayout(full, { development: true })).toEqual(full);
  });
  it('exposes command-palette actions through one shortcut registry', () => {
    expect(searchActions('undo')).toMatchObject([{ id: 'history.undo', shortcut: 'Mod+Z' }]);
  });
});
