import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { VisualObjectV1 } from '@joy-media/project-schema';
import { EffectsSection } from './InspectorPanel.js';

const OBJECT: VisualObjectV1 = {
  id: 'title-1',
  kind: 'text',
  text: 'Title',
  transform: {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  },
  effects: [
    { id: 'effect-1', effectId: 'unknown-one', enabled: true, params: {} },
    { id: 'effect-2', effectId: 'unknown-two', enabled: true, params: {} },
  ],
};

describe('Inspector effects ordering controls', () => {
  it('renders drag hooks and keyboard-accessible move actions', () => {
    const markup = renderToStaticMarkup(
      <EffectsSection
        object={OBJECT}
        open={true}
        onToggle={() => undefined}
        onDispatch={() => undefined}
      />,
    );

    expect(markup).toContain('data-effect-instance-id="effect-1"');
    expect(markup).toContain('data-drag-handle="true"');
    expect(markup).toContain('aria-label="Move unknown-one up"');
    expect(markup).toContain('aria-label="Move unknown-one down"');
    expect(markup).toContain('aria-label="Move unknown-two up"');
    expect(markup).toContain('aria-label="Move unknown-two down"');
  });
});
