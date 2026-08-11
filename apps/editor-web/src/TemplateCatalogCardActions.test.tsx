import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TemplateCatalogCardActions } from './TemplateCatalogCardActions.js';

describe('TemplateCatalogCardActions', () => {
  it('offers apply and author actions for library templates', () => {
    const markup = renderToStaticMarkup(
      <TemplateCatalogCardActions
        label="Title"
        isMine={false}
        onApply={() => undefined}
        onSave={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(markup).toContain('aria-label="Apply Title"');
    expect(markup).toContain('aria-label="Save Title to My Templates"');
    expect(markup).not.toContain('aria-label="Delete Title"');
  });

  it('offers apply and delete actions for authored templates', () => {
    const markup = renderToStaticMarkup(
      <TemplateCatalogCardActions
        label="My Title"
        isMine={true}
        onApply={() => undefined}
        onSave={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(markup).toContain('aria-label="Apply My Title"');
    expect(markup).toContain('aria-label="Delete My Title"');
    expect(markup).not.toContain('Save My Title to My Templates');
  });
});
