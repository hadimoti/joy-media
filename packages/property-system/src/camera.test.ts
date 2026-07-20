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
