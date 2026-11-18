import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import type { JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { EditorSession } from '../editor-session.js';
import { monitorContextTransformState } from './monitor-context-transform.js';
import { turn, type LocalTransform, type ParentTransform } from './monitor-transform-maths.js';
import type { MonitorTransformTarget } from './monitor-transform-targets.js';

const textObject: VisualObjectV1 = {
  id: 'title',
  kind: 'text',
  text: 'Hello',
  transform: {
    x: 100,
    y: 200,
    scaleX: 2,
    scaleY: 2,
    rotationDeg: 30,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  },
};

function project(
  objects: Readonly<Record<string, VisualObjectV1>> = { title: textObject },
  options: { readonly activeCameraId?: string; readonly parentTrackLocked?: boolean } = {},
): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id: 'project',
    title: 'Project',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 1080,
        height: 1920,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 1_000_000,
        background: '#000',
        ...(options.activeCameraId === undefined ? {} : { activeCameraId: options.activeCameraId }),
        tracks: [
          {
            id: 'parent-track',
            kind: 'video',
            name: 'Parent',
            order: 0,
            enabled: true,
            locked: options.parentTrackLocked === true,
            clips: [
              {
                id: 'parent-clip',
                kind: 'video',
                assetId: 'video',
                startUs: 0,
                durationUs: 1_000_000,
              },
            ],
          },
        ],
      },
    },
    assets: {
      video: {
        id: 'video',
        kind: 'video',
        displayName: 'Video',
        descriptor: { mimeType: 'video/mp4', width: 1920, height: 1080 },
      },
    },
    variables: {},
    markers: [],
    visualObjects: objects,
    captionDocuments: {},
    pluginData: { 'joy.clipObjects': { 'parent-clip': 'parent' } },
  } as unknown as JoyProjectV1;
}

/** The same project with one more picture asset, 1920 by 1080. */
function withPhoto(base: JoyProjectV1): JoyProjectV1 {
  return {
    ...base,
    assets: {
      ...base.assets,
      photo: {
        id: 'photo',
        kind: 'image',
        displayName: 'Photo',
        descriptor: { mimeType: 'image/png', width: 1920, height: 1080 },
      },
    },
  } as unknown as JoyProjectV1;
}

function target(overrides: Partial<MonitorTransformTarget> = {}): MonitorTransformTarget {
  return {
    nodeId: 'title',
    clipId: 'clip-title',
    objectId: 'title',
    geometry: {
      transform: { x: 100, y: 200, scaleX: 2, scaleY: 2, rotationDeg: 30 },
      corners: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 200 },
        { x: 0, y: 200 },
      ],
      origin: { x: 100, y: 200 },
      center: { x: 100, y: 200 },
    },
    local: { x: 100, y: 200, scaleX: 2, scaleY: 2, rotationDeg: 30 },
    blocked: {},
    ...overrides,
  };
}

/** The renderer's order: the parent scales a child's position, then turns it. */
function pivotInCanvas(parent: ParentTransform, local: LocalTransform): { x: number; y: number } {
  const moved = turn(
    { x: parent.scaleX * local.x, y: parent.scaleY * local.y },
    parent.rotationDeg,
  );
  return { x: parent.x + moved.x, y: parent.y + moved.y };
}

/** Where a child's drawn box centre lands, given its offset from its pivot in its own units. */
function centreInCanvas(
  parent: ParentTransform,
  local: LocalTransform,
  offset: { readonly x: number; readonly y: number },
): { x: number; y: number } {
  const pivot = pivotInCanvas(parent, local);
  const drawn = turn(
    { x: parent.scaleX * local.scaleX * offset.x, y: parent.scaleY * local.scaleY * offset.y },
    parent.rotationDeg + local.rotationDeg,
  );
  return { x: pivot.x + drawn.x, y: pivot.y + drawn.y };
}

