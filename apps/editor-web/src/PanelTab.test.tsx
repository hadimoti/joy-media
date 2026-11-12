import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { IDockviewPanelHeaderProps } from 'dockview';
import { PanelTab } from './PanelTab.js';
import { panelLabel, panelTabIconUrl } from './panel-tab-icons.js';
import { PANEL_IDS } from './workspace.js';

describe('PanelTab', () => {
  it('keeps the panel name available for the overflow menu and accessibility', () => {
    const props = { api: { id: 'media' } } as unknown as IDockviewPanelHeaderProps;
    const markup = renderToStaticMarkup(<PanelTab {...props} />);

    expect(markup).toContain('title="Create"');
    expect(markup).toContain('aria-label="Create"');
    expect(markup).toContain('class="panel-tab-label">Create</span>');
  });

  it('gives every icon-only tab a tooltip and an accessible name (OB-01b, OB-16c)', () => {
    for (const panelId of PANEL_IDS) {
      const props = { api: { id: panelId } } as unknown as IDockviewPanelHeaderProps;
      const markup = renderToStaticMarkup(<PanelTab {...props} />);
      const label = panelLabel(panelId);

      expect(markup, `${panelId} tooltip`).toContain(`title="${label}"`);
      expect(markup, `${panelId} accessible name`).toContain(`aria-label="${label}"`);
    }
  });

  it('draws the 3D tab with its own icon in the dock (OB-01a)', () => {
    const props = { api: { id: 'scene3d' } } as unknown as IDockviewPanelHeaderProps;
    const markup = renderToStaticMarkup(<PanelTab {...props} />);

    const cubeUrl = panelTabIconUrl('scene3d');
    expect(cubeUrl).toBeTruthy();
    expect(markup).toContain(cubeUrl as string);
    expect(cubeUrl).not.toBe(panelTabIconUrl('motion'));
  });
});
