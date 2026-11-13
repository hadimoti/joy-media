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

  it('keeps the sample project at its own 1080×1920 size', () => {
    const root = INITIAL_EDITOR_PROJECT.compositions.root;
    expect(root?.width).toBe(1080);
    expect(root?.height).toBe(1920);
  });

  it('gives a new project the YouTube 16:9 default, 1920×1080', () => {
    expect(DEFAULT_COMPOSITION_SIZE).toEqual({ width: 1920, height: 1080 });
  });
});
