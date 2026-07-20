import { describe, expect, it } from 'vitest';
import type { CompositionV1, JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
import { rational } from '@joy-media/project-schema';
import { VisualObjectProjectHistory } from './index.js';
import type { VisualObjectTransaction } from './index.js';

const camera: VisualObjectV1 = {
  id: 'cam-1',
  kind: 'camera',
  transform: {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  },
  camera: { fieldOfViewDeg: 54 },
};

const notACamera: VisualObjectV1 = { id: 'title', kind: 'text', transform: camera.transform };

const rootComposition: CompositionV1 = {
  id: 'root',
  name: 'Root',
  width: 1920,
  height: 1080,
  pixelAspectRatio: rational(1, 1),
  frameRate: rational(30, 1),
  durationUs: 1_000_000,
  background: '#000000',
  tracks: [],
};

const project: JoyProjectV1 = {
  schemaVersion: 1,
  id: 'p',
  title: 'P',
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
  rootCompositionId: 'root',
  settings: { defaultLocale: 'en' },
  compositions: { root: rootComposition },
  assets: {},
  variables: {},
  markers: [],
  visualObjects: { 'cam-1': camera, title: notACamera },
  captionDocuments: {},
  pluginData: {},
};

const setCamera: VisualObjectTransaction = {
  label: 'Set active camera',
  commands: [
    { type: 'composition.setActiveCamera', payload: { compositionId: 'root', cameraId: 'cam-1' } },
  ],
};

describe('composition.setActiveCamera on the shared v1 history', () => {
  it('applies, undoes, and redoes setting the active camera', () => {
    const history = new VisualObjectProjectHistory(project);

    const applied = history.apply(setCamera);
    expect(applied.compositions['root']!.activeCameraId).toBe('cam-1');

    const undone = history.undo().project;
    expect(undone.compositions['root']!.activeCameraId).toBeUndefined();

    const redone = history.redo().project;
    expect(redone.compositions['root']!.activeCameraId).toBe('cam-1');
  });

  it('clearing restores the prior camera as the undo inverse', () => {
    const history = new VisualObjectProjectHistory(project);
    history.apply(setCamera);
    history.apply({
      label: 'Clear active camera',
      commands: [{ type: 'composition.setActiveCamera', payload: { compositionId: 'root' } }],
    });
    expect(history.present.compositions['root']!.activeCameraId).toBeUndefined();

    const undone = history.undo().project;
    expect(undone.compositions['root']!.activeCameraId).toBe('cam-1');
  });

  it('rejects an unknown composition', () => {
    const history = new VisualObjectProjectHistory(project);
    expect(() =>
      history.apply({
        label: 'Bad composition',
        commands: [
          {
            type: 'composition.setActiveCamera',
            payload: { compositionId: 'ghost', cameraId: 'cam-1' },
          },
        ],
      }),
    ).toThrow(/unknown composition/);
  });

  it('rejects an unknown or non-camera object id', () => {
    const history = new VisualObjectProjectHistory(project);
    expect(() =>
      history.apply({
        label: 'Unknown camera',
        commands: [
          {
            type: 'composition.setActiveCamera',
            payload: { compositionId: 'root', cameraId: 'ghost' },
          },
        ],
      }),
    ).toThrow(/unknown camera/);
    expect(() =>
      history.apply({
        label: 'Non-camera object',
        commands: [
          {
            type: 'composition.setActiveCamera',
            payload: { compositionId: 'root', cameraId: 'title' },
          },
        ],
      }),
    ).toThrow(/is not a camera/);
  });
});

const newCamera: VisualObjectV1 = {
  id: 'cam-new',
  kind: 'camera',
  transform: {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  },
  camera: { fieldOfViewDeg: 54 },
};

describe('camera.create / camera.remove on the shared v1 history', () => {
  it('creates, undoes (removes), and redoes (re-creates) a camera object', () => {
    const history = new VisualObjectProjectHistory(project);
    const created = history.apply({
      label: 'Create camera',
      commands: [{ type: 'camera.create', payload: { object: newCamera } }],
    });
    expect(created.visualObjects['cam-new']).toEqual(newCamera);

    const undone = history.undo().project;
    expect(undone.visualObjects['cam-new']).toBeUndefined();

    const redone = history.redo().project;
    expect(redone.visualObjects['cam-new']).toEqual(newCamera);
  });

  it('rejects creating a non-camera object or a duplicate id', () => {
    const history = new VisualObjectProjectHistory(project);
    expect(() =>
      history.apply({
        label: 'Bad kind',
        commands: [{ type: 'camera.create', payload: { object: { ...newCamera, kind: 'text' } } }],
      }),
    ).toThrow(/camera-kind/);
    expect(() =>
      history.apply({
        label: 'Duplicate id',
        commands: [{ type: 'camera.create', payload: { object: { ...newCamera, id: 'cam-1' } } }],
      }),
    ).toThrow(/already exists/);
  });

  it('rejects removing a camera that is still the active camera or still a parent', () => {
    const history = new VisualObjectProjectHistory(project);
    history.apply(setCamera); // cam-1 becomes root's active camera
    expect(() =>
      history.apply({
        label: 'Remove active camera',
        commands: [{ type: 'camera.remove', payload: { objectId: 'cam-1' } }],
      }),
    ).toThrow(/still the active camera/);

    const historyWithChild = new VisualObjectProjectHistory({
      ...project,
      visualObjects: {
        ...project.visualObjects,
        child: { ...notACamera, id: 'child', parentId: 'cam-1' },
      },
    });
    expect(() =>
      historyWithChild.apply({
        label: 'Remove parent camera',
        commands: [{ type: 'camera.remove', payload: { objectId: 'cam-1' } }],
      }),
    ).toThrow(/still the parent/);
  });

  it('rejects removing an unknown or non-camera object', () => {
    const history = new VisualObjectProjectHistory(project);
    expect(() =>
      history.apply({
        label: 'Remove ghost',
        commands: [{ type: 'camera.remove', payload: { objectId: 'ghost' } }],
      }),
    ).toThrow(/unknown visual object/);
    expect(() =>
      history.apply({
        label: 'Remove non-camera',
        commands: [{ type: 'camera.remove', payload: { objectId: 'title' } }],
      }),
    ).toThrow(/is not a camera/);
  });
});

describe('camera.setFieldOfView on the shared v1 history', () => {
  it('applies, undoes, and redoes a field-of-view change', () => {
    const history = new VisualObjectProjectHistory(project);
    const applied = history.apply({
      label: 'Set FOV',
      commands: [
        { type: 'camera.setFieldOfView', payload: { objectId: 'cam-1', fieldOfViewDeg: 80 } },
      ],
    });
    expect(applied.visualObjects['cam-1']!.camera?.fieldOfViewDeg).toBe(80);

    const undone = history.undo().project;
    expect(undone.visualObjects['cam-1']!.camera?.fieldOfViewDeg).toBe(54);

    const redone = history.redo().project;
    expect(redone.visualObjects['cam-1']!.camera?.fieldOfViewDeg).toBe(80);
  });

  it('rejects an out-of-range field of view and a non-camera target', () => {
    const history = new VisualObjectProjectHistory(project);
    expect(() =>
      history.apply({
        label: 'Bad FOV',
        commands: [
          { type: 'camera.setFieldOfView', payload: { objectId: 'cam-1', fieldOfViewDeg: 200 } },
        ],
      }),
    ).toThrow(/fieldOfViewDeg must be in/);
    expect(() =>
      history.apply({
        label: 'Not a camera',
        commands: [
          { type: 'camera.setFieldOfView', payload: { objectId: 'title', fieldOfViewDeg: 60 } },
        ],
      }),
    ).toThrow(/is not a camera/);
  });
});
