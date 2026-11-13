// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { InspectorPanel } from './InspectorPanel.js';
import { EditorSession } from './editor-session.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OBJECT: VisualObjectV1 = {
  id: 'media-controller-clip-1',
  kind: 'null',
  assetId: 'asset-1',
  transform: {
    x: 100,
    y: 80,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  },
  animations: {
    x: {
      keyframes: [
        { timeUs: 0, value: 100, interpolation: 'linear' },
        { timeUs: 1_000_000, value: 200, interpolation: 'linear' },
      ],
    },
    scaleX: {
      keyframes: [
        { timeUs: 0, value: 1, interpolation: 'linear' },
        { timeUs: 1_000_000, value: 2, interpolation: 'linear' },
      ],
    },
  },
};

const PROJECT = {
  schemaVersion: 1,
  id: 'project-1',
  title: 'Project',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  rootCompositionId: 'root',
  settings: { defaultLocale: 'en' },
  compositions: {
    root: {
      id: 'root',
      name: 'Root',
      width: 1920,
      height: 1080,
      pixelAspectRatio: { num: 1, den: 1 },
      frameRate: { num: 30, den: 1 },
      durationUs: 5_000_000,
      background: '#000000',
      tracks: [
        {
          id: 'track-1',
          kind: 'video',
          name: 'Video 1',
          order: 0,
          enabled: true,
          locked: false,
          clips: [
            {
              id: 'clip-1',
              kind: 'video',
              assetId: 'asset-1',
              startUs: 0,
              durationUs: 1_000_000,
              sourceInUs: 0,
            },
          ],
        },
      ],
    },
  },
  assets: {
    'asset-1': {
      id: 'asset-1',
      kind: 'video',
      displayName: 'Clip',
      descriptor: { mimeType: 'video/mp4', width: 640, height: 480 },
    },
  },
  variables: {},
  markers: [],
  visualObjects: { [OBJECT.id]: OBJECT },
  captionDocuments: {},
  pluginData: {},
} as JoyProjectV1;

const STATIC_OBJECT: VisualObjectV1 = {
  id: OBJECT.id,
  kind: OBJECT.kind,
  ...(OBJECT.assetId === undefined ? {} : { assetId: OBJECT.assetId }),
  transform: OBJECT.transform,
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function mount(
  onDispatch: ReturnType<typeof vi.fn>,
  object: VisualObjectV1 = STATIC_OBJECT,
  project: JoyProjectV1 = PROJECT,
  selectedClipId: string | null = 'clip-1',
) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <InspectorPanel
        object={object}
        {...(selectedClipId === null ? {} : { selectedClipId })}
        allObjects={{ [object.id]: object }}
        project={project}
        playheadUs={500_000}
        onSetStatic={() => undefined}
        onDispatch={onDispatch}
      />,
    ),
  );
  return container;
}