/** A child target built from the same model, so the test checks the maths and not hand-typed geometry. */
function parentedTarget(
  parent: ParentTransform,
  local: LocalTransform,
  offset: { readonly x: number; readonly y: number },
): MonitorTransformTarget {
  const pivot = pivotInCanvas(parent, local);
  return target({
    parent,
    ancestorObjectIds: ['parent'],
    local,
    geometry: {
      ...target().geometry,
      transform: {
        x: pivot.x,
        y: pivot.y,
        scaleX: parent.scaleX * local.scaleX,
        scaleY: parent.scaleY * local.scaleY,
        rotationDeg: parent.rotationDeg + local.rotationDeg,
      },
      origin: pivot,
      center: centreInCanvas(parent, local, offset),
    },
  });
}

function transformCommands(edit: VisualObjectTransaction | undefined) {
  return edit?.commands.filter((command) => command.type === 'object.setTransformProperty') ?? [];
}

function transformValues(edit: VisualObjectTransaction | undefined) {
  return transformCommands(edit).map((command) => command.payload.value);
}

function transformKeys(edit: VisualObjectTransaction | undefined) {
  return transformCommands(edit).map((command) => command.payload.key);
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('Monitor context transform actions', () => {
  it('builds Centre as one transaction that moves the rendered box centre to the frame centre', () => {
    const state = monitorContextTransformState({
      objectId: 'title',
      object: textObject,
      project: project(),
      target: target({
        geometry: {
          ...target().geometry,
          center: { x: 130, y: 260 },
        },
      }),
      frameWidth: 1080,
      frameHeight: 1920,
    });

    expect(state.alreadyCentred).toBe(false);
    expect(state.centreTransaction).toMatchObject({
      label: 'Centre in frame',
      commands: [
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'title', key: 'x', value: 510 },
        },
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'title', key: 'y', value: 900 },
        },
      ],
    });
    expect(state.centreTransaction?.commands).toHaveLength(2);
  });

  it('resets new media to its default Fit size and centre in one transaction, leaving crop alone', () => {
    const media: VisualObjectV1 = {
      ...textObject,
      id: 'media',
      kind: 'null',
      assetId: 'video',
    };
    const mediaTarget = target({
      objectId: 'media',
      local: { x: 100, y: 200, scaleX: 2, scaleY: 2, rotationDeg: 30 },
    });
    const state = monitorContextTransformState({
      objectId: 'media',
      object: media,
      project: project({ media }),
      target: mediaTarget,
      frameWidth: 1080,
      frameHeight: 1920,
    });

    expect(state.alreadyReset).toBe(false);
    expect(state.resetTransaction).toMatchObject({
      label: 'Reset transform',
      commands: [
        { type: 'object.setTransformProperty', payload: { objectId: 'media', key: 'x' } },
        { type: 'object.setTransformProperty', payload: { objectId: 'media', key: 'y' } },
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'media', key: 'scaleX', value: 0.5625 },
        },
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'media', key: 'scaleY', value: 0.5625 },
        },
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'media', key: 'rotationDeg', value: 0 },
        },
      ],
    });
    expect(state.resetTransaction?.commands).toHaveLength(5);
    expect(transformKeys(state.resetTransaction)).not.toContain('crop');
  });

  it('re-centres an off-centre anchor after resetting rotation and scale', () => {
    const state = monitorContextTransformState({
      objectId: 'title',
      object: textObject,
      project: project(),
      target: target({
        geometry: {
          ...target().geometry,
          transform: { x: 100, y: 200, scaleX: 2, scaleY: 4, rotationDeg: 90 },
          center: { x: 120, y: 240 },
        },
        local: { x: 100, y: 200, scaleX: 2, scaleY: 4, rotationDeg: 90 },
      }),
      frameWidth: 1080,
      frameHeight: 1920,
    });

    expect(transformValues(state.resetTransaction)).toEqual([520, 965, 1, 1, 0]);
  });

  it('supports a static parent while moving the child in canvas space', () => {
    const parent: VisualObjectV1 = {
      ...textObject,
      id: 'parent',
      kind: 'null',
      transform: { ...textObject.transform, x: 50, y: 80, rotationDeg: 0 },
    };
    const child: VisualObjectV1 = { ...textObject, parentId: 'parent' };
    const state = monitorContextTransformState({
      objectId: 'title',
      object: child,
      project: project({ title: child, parent }),
      target: target({
        parent: { x: 50, y: 80, scaleX: 1, scaleY: 1, rotationDeg: 0 },
        ancestorObjectIds: ['parent'],
        local: { x: 10, y: 20, scaleX: 2, scaleY: 2, rotationDeg: 30 },
      }),
      frameWidth: 1080,
      frameHeight: 1920,
    });

    expect(state.disabledReason).toBeUndefined();
    expect(transformValues(state.centreTransaction)).toEqual([450, 780]);
  });

  describe('under a rotated and scaled parent', () => {
    const parent: ParentTransform = { x: 300, y: 400, scaleX: 2, scaleY: 2, rotationDeg: 90 };
    const offset = { x: 40, y: 0 };
    const child: VisualObjectV1 = { ...textObject, parentId: 'parent' };
    const nested = project({
      title: child,
      parent: { ...textObject, id: 'parent', kind: 'null' },
    });

    it('centres the child in canvas space through the parent', () => {
      const state = monitorContextTransformState({
        objectId: 'title',
        object: child,
        project: nested,
        target: parentedTarget(
          parent,
          { x: 10, y: 20, scaleX: 2, scaleY: 2, rotationDeg: 90 },
          offset,
        ),
        frameWidth: 1080,
        frameHeight: 1920,
      });

      expect(transformValues(state.centreTransaction)).toEqual([280, -200]);
    });

    it('returns a rotated and scaled child to its own defaults and centres its box in the frame', () => {
      const state = monitorContextTransformState({
        objectId: 'title',
        object: child,
        project: nested,
        target: parentedTarget(
          parent,
          { x: 10, y: 20, scaleX: 2, scaleY: 2, rotationDeg: 90 },
          offset,
        ),
        frameWidth: 1080,
        frameHeight: 1920,
      });

      // Rotation 0 and scale 1 are the child's own values, so the parent's 90 degrees stay in the parent.
      const reset = transformValues(state.resetTransaction);
      expect(reset).toEqual([240, -120, 1, 1, 0]);
      const centre = centreInCanvas(
        parent,
        { x: 240, y: -120, scaleX: 1, scaleY: 1, rotationDeg: 0 },
        offset,
      );
      expect(centre.x).toBeCloseTo(540, 6);
      expect(centre.y).toBeCloseTo(960, 6);
    });

    it('reports a rotated and scaled child that is already centred and reset', () => {
      const state = monitorContextTransformState({
        objectId: 'title',
        object: child,
        project: nested,
        target: parentedTarget(
          parent,
          { x: 240, y: -120, scaleX: 1, scaleY: 1, rotationDeg: 0 },
          offset,
        ),
        frameWidth: 1080,
        frameHeight: 1920,
      });

      expect(state.alreadyCentred).toBe(true);
      expect(state.alreadyReset).toBe(true);
      expect(state.centreTransaction).toBeUndefined();
      expect(state.resetTransaction).toBeUndefined();
    });
  });

  it('fits a cropped picture to the frame as Fit does, and leaves the crop alone', () => {
    const photo: VisualObjectV1 = {
      ...textObject,
      id: 'photo-object',
      kind: 'image',
      assetId: 'photo',
      transform: {
        ...textObject.transform,
        x: 540,
        y: 960,
        scaleX: 1,
        scaleY: 1,
        rotationDeg: 0,
        crop: { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 },
      },
    };
    const state = monitorContextTransformState({
      objectId: 'photo-object',
      object: photo,
      project: withPhoto(project({ 'photo-object': photo })),
      target: target({
        objectId: 'photo-object',
        local: { x: 540, y: 960, scaleX: 1, scaleY: 1, rotationDeg: 0 },
        geometry: {
          ...target().geometry,
          transform: { x: 540, y: 960, scaleX: 1, scaleY: 1, rotationDeg: 0 },
          origin: { x: 540, y: 960 },
          center: { x: 540, y: 960 },
        },
      }),
      frameWidth: 1080,
      frameHeight: 1920,
    });

    // The visible 80 per cent of the picture (1536 by 864) fits the 1080 by 1920 frame at 45/64.
    expect(transformValues(state.resetTransaction)).toEqual([540, 960, 0.703125, 0.703125, 0]);
    expect(transformKeys(state.resetTransaction)).not.toContain('crop');
  });

  it("uses the selected video clip's asset when the object has none", () => {
    const media: VisualObjectV1 = { ...textObject, id: 'media', kind: 'null' };
    const state = monitorContextTransformState({
      objectId: 'media',
      object: media,
      project: project({ media }),
      target: target({
        objectId: 'media',
        clipId: 'parent-clip',
        local: { x: 540, y: 960, scaleX: 2, scaleY: 2, rotationDeg: 30 },
        geometry: {
          ...target().geometry,
          transform: { x: 540, y: 960, scaleX: 2, scaleY: 2, rotationDeg: 30 },
          origin: { x: 540, y: 960 },
          center: { x: 540, y: 960 },
        },
      }),
      frameWidth: 1080,
      frameHeight: 1920,
    });

    expect(transformValues(state.resetTransaction)).toEqual([540, 960, 0.5625, 0.5625, 0]);
  });

  it('disables both actions while the composition has an active camera', () => {
    const state = monitorContextTransformState({
      objectId: 'title',
      object: textObject,
      project: project(),
      target: target(),
      frameWidth: 1080,
      frameHeight: 1920,
      activeCamera: true,
    });

    expect(state.disabledReason).toBe('The camera places this element. Change the camera instead.');
    expect(state.centreTransaction).toBeUndefined();
    expect(state.resetTransaction).toBeUndefined();
  });

  it('disables both actions when the parent is on a locked track', () => {
    const child: VisualObjectV1 = { ...textObject, parentId: 'parent' };
    const state = monitorContextTransformState({
      objectId: 'title',
      object: child,
      project: project(
        { title: child, parent: { ...textObject, id: 'parent', kind: 'null' } },
        { parentTrackLocked: true },
      ),
      target: target({ ancestorObjectIds: ['parent'] }),
      frameWidth: 1080,
      frameHeight: 1920,
    });

    expect(state.disabledReason).toBe('A parent of this element is on a locked track.');
    expect(state.centreTransaction).toBeUndefined();
    expect(state.resetTransaction).toBeUndefined();
  });

  it('reports an object that is already centred and reset', () => {
    const state = monitorContextTransformState({
      objectId: 'title',
      object: textObject,
      project: project(),
      target: target({
        geometry: {
          ...target().geometry,
          transform: { x: 540, y: 960, scaleX: 1, scaleY: 1, rotationDeg: 0 },
          origin: { x: 540, y: 960 },
          center: { x: 540, y: 960 },
        },
        local: { x: 540, y: 960, scaleX: 1, scaleY: 1, rotationDeg: 0 },
      }),
      frameWidth: 1080,
      frameHeight: 1920,
    });

    expect(state.alreadyCentred).toBe(true);
    expect(state.alreadyReset).toBe(true);
    expect(state.centreTransaction).toBeUndefined();
    expect(state.resetTransaction).toBeUndefined();
  });

  it('blocks both actions while the position is animated', () => {
    const moving: VisualObjectV1 = {
      ...textObject,
      animations: { x: { keyframes: [{ timeUs: 0, value: 100, interpolation: 'linear' }] } },
    };
    const state = monitorContextTransformState({
      objectId: 'title',
      object: moving,
      project: project({ title: moving }),
      target: target(),
      frameWidth: 1080,
      frameHeight: 1920,
    });

    expect(state.disabledReason).toBeUndefined();
    expect(state.centreDisabledReason).toBeDefined();
    expect(state.resetDisabledReason).toBeDefined();
    expect(state.centreTransaction).toBeUndefined();
    expect(state.resetTransaction).toBeUndefined();
  });

  it('keeps Centre and blocks only Reset while the scale is animated', () => {
    const scaling: VisualObjectV1 = {
      ...textObject,
      animations: { scaleX: { keyframes: [{ timeUs: 0, value: 1, interpolation: 'linear' }] } },
    };
    const state = monitorContextTransformState({
      objectId: 'title',
      object: scaling,
      project: project({ title: scaling }),
      target: target(),
      frameWidth: 1080,
      frameHeight: 1920,
    });

    expect(state.disabledReason).toBeUndefined();
    expect(state.centreDisabledReason).toBeUndefined();
    expect(state.centreTransaction).toBeDefined();
    expect(state.resetDisabledReason).toBeDefined();
    expect(state.resetTransaction).toBeUndefined();
  });

  it('keeps Centre and blocks only Reset while a rotation expression drives the object', () => {
    const turning: VisualObjectV1 = { ...textObject, expressions: { rotationDeg: 'time' } };
    const state = monitorContextTransformState({
      objectId: 'title',
      object: turning,
      project: project({ title: turning }),
      target: target(),
      frameWidth: 1080,
      frameHeight: 1920,
    });

    expect(state.centreTransaction).toBeDefined();
    expect(state.resetDisabledReason).toBeDefined();
    expect(state.resetTransaction).toBeUndefined();
  });

  it('keeps both actions for a child of an animated parent, as the Monitor box does', () => {
    const child: VisualObjectV1 = { ...textObject, parentId: 'parent' };
    const parent: VisualObjectV1 = {
      ...textObject,
      id: 'parent',
      kind: 'null',
      animations: {
        rotationDeg: { keyframes: [{ timeUs: 0, value: 10, interpolation: 'linear' }] },
      },
    };
    const state = monitorContextTransformState({
      objectId: 'title',
      object: child,
      project: project({ title: child, parent }),
      target: target({ ancestorObjectIds: ['parent'] }),
      frameWidth: 1080,
      frameHeight: 1920,
    });

    expect(state.disabledReason).toBeUndefined();
    expect(state.centreTransaction).toBeDefined();
    expect(state.resetTransaction).toBeDefined();
  });

  it.each(['centreTransaction', 'resetTransaction'] as const)(
    'applies %s as one undo step',
    (transactionKey) => {
      const seed = INITIAL_EDITOR_PROJECT.visualObjects['intro-title']!;
      const { animations: _animations, ...staticSeed } = seed;
      const object: VisualObjectV1 = {
        ...staticSeed,
        transform: {
          ...seed.transform,
          x: 100,
          y: 200,
          scaleX: 2,
          scaleY: 2,
          rotationDeg: 30,
        },
      };
      const editableProject = {
        ...INITIAL_EDITOR_PROJECT,
        visualObjects: { ...INITIAL_EDITOR_PROJECT.visualObjects, [object.id]: object },
      };
      const session = new EditorSession(
        memoryStorage(),
        buildReferenceSpikeProject(),
        editableProject,
      );
      const state = monitorContextTransformState({
        objectId: object.id,
        object,
        project: editableProject,
        target: target({
          nodeId: object.id,
          clipId: 'intro',
          objectId: object.id,
        }),
        frameWidth: 1080,
        frameHeight: 1920,
      });
      const edit = state[transactionKey];
      expect(edit).toBeDefined();

      session.dispatchVisualObjects(edit!);
      expect(session.canUndo).toBe(true);
      session.undo();

      expect(session.visualProject.visualObjects[object.id]?.transform).toEqual(object.transform);
      expect(session.canUndo).toBe(false);
    },
  );
});
