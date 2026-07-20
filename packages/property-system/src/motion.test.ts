import { describe, expect, it } from 'vitest';
import type { AnimationCurveV1, JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
import { resolveObjectTransform } from '@joy-media/motion-core';
import { VisualObjectProjectHistory } from './index.js';
import type { VisualObjectTransaction } from './index.js';

const object: VisualObjectV1 = {
  id: 'title',
  kind: 'text',
  transform: {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  },
};

const project: JoyProjectV1 = {
  schemaVersion: 1,
  id: 'p',
  title: 'P',
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
  rootCompositionId: 'root',
  settings: { defaultLocale: 'en' },
  compositions: {},
  assets: {},
  variables: {},
  markers: [],
  visualObjects: { title: object },
  captionDocuments: {},
  pluginData: {},
};

const curve: AnimationCurveV1 = {
  keyframes: [
    { timeUs: 0, value: 0, interpolation: 'linear' },
    { timeUs: 1_000_000, value: 100, interpolation: 'linear' },
  ],
};

const animateX: VisualObjectTransaction = {
  label: 'Animate Position X',
  commands: [
    { type: 'object.replaceAnimation', payload: { objectId: 'title', property: 'x', curve } },
  ],
};

describe('motion commands on the shared v1 history', () => {
  it('applies, undoes, and redoes a keyframe channel', () => {
    const history = new VisualObjectProjectHistory(project);

    const animated = history.apply(animateX);
    expect(animated.visualObjects['title']!.animations?.x).toEqual(curve);
    expect(resolveObjectTransform(animated.visualObjects['title']!, 500_000).x).toBeCloseTo(50, 6);

    const undone = history.undo().project;
    expect(undone.visualObjects['title']!.animations).toBeUndefined();

    const redone = history.redo().project;
    expect(redone.visualObjects['title']!.animations?.x).toEqual(curve);
  });

  it('interleaves motion and transform edits on one command log', () => {
    const history = new VisualObjectProjectHistory(project);
    history.apply(animateX);
    history.apply({
      label: 'Nudge Y',
      commands: [
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'title', key: 'y', value: 12 },
        },
      ],
    });

    // Undo the transform edit, keeping the animation channel intact.
    const afterUndo = history.undo().project;
    expect(afterUndo.visualObjects['title']!.transform.y).toBe(0);
    expect(afterUndo.visualObjects['title']!.animations?.x).toEqual(curve);
  });

  it('applies, undoes, and redoes an expression through the shared v1 history', () => {
    const history = new VisualObjectProjectHistory(project);
    const applied = history.apply({
      label: 'Set expression',
      commands: [
        {
          type: 'object.setExpression',
          payload: { objectId: 'title', property: 'opacity', source: 'clamp(time, 0, 1)' },
        },
      ],
    });
    expect(applied.visualObjects['title']!.expressions?.opacity).toBe('clamp(time, 0, 1)');

    const undone = history.undo().project;
    expect(undone.visualObjects['title']!.expressions).toBeUndefined();

    const redone = history.redo().project;
    expect(redone.visualObjects['title']!.expressions?.opacity).toBe('clamp(time, 0, 1)');
  });
});
