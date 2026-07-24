import { describe, expect, it } from 'vitest';
import { evaluateCameraExpressionTransform } from '@joy-media/evaluator';
import {
  INITIAL_EDITOR_PROJECT,
  withDefaultPortraitComposition,
  LEGACY_COMPOSITION_SIZE,
  DEFAULT_COMPOSITION_SIZE,
} from './editor-project.js';

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

  it('migrates legacy landscape composition to portrait', () => {
    const legacy = {
      ...INITIAL_EDITOR_PROJECT,
      compositions: {
        ...INITIAL_EDITOR_PROJECT.compositions,
        root: {
          ...INITIAL_EDITOR_PROJECT.compositions.root!,
          width: LEGACY_COMPOSITION_SIZE.width,
          height: LEGACY_COMPOSITION_SIZE.height,
        },
      },
    };
    const migrated = withDefaultPortraitComposition(legacy);
    expect(migrated.compositions.root?.width).toBe(1080);
    expect(migrated.compositions.root?.height).toBe(1920);
  });
});
