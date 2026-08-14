import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { IDockviewPanelHeaderProps } from 'dockview';
import { PanelTab } from './PanelTab.js';

describe('PanelTab', () => {
  it('keeps the panel name available for the overflow menu and accessibility', () => {
    const props = { api: { id: 'media' } } as unknown as IDockviewPanelHeaderProps;
    const markup = renderToStaticMarkup(<PanelTab {...props} />);

    expect(markup).toContain('title="Create"');
    expect(markup).toContain('aria-label="Create"');
    expect(markup).toContain('class="panel-tab-label">Create</span>');
  });
});
