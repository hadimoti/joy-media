import type {
  JoyProjectV1,
  VisualObjectTransformV1,
  VisualObjectV1,
} from '@joy-media/project-schema';
import { canonicalBindingKey } from '@joy-media/project-schema';
import { describe, expect, it } from 'vitest';
import {
  canvasReframeSkippedObjectCount,
  reframeProjectClips,
  shouldAskCanvasReframe,
} from './canvas-reframe.js';

const source = { width: 100, height: 200 };
const target = { width: 100, height: 100 };

describe('canvas reframe confirmation', () => {
  it('asks once when an existing timeline has clips and the canvas size changes', () => {
    expect(
      shouldAskCanvasReframe({ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, true),
    ).toBe(true);
    expect(
      shouldAskCanvasReframe({ width: 1920, height: 1080 }, { width: 3840, height: 2160 }, true),
    ).toBe(true);
  });

  it('skips the dialog when the canvas is unchanged or the timeline is empty', () => {
    expect(
      shouldAskCanvasReframe({ width: 1920, height: 1080 }, { width: 1920, height: 1080 }, true),
    ).toBe(false);
    expect(
      shouldAskCanvasReframe({ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, false),
    ).toBe(false);
  });
});

describe('reframeProjectClips', () => {
  it('reframes a 9:16 clip with an offset, rotation, and crop into a square', () => {
    const project = projectWithClips(
      { 'reframe-clip': 'picture' },
      {
        picture: visualObject('picture', {
          x: 80,
          y: 140,
          scaleX: 2,
          scaleY: 1.5,
          rotationDeg: 33,
          crop: { left: 0.1, top: 0.2, right: 0.05, bottom: 0.04 },
        }),
      },
    );

    const result = reframeProjectClips(project, target, 'fit');

    expect(result.visualObjects.picture?.transform).toMatchObject({
      x: 65,
      y: 70,
      scaleX: 1,
      scaleY: 0.75,
      rotationDeg: 33,
      crop: { left: 0.1, top: 0.2, right: 0.05, bottom: 0.04 },
    });
  });

  it('remaps a bound parent once and leaves its bound child in parent-local coordinates', () => {
    const project = projectWithClips(
      { 'parent-clip': 'parent', 'child-clip': 'child' },
      {
        parent: visualObject('parent', { x: 80, y: 120 }),
        child: visualObject('child', { x: 30, y: 20 }, { parentId: 'parent' }),
      },
    );

    const result = reframeProjectClips(project, target, 'fit');

    expect(result.visualObjects.parent?.transform).toMatchObject({ x: 65, y: 60 });
    expect(result.visualObjects.child?.transform).toEqual(project.visualObjects.child?.transform);
  });

  it('moves an unbound null controller while keeping its bound child local position', () => {
    const project = projectWithClips(
      { 'child-clip': 'child' },
      {
        controller: visualObject('controller', { x: 80, y: 120 }, { kind: 'null' }),
        child: visualObject('child', { x: 30, y: 20 }, { parentId: 'controller' }),
      },
    );

    const result = reframeProjectClips(project, target, 'fit');

    expect(result.visualObjects.controller?.transform).toMatchObject({ x: 65, y: 60 });
    expect(result.visualObjects.child?.transform).toEqual(project.visualObjects.child?.transform);
  });

  it('remaps the active camera along with the clip objects', () => {
    const project = projectWithClips(
      { 'clip-1': 'picture' },
      {
        picture: visualObject('picture', { x: 80, y: 120 }),
        camera: visualObject('camera', { x: 60, y: 80 }, { kind: 'camera' }),
      },
      'camera',
    );

    const result = reframeProjectClips(project, target, 'fit');

    expect(result.visualObjects.picture?.transform).toMatchObject({ x: 65, y: 60 });
    expect(result.visualObjects.camera?.transform).toMatchObject({ x: 55, y: 40 });
  });

  it('scales keyframed transform values while preserving curve timing and easing', () => {
    const project = projectWithClips(
      { 'clip-1': 'picture' },
      {
        picture: {
          ...visualObject('picture', { x: 50, y: 100 }),
          animations: {
            x: {
              keyframes: [
                {
                  timeUs: 0,
                  value: 0,
                  interpolation: 'bezier',
                  bezier: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 },
                },
                { timeUs: 1_000_000, value: 100, interpolation: 'linear' },
              ],
            },
            y: {
              keyframes: [{ timeUs: 0, value: 200, interpolation: 'linear' }],
            },
            scaleX: {
              keyframes: [{ timeUs: 0, value: 2, interpolation: 'linear' }],
            },
          },
        },
      },
    );

    const result = reframeProjectClips(project, target, 'fit');

    expect(result.visualObjects.picture?.animations).toEqual({
      x: {
        keyframes: [
          {
            timeUs: 0,
            value: 25,
            interpolation: 'bezier',
            bezier: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 },
          },
          { timeUs: 1_000_000, value: 75, interpolation: 'linear' },
        ],
      },
      y: { keyframes: [{ timeUs: 0, value: 100, interpolation: 'linear' }] },
      scaleX: { keyframes: [{ timeUs: 0, value: 1, interpolation: 'linear' }] },
    });
  });

  it('scales spatial path points and tangents with the same canvas mapping', () => {
    const project = projectWithClips(
      { 'clip-1': 'picture' },
      {
        picture: {
          ...visualObject('picture'),
          spatialPath: {
            keyframes: [
              {
                timeUs: 0,
                point: { x: 20, y: 40 },
                interpolation: 'bezier',
                bezier: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 },
                outTangent: { x: 8, y: 10 },
              },
              {
                timeUs: 1_000_000,
                point: { x: 80, y: 160 },
                interpolation: 'linear',
                inTangent: { x: -6, y: -4 },
              },
            ],
          },
        },
      },
    );

    const result = reframeProjectClips(project, target, 'fit');

    expect(result.visualObjects.picture?.spatialPath).toEqual({
      keyframes: [
        {
          timeUs: 0,
          point: { x: 35, y: 20 },
          interpolation: 'bezier',
          bezier: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 },
          outTangent: { x: 4, y: 5 },
        },
        {
          timeUs: 1_000_000,
          point: { x: 65, y: 80 },
          interpolation: 'linear',
          inTangent: { x: -3, y: -2 },
        },
      ],
    });
  });

  it('scales universal keyframed position and scale channels', () => {
    const positionBinding = {
      ownerKind: 'visual-object' as const,
      ownerId: 'picture',
      propertyId: 'visual.transform.position',
      timeDomain: 'composition' as const,
    };
    const scaleBinding = {
      ...positionBinding,
      propertyId: 'visual.transform.scale',
    };
    const project = {
      ...projectWithClips({ 'clip-1': 'picture' }, { picture: visualObject('picture') }),
      propertyAnimations: {
        [canonicalBindingKey(positionBinding)]: {
          binding: positionBinding,
          value: {
            kind: 'vector' as const,
            curve: {
              x: {
                keyframes: [
                  { timeUs: 0, value: 0, interpolation: 'linear' as const },
                  { timeUs: 1_000_000, value: 100, interpolation: 'linear' as const },
                ],
              },
              y: { keyframes: [{ timeUs: 0, value: 200, interpolation: 'linear' as const }] },
            },
          },
        },
        [canonicalBindingKey(scaleBinding)]: {
          binding: scaleBinding,
          value: {
            kind: 'vector' as const,
            curve: {
              scaleX: { keyframes: [{ timeUs: 0, value: 2, interpolation: 'linear' as const }] },
              scaleY: { keyframes: [{ timeUs: 0, value: 4, interpolation: 'linear' as const }] },
            },
          },
        },
      },
    };

    const result = reframeProjectClips(project, target, 'fit');

    expect(result.propertyAnimations?.[canonicalBindingKey(positionBinding)]?.value).toMatchObject({
      kind: 'vector',
      curve: {
        x: { keyframes: [{ value: 25 }, { value: 75 }] },
        y: { keyframes: [{ value: 100 }] },
      },
    });
    expect(result.propertyAnimations?.[canonicalBindingKey(scaleBinding)]?.value).toMatchObject({
      kind: 'vector',
      curve: {
        scaleX: { keyframes: [{ value: 1 }] },
        scaleY: { keyframes: [{ value: 2 }] },
      },
    });
  });

  it('leaves expression-driven objects unchanged and counts them once', () => {
    const project = projectWithClips(
      { 'clip-1': 'picture' },
      {
        picture: {
          ...visualObject('picture', { x: 50, y: 100 }),
          expressions: { x: 'ref("anchor", "x")', y: '100' },
          animations: { x: { keyframes: [{ timeUs: 0, value: 50, interpolation: 'linear' }] } },
        },
      },
    );

    const result = reframeProjectClips(project, target, 'fit');

    expect(result.visualObjects.picture).toEqual(project.visualObjects.picture);
    expect(canvasReframeSkippedObjectCount(project)).toBe(1);
  });

  it('leaves unsupported transform animation formats unchanged and counts them', () => {
    const binding = {
      ownerKind: 'visual-object' as const,
      ownerId: 'picture',
      propertyId: 'visual.transform.position',
      timeDomain: 'composition' as const,
    };
    const project = {
      ...projectWithClips({ 'clip-1': 'picture' }, { picture: visualObject('picture') }),
      propertyAnimations: {
        [canonicalBindingKey(binding)]: {
          binding,
          value: {
            kind: 'curve-snapshot' as const,
            samples: [{ timeUs: 0, channels: { position: [50, 100] }, interpolation: 'linear' }],
          },
        },
      },
    };

    const result = reframeProjectClips(project, target, 'fit');

    expect(result.visualObjects.picture).toEqual(project.visualObjects.picture);
    expect(result.propertyAnimations).toEqual(project.propertyAnimations);
    expect(canvasReframeSkippedObjectCount(project)).toBe(1);
  });
});

