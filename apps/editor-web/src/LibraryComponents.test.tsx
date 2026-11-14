/**
 * Markup-level checks of the shared library components. Behaviour (hover, focus,
 * reduced motion, strips, fallback, slider, rail keys) is in LibraryCardPreview.test.tsx.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { effectRegistry, registerBuiltins } from '@joy-media/visual-effects';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { EffectsPanel } from './EffectsPanel.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { FiltersPanel } from './FiltersPanel.js';
import { LibraryCard } from './LibraryCard.js';
import { TemplatesPanel } from './TemplatesPanel.js';
import { TransitionsPanel } from './TransitionsPanel.js';

beforeAll(() => {
  if (!effectRegistry.hasEffect('gaussian-blur')) registerBuiltins();
});

describe('shared visual library components', () => {
  it('uses the shared card and category rail in Filters', () => {
    const markup = renderToStaticMarkup(
      <FiltersPanel canCreate={true} targetLabel="Product" onAddFilter={() => undefined} />,
    );

    expect(markup).toContain('class="library-rail"');
    expect(markup).toContain('class="library-card filter-library-card"');
    expect(markup).toContain('class="library-rail-label">Favorites</span>');
    expect(markup).toContain('aria-selected="true"');
  });

  it('uses the shared labeled rail and cards in Transitions and Templates', () => {
    const transitions = renderToStaticMarkup(
      <TransitionsPanel
        project={INITIAL_EDITOR_PROJECT}
        timelineProject={buildReferenceSpikeProject()}
        selectedClipIds={[]}
        onAddTransition={() => undefined}
        onRemoveTransition={() => undefined}
        onUpdateTransition={() => undefined}
        showToast={() => undefined}
      />,
    );
    const storage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const templates = renderToStaticMarkup(
      <TemplatesPanel
        onApplyTemplate={() => undefined}
        showToast={() => undefined}
        storage={storage}
      />,
    );

    expect(transitions).toContain('class="library-card transition-card"');
    expect(transitions).toContain('class="library-rail-label">Basic and fades</span>');
    expect(transitions).toContain('aria-label="Search Transitions"');
    expect(templates).toContain('class="library-card template-card"');
    expect(templates).toContain('class="library-rail-label">Favorites</span>');
    expect(templates).toContain('aria-label="Search Templates"');
  });

  it('shows an Effect rail with text labels', () => {
    const markup = renderToStaticMarkup(
      <EffectsPanel
        project={INITIAL_EDITOR_PROJECT}
        objectId={undefined}
        canApplyEffects={false}
        onDispatch={() => undefined}
        showToast={() => undefined}
      />,
    );

    expect(markup).toContain('class="library-rail"');
    expect(markup).toContain('class="library-rail-label">Colour &amp; Light</span>');
  });

  // This only checks that the long name is in the markup, that the narrow-panel CSS rules
  // exist as text, and that the filter hint renders. jsdom does no layout, so whether the
  // text really fits at 280 px is NOT measured here; that needs the attended driver run.
  it('ships the narrow-panel CSS rules and the filter hint (layout is not measured)', () => {
    const longName = 'AQuiteLongLibraryCardNameThatMustWrapWithoutBeingCutOff';
    const card = renderToStaticMarkup(
      <div className="library-panel" style={{ width: 280 }}>
        <LibraryCard
          id="long"
          name={longName}
          description="A description that stays readable in a narrow panel."
          preview={<div>Preview</div>}
          isFavorite={false}
          onToggleFavorite={() => undefined}
          onAdd={() => undefined}
        />
      </div>,
    );
    const styles = readFileSync(new URL('./library-panels.css', import.meta.url), 'utf8');
    const narrowRules = styles.slice(styles.lastIndexOf('@container (max-width: 18rem)'));
    const filterMarkup = renderToStaticMarkup(
      <FiltersPanel canCreate={false} onAddFilter={() => undefined} />,
    );

    expect(card).toContain(longName);
    expect(narrowRules).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(narrowRules).toContain('overflow-wrap: anywhere');
    expect(narrowRules).toContain('overflow: visible');
    expect(filterMarkup).toContain('Select a clip, then add a filter');
    expect(filterMarkup).not.toContain('No media selected');
  });
});
