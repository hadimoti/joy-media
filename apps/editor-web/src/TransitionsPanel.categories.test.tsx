import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TRANSITION_CATEGORIES, listTransitionShaders } from '@joy-media/transition-shaders';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { TransitionsPanel } from './TransitionsPanel.js';

function renderPanel(): string {
  return renderToStaticMarkup(
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
}

describe('TransitionsPanel category rail (T-V08)', () => {
  it('shows a labelled rail with All and the eight categories', () => {
    const markup = renderPanel();
    expect(markup).toContain('aria-label="Transition categories"');
    expect(markup).toContain('data-library-category="all"');
    for (const category of TRANSITION_CATEGORIES) {
      expect(markup).toContain(`data-library-category="${category.id}"`);
      expect(markup).toContain(`data-transition-category="${category.id}"`);
      expect(markup).toContain(`<h5 class="transition-category-heading">${category.label}</h5>`);
    }
  });

  it('lists every catalogue entry once, under its category heading', () => {
    const markup = renderPanel();
    for (const entry of listTransitionShaders()) {
      expect(markup.split(`data-library-id="${entry.id}"`).length - 1, entry.id).toBe(1);
      const section = markup.indexOf(
        `<section class="transition-category-section" data-transition-category="${entry.category}"`,
      );
      const card = markup.indexOf(`data-library-id="${entry.id}"`);
      expect(section, entry.id).toBeGreaterThanOrEqual(0);
      expect(card, entry.id).toBeGreaterThan(section);
    }
  });

  it('keeps the transition cards inside the shared category grid', () => {
    const markup = renderPanel();
    const group = markup.indexOf('class="library-browser-main transition-category-groups"');
    expect(group).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf('data-library-id="gl:fade"')).toBeGreaterThan(group);
  });
});
