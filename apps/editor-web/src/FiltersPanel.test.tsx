import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { effectRegistry, registerBuiltins } from '@joy-media/visual-effects';
import { FILTER_LIBRARY, FiltersPanel } from './FiltersPanel.js';

beforeAll(() => {
  if (!effectRegistry.hasEffect('gaussian-blur')) registerBuiltins();
});

describe('FiltersPanel', () => {
  it('keeps every curated filter backed by a live Pixi descriptor', () => {
    const ids = [...new Set(Object.values(FILTER_LIBRARY).flat())];
    expect(ids).toEqual(
      expect.arrayContaining(['gaussian-blur', 'zoom-blur', 'radial-blur', 'tilt-shift', 'noise']),
    );
    for (const id of ids) {
      expect(effectRegistry.getEffect(id)?.backend.pixiPreview, id).toBe(true);
    }
  });

  it('renders the blur library as parented timeline-layer actions', () => {
    const markup = renderToStaticMarkup(
      <FiltersPanel
        canCreate={true}
        targetLabel="Product"
        onCreateFilterLayer={() => undefined}
        onAddFilter={() => undefined}
      />,
    );

    expect(markup).toContain('Add Gaussian Blur Filters layer');
    expect(markup).toContain('Add Zoom Blur Filters layer');
    expect(markup).toContain('Add Radial Blur Filters layer');
    expect(markup).toContain('Add Tilt Shift Filters layer');
    expect(markup).toContain('<strong>Product</strong>');
  });
});
