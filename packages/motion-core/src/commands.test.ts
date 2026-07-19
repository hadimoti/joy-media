import { describe, expect, it } from 'vitest';
import type { AnimationCurveV1, JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
import { applyMotionProjectCommand, MotionCommandError } from './commands.js';
import type { MotionCommand } from './commands.js';

const object: VisualObjectV1 = {
  id: 'obj-1',
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
  title: 'motion test',
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
  rootCompositionId: 'root',
  settings: { defaultLocale: 'en' },
  compositions: {},
  assets: {},
  variables: {},
  markers: [],
  visualObjects: { 'obj-1': object },
  captionDocuments: {},
  pluginData: {},
};

const curve: AnimationCurveV1 = {
  keyframes: [
    { timeUs: 0, value: 0, interpolation: 'linear' },
    { timeUs: 1_000_000, value: 100, interpolation: 'linear' },
  ],
};

const setX: MotionCommand = {
  type: 'object.replaceAnimation',
  payload: { objectId: 'obj-1', property: 'x', curve },
};

describe('applyMotionProjectCommand', () => {
  it('adds a channel and inverts by removing it', () => {
    const result = applyMotionProjectCommand(project, setX);
    expect(result.project.visualObjects['obj-1']!.animations?.x).toEqual(curve);
    expect(result.inverse).toEqual({
      type: 'object.replaceAnimation',
      payload: { objectId: 'obj-1', property: 'x' },
    });
    // Applying the inverse restores the original (no animations key).
    const undone = applyMotionProjectCommand(result.project, result.inverse);
    expect(undone.project.visualObjects['obj-1']!.animations).toBeUndefined();
  });

  it('captures the prior curve as the inverse when replacing a channel', () => {
    const withX = applyMotionProjectCommand(project, setX).project;
    const replacement: AnimationCurveV1 = {
      keyframes: [{ timeUs: 0, value: 7, interpolation: 'hold' }],
    };
    const result = applyMotionProjectCommand(withX, {
      type: 'object.replaceAnimation',
      payload: { objectId: 'obj-1', property: 'x', curve: replacement },
    });
    expect(result.inverse.type).toBe('object.replaceAnimation');
    if (result.inverse.type !== 'object.replaceAnimation') throw new Error('unexpected inverse');
    expect(result.inverse.payload.curve).toEqual(curve);
  });

  it('removes only the targeted channel, keeping the object otherwise intact', () => {
    const withTwo = applyMotionProjectCommand(applyMotionProjectCommand(project, setX).project, {
      type: 'object.replaceAnimation',
      payload: { objectId: 'obj-1', property: 'opacity', curve },
    }).project;
    const removed = applyMotionProjectCommand(withTwo, {
      type: 'object.replaceAnimation',
      payload: { objectId: 'obj-1', property: 'x' },
    }).project;
    expect(removed.visualObjects['obj-1']!.animations?.x).toBeUndefined();
    expect(removed.visualObjects['obj-1']!.animations?.opacity).toEqual(curve);
  });

  it('rejects an unknown object', () => {
    expect(() =>
      applyMotionProjectCommand(project, {
        type: 'object.replaceAnimation',
        payload: { objectId: 'ghost', property: 'x', curve },
      }),
    ).toThrow(MotionCommandError);
  });

  it('rejects an invalid curve before it can enter the document', () => {
    const bad: AnimationCurveV1 = {
      keyframes: [
        { timeUs: 1_000_000, value: 0, interpolation: 'linear' },
        { timeUs: 0, value: 1, interpolation: 'linear' },
      ],
    };
    expect(() =>
      applyMotionProjectCommand(project, {
        type: 'object.replaceAnimation',
        payload: { objectId: 'obj-1', property: 'x', curve: bad },
      }),
    ).toThrow(MotionCommandError);
  });
});

describe('applyMotionProjectCommand — object.setParent', () => {
  const twoObjects: JoyProjectV1 = {
    ...project,
    visualObjects: {
      'obj-1': object,
      controller: { ...object, id: 'controller', kind: 'null' },
    },
  };

  it('sets a parent and inverts by clearing it', () => {
    const result = applyMotionProjectCommand(twoObjects, {
      type: 'object.setParent',
      payload: { objectId: 'obj-1', parentId: 'controller' },
    });
    expect(result.project.visualObjects['obj-1']!.parentId).toBe('controller');
    expect(result.inverse).toEqual({
      type: 'object.setParent',
      payload: { objectId: 'obj-1' },
    });
    const undone = applyMotionProjectCommand(result.project, result.inverse);
    expect(undone.project.visualObjects['obj-1']!.parentId).toBeUndefined();
  });

  it('rejects self-parenting, unknown parents, and cycles', () => {
    expect(() =>
      applyMotionProjectCommand(twoObjects, {
        type: 'object.setParent',
        payload: { objectId: 'obj-1', parentId: 'obj-1' },
      }),
    ).toThrow(/own parent/);
    expect(() =>
      applyMotionProjectCommand(twoObjects, {
        type: 'object.setParent',
        payload: { objectId: 'obj-1', parentId: 'ghost' },
      }),
    ).toThrow(/unknown parent/);
    // controller -> obj-1, then obj-1 -> controller would cycle.
    const parented = applyMotionProjectCommand(twoObjects, {
      type: 'object.setParent',
      payload: { objectId: 'controller', parentId: 'obj-1' },
    }).project;
    expect(() =>
      applyMotionProjectCommand(parented, {
        type: 'object.setParent',
        payload: { objectId: 'obj-1', parentId: 'controller' },
      }),
    ).toThrow(/cycle/);
  });
});
