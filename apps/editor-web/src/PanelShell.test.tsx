import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PanelShell } from './PanelShell.js';

describe('PanelShell header actions', () => {
  it('removes the duplicate visual title row when no header controls are present', () => {
    const markup = renderToStaticMarkup(
      <PanelShell title="Effects">
        <p>Body</p>
      </PanelShell>,
    );

    expect(markup).not.toContain('joy-panel-header');
    expect(markup).toContain('aria-label="Effects"');
  });

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
    const trailing = markup.indexOf('joy-panel-actions');

    expect(leading).toBeGreaterThanOrEqual(0);
    expect(markup).not.toContain('joy-panel-title');
    expect(trailing).toBeGreaterThan(leading);
    expect(markup).toContain('aria-label="Import media"');
    expect(markup).toContain('aria-label="Cloud backup"');
    expect(markup).toContain('aria-label="Search Assets"');
  });

  it('renders English guidance without a language override', () => {
    const markup = renderToStaticMarkup(
      <PanelShell title="History" note="No edits have been made yet.">
        <p>Body</p>
      </PanelShell>,
    );

    expect(markup).toContain('class="joy-panel-note"');
    expect(markup).not.toContain('lang=');
  });

  it('does not add a language override to technical-only notes', () => {
    const markup = renderToStaticMarkup(
      <PanelShell title="Transitions" note="V1: clip-a → clip-b">
        <p>Body</p>
      </PanelShell>,
    );

    expect(markup).toContain('class="joy-panel-note"');
    expect(markup).not.toContain('lang=');
  });

  it('renders passive hints without the live status contract', () => {
    const markup = renderToStaticMarkup(
      <PanelShell title="Inspector" note="Select a clip to edit its properties." noteMode="hint">
        <p>Body</p>
      </PanelShell>,
    );

    expect(markup).toContain('class="joy-panel-hint"');
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain('aria-live=');
  });
});

describe('PanelShell tab API extension', () => {
  it('keeps the original label markup when a tab has no count or tooltip', () => {
    const markup = renderToStaticMarkup(
      <PanelShell
        title="Audio"
        tabs={[
          { id: 'enhance', label: 'Enhance' },
          { id: 'mix', label: 'Mix' },
        ]}
        activeTab="enhance"
      >
        <p>Body</p>
      </PanelShell>,
    );

    expect(markup).toContain('>Enhance</button>');
    expect(markup).toContain('>Mix</button>');
    expect(markup).not.toContain('joy-panel-tab-label');
  });

  it('renders a selected tab with id, label, count, iconUrl, ariaLabel, and tooltip', () => {
    const markup = renderToStaticMarkup(
      <PanelShell
        title="Effects"
        tabs={[
          {
            id: 'fx',
            label: 'Effects',
            count: 12,
            iconUrl: '/icons/fx.svg',
            ariaLabel: 'Effects tab',
            tooltip: 'Effects panel',
          },
        ]}
        activeTab="fx"
      >
        <p>Body</p>
      </PanelShell>,
    );

    expect(markup).toContain('role="tab"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('aria-label="Effects tab"');
    expect(markup).toContain('title="Effects panel"');
    expect(markup).toContain('data-panel-tab-id="fx"');
    expect(markup).toContain('joy-panel-tab-icon');
    expect(markup).toContain('joy-panel-tab-label');
    expect(markup).toContain('joy-panel-tab-count');
    expect(markup).toContain('>12<');
  });
});
