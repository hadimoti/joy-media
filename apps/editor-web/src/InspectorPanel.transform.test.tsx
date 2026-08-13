import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { VisualObjectV1 } from '@joy-media/project-schema';
import { InspectorPanel } from './InspectorPanel.js';

const OBJECT: VisualObjectV1 = {
  id: 'title-1',
  kind: 'text',
  text: 'Title',
  transform: {
    x: 120,
    y: 80,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  },
  animations: {
    x: {
      keyframes: [
        { timeUs: 0, value: 0, interpolation: 'linear' },
        { timeUs: 1_000_000, value: 120, interpolation: 'linear' },
      ],
    },
  },
};

describe('Inspector transform property rows', () => {
  it('uses the universal property shell while keeping existing transform and expression controls', () => {
    const markup = renderToStaticMarkup(
      <InspectorPanel
        object={OBJECT}
        allObjects={{ [OBJECT.id]: OBJECT }}
        playheadUs={1_000_000}
        onSetStatic={() => undefined}
        onDispatch={() => undefined}
      />,
    );

    expect(markup).toContain('data-property-row="Position X"');
    expect(markup).toContain('data-property-row="Opacity"');
    expect(markup).toContain('Reset Position X');
    expect(markup).toContain('Remove Position X keyframe at playhead');
    expect(markup).toContain('Add Opacity keyframe at playhead');
    expect(markup).toContain('aria-label="Add Position X expression"');
  });
});
