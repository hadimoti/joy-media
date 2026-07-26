import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PanelShell } from './PanelShell.js';

describe('PanelShell header actions', () => {
  it('places leading actions before the centered title and trailing actions after it', () => {
    const markup = renderToStaticMarkup(
      <PanelShell
        title="Assets"
        leadingActions={<button aria-label="Import media" />}
        actions={<button aria-label="Cloud backup" />}
        search={{ value: '', onChange: () => undefined }}
      >
        <p>Body</p>
      </PanelShell>,
    );

    const leading = markup.indexOf('joy-panel-leading-actions');
    const title = markup.indexOf('joy-panel-title');
    const trailing = markup.indexOf('joy-panel-actions');

    expect(leading).toBeGreaterThanOrEqual(0);
    expect(title).toBeGreaterThan(leading);
    expect(trailing).toBeGreaterThan(title);
    expect(markup).toContain('aria-label="Import media"');
    expect(markup).toContain('aria-label="Cloud backup"');
    expect(markup).toContain('aria-label="Search Assets"');
  });
});
