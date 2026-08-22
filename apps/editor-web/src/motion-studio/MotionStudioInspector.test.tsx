import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createBlankScene, type MotionLayer } from '@joy-media/motion-core';
import {
  buildAutokeyAnimations,
  buildToggleKeyframeAnimations,
  layerHasKeyframeAt,
  MotionStudioInspector,
} from './MotionStudioInspector.js';
import { createRectangleLayer } from './state/layerFactory.js';

describe('MotionStudioInspector keyframe controls', () => {
  it('toggles transform keyframes at the live playhead through animations', () => {
    const layer = createRectangleLayer(10, 20, 100, 80);
    const keyed = buildToggleKeyframeAnimations(layer, 'transform.x', 500, layer.transform.x);
    const next = { ...layer, animations: keyed } satisfies MotionLayer;

    expect(layerHasKeyframeAt(next, 'transform.x', 500)).toBe(true);
    expect(buildToggleKeyframeAnimations(next, 'transform.x', 500, 99)).toEqual([]);
  });

  it('autokeys a numeric transform edit when a key already exists at the playhead', () => {
    const layer = {
      ...createRectangleLayer(10, 20, 100, 80),
      animations: buildToggleKeyframeAnimations(
        createRectangleLayer(10, 20, 100, 80),
        'transform.x',
        750,
        10,
      ),
    };

    const animations = buildAutokeyAnimations(layer, 'transform.x', 750, 42);
    expect(animations?.[0]?.curve.keyframes[0]).toMatchObject({ timeMs: 750, value: 42 });
    expect(buildAutokeyAnimations(layer, 'transform.y', 750, 24)).toBeUndefined();
  });

  it('renders active keyframe diamonds for selected single-layer properties', () => {
    const layer = createRectangleLayer(10, 20, 100, 80);
    const keyedLayer = {
      ...layer,
      animations: buildToggleKeyframeAnimations(layer, 'transform.x', 1000, layer.transform.x),
    };
    const document = { ...createBlankScene('Inspector'), layers: [keyedLayer] };
    const markup = renderToStaticMarkup(
      <MotionStudioInspector
        document={document}
        selectedLayerIds={[keyedLayer.id]}
        playheadMs={1000}
        dispatch={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Toggle X keyframe"');
    expect(markup).toContain('aria-pressed="true"');
  });
});