function clickButton(label: string): void {
  const button = container?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  if (button !== null && button !== undefined) act(() => button.click());
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('Inspector Fit and Fill actions', () => {
  it('fits static media in one transaction', () => {
    const onDispatch = vi.fn();
    mount(onDispatch);

    clickButton('Fit clip to frame');

    expect(onDispatch).toHaveBeenCalledTimes(1);
    const transaction = onDispatch.mock.calls[0]?.[0];
    expect(transaction?.label).toBe('Fit to frame');
    expect(transaction?.commands).toEqual([
      {
        type: 'object.setTransformProperty',
        payload: { objectId: OBJECT.id, key: 'x', value: 240 },
      },
      {
        type: 'object.setTransformProperty',
        payload: { objectId: OBJECT.id, key: 'y', value: 0 },
      },
      {
        type: 'object.setTransformProperty',
        payload: { objectId: OBJECT.id, key: 'scaleX', value: 2.25 },
      },
      {
        type: 'object.setTransformProperty',
        payload: { objectId: OBJECT.id, key: 'scaleY', value: 2.25 },
      },
    ]);
  });

  it('fills the frame while keeping the source aspect ratio', () => {
    const onDispatch = vi.fn();
    mount(onDispatch);

    clickButton('Fill frame with clip');

    expect(onDispatch).toHaveBeenCalledTimes(1);
    const transaction = onDispatch.mock.calls[0]?.[0];
    expect(transaction?.label).toBe('Fill frame');
    expect(transaction?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: { objectId: OBJECT.id, key: 'x', value: 0 },
        }),
        expect.objectContaining({
          payload: { objectId: OBJECT.id, key: 'y', value: -180 },
        }),
        expect.objectContaining({
          payload: { objectId: OBJECT.id, key: 'scaleX', value: 3 },
        }),
        expect.objectContaining({
          payload: { objectId: OBJECT.id, key: 'scaleY', value: 3 },
        }),
      ]),
    );
  });

  it('restores the exact previous transform with one Undo after Inspector Fill', () => {
    const visualProject = {
      ...PROJECT,
      visualObjects: { ...PROJECT.visualObjects, [OBJECT.id]: STATIC_OBJECT },
    } as JoyProjectV1;
    const session = new EditorSession(memoryStorage(), buildReferenceSpikeProject(), visualProject);
    const previousTransform = session.visualProject.visualObjects[OBJECT.id]?.transform;
    const onDispatch = vi.fn((transaction: Parameters<EditorSession['dispatchVisualObjects']>[0]) =>
      session.dispatchVisualObjects(transaction),
    );
    mount(onDispatch, STATIC_OBJECT, visualProject);

    clickButton('Fill frame with clip');

    expect(session.visualProject.visualObjects[OBJECT.id]?.transform).not.toEqual(
      previousTransform,
    );
    expect(session.historyEntries.at(-1)?.label).toBe('Fill frame');
    session.undo();
    expect(session.visualProject.visualObjects[OBJECT.id]?.transform).toEqual(previousTransform);
    expect(session.canUndo).toBe(false);
  });

  it('disables Fit and Fill when transform channels are animated', () => {
    const onDispatch = vi.fn();
    const mounted = mount(onDispatch, OBJECT);

    const fit = mounted.querySelector<HTMLButtonElement>('button[aria-label="Fit clip to frame"]');
    const fill = mounted.querySelector<HTMLButtonElement>(
      'button[aria-label="Fill frame with clip"]',
    );
    expect(fit?.disabled).toBe(true);
    expect(fill?.disabled).toBe(true);
    expect(fit?.title).toMatch(/animated or expression-driven/i);
    fit?.click();
    expect(onDispatch).not.toHaveBeenCalled();
    expect(OBJECT.animations?.x?.keyframes).toHaveLength(2);
    expect(OBJECT.animations?.scaleX?.keyframes).toHaveLength(2);
  });

  it('disables Fit and Fill when a transform channel is expression-driven', () => {
    const mounted = mount(vi.fn(), { ...STATIC_OBJECT, expressions: { rotationDeg: 'time' } });
    expect(
      mounted.querySelector<HTMLButtonElement>('button[aria-label="Fit clip to frame"]')?.disabled,
    ).toBe(true);
  });

  it('disables Fit and Fill when the media object has a parent', () => {
    const mounted = mount(vi.fn(), { ...STATIC_OBJECT, parentId: 'parent-1' });
    expect(
      mounted.querySelector<HTMLButtonElement>('button[aria-label="Fit clip to frame"]')?.disabled,
    ).toBe(true);
  });

  it('disables Fit and Fill when the selected composition has an active camera', () => {
    const cameraProject = {
      ...PROJECT,
      compositions: {
        root: { ...PROJECT.compositions.root!, activeCameraId: 'camera-1' },
      },
    } as JoyProjectV1;
    const mounted = mount(vi.fn(), STATIC_OBJECT, cameraProject);
    expect(
      mounted.querySelector<HTMLButtonElement>('button[aria-label="Fit clip to frame"]')?.disabled,
    ).toBe(true);
  });

  it('hides Fit and Fill when no selected clip identifies a composition', () => {
    const mounted = mount(vi.fn(), STATIC_OBJECT, PROJECT, null);
    expect(mounted.querySelector('button[aria-label="Fit clip to frame"]')).toBeNull();
  });
});
