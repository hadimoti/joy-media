import { describe, expect, it } from 'vitest';
import { evaluateCameraExpressionTransform } from '@joy-media/evaluator';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';

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
});
