import { describe, expect, it } from 'vitest';
import { evaluateCameraExpressionTransform } from '@joy-media/evaluator';
import { INITIAL_EDITOR_PROJECT, DEFAULT_COMPOSITION_SIZE } from './editor-project.js';

describe('initial editor reference project', () => {
  it('has a visible keyframed transform for live scrub verification', () => {
    const objects = INITIAL_EDITOR_PROJECT.visualObjects;
    const start = evaluateCameraExpressionTransform('intro-title', undefined, objects, 0, 1080);
    const end = evaluateCameraExpressionTransform(
      'intro-title',
      undefined,
      objects,
      30_000_000,
      1080,
    );
    expect(start.transform.x).toBe(0);
    expect(end.transform.x).toBe(300);
  });

  it('defaults to portrait 1080×1920', () => {
    const root = INITIAL_EDITOR_PROJECT.compositions.root;
    expect(root?.width).toBe(DEFAULT_COMPOSITION_SIZE.width);
    expect(root?.height).toBe(DEFAULT_COMPOSITION_SIZE.height);
  });
});
