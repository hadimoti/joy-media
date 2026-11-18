import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import type { JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { EditorSession } from '../editor-session.js';
import { monitorContextTransformState } from './monitor-context-transform.js';
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
            clips: [{ id: 'parent-clip', kind: 'video', startUs: 0, durationUs: 1_000_000 }],
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
    expect(
      state.resetTransaction?.commands
        .filter((command) => command.type === 'object.setTransformProperty')
        .map((command) => command.payload.key),
    ).not.toContain('crop');
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

    expect(
      state.resetTransaction?.commands
        .filter((command) => command.type === 'object.setTransformProperty')
        .map((command) => command.payload.value),
    ).toEqual([520, 965, 1, 1, 0]);
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
    expect(
      state.centreTransaction?.commands
        .filter((command) => command.type === 'object.setTransformProperty')
        .map((command) => command.payload.value),
    ).toEqual([450, 780]);
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

  it.each([
    [
      'the object is already centred and reset',
      target({
        geometry: {
          ...target().geometry,
          transform: { x: 540, y: 960, scaleX: 1, scaleY: 1, rotationDeg: 0 },
          origin: { x: 540, y: 960 },
          center: { x: 540, y: 960 },
        },
        local: { x: 540, y: 960, scaleX: 1, scaleY: 1, rotationDeg: 0 },
      }),
      project(),
    ],
    [
      'the object has an animated transform',
      target(),
      project({
        title: {
          ...textObject,
          animations: { x: { keyframes: [{ timeUs: 0, value: 100, interpolation: 'linear' }] } },
        },
      }),
    ],
    [
      'the parent is locked',
      target({ ancestorObjectIds: ['parent'] }),
      project(
        {
          title: { ...textObject, parentId: 'parent' },
          parent: { ...textObject, id: 'parent', kind: 'null' },
        },
        { parentTrackLocked: true },
      ),
    ],
    [
      'the parent has an animated transform',
      target({ ancestorObjectIds: ['parent'] }),
      project({
        title: { ...textObject, parentId: 'parent' },
        parent: {
          ...textObject,
          id: 'parent',
          kind: 'null',
          animations: {
            rotationDeg: {
              keyframes: [{ timeUs: 0, value: 10, interpolation: 'linear' }],
            },
          },
        },
      }),
    ],
  ])('disables both actions when %s', (_name, targetInput, projectInput) => {
    const object = projectInput.visualObjects.title!;
    const state = monitorContextTransformState({
      objectId: 'title',
      object,
      project: projectInput,
      target: targetInput,
      frameWidth: 1080,
      frameHeight: 1920,
    });

    if (_name === 'the object is already centred and reset') {
      expect(state.alreadyCentred).toBe(true);
      expect(state.alreadyReset).toBe(true);
    } else {
      expect(state.disabledReason).toBeTruthy();
      expect(state.centreTransaction).toBeUndefined();
      expect(state.resetTransaction).toBeUndefined();
    }
  });
});