function projectWithClips(
  clipBindings: Readonly<Record<string, string>>,
  visualObjects: Readonly<Record<string, VisualObjectV1>>,
  activeCameraId?: string,
): JoyProjectV1 {
  const clips = Object.keys(clipBindings).map((id, index) => ({
    id,
    kind: 'video' as const,
    assetId: `asset-${index}`,
    startUs: index * 1_000_000,
    durationUs: 1_000_000,
    sourceInUs: 0,
  }));
  return {
    schemaVersion: 1,
    id: 'reframe-project',
    title: 'Reframe test',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: source.width,
        height: source.height,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 10_000_000,
        background: '#000000',
        tracks: [
          {
            id: 'track',
            kind: 'video',
            name: 'Video',
            order: 0,
            enabled: true,
            locked: false,
            clips,
          },
        ],
        ...(activeCameraId === undefined ? {} : { activeCameraId }),
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects,
    captionDocuments: {},
    pluginData: { 'joy.clipObjects': clipBindings },
  };
}

function visualObject(
  id: string,
  transform: Partial<VisualObjectTransformV1> = {},
  options: Omit<Partial<VisualObjectV1>, 'id' | 'transform'> = {},
): VisualObjectV1 {
  return {
    id,
    kind: 'image',
    ...options,
    transform: {
      x: 50,
      y: 100,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
      ...transform,
    },
  };
}
