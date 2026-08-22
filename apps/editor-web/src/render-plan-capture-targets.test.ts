import { describe, expect, it } from 'vitest';
import type { JoyProjectV1, VisualObjectTransformV1 } from '@joy-media/project-schema';
import type { PlannedCaptureRequirement } from '@joy-media/render-planner';
import { IMAGE_MATTE_PLUGIN_KEY } from './sticker-bindings.js';
import {
  htmlSceneCaptureTargetsForRequirements,
  plannedMotionSceneCaptureTargets,
  plannedHtmlSceneCaptureTargets,
  plannedStillBitmapTargets,
  requiredCaptureObjectIds,
} from './render-plan-capture-targets.js';

describe('render plan capture targets', () => {
  it('derives html-scene targets from planner capture requirements and keeps planner timeUs', () => {
    const project = visualProject();
    const targets = plannedHtmlSceneCaptureTargets(project, [
      {
        id: 'html-scene:scene-b',
        kind: 'html-scene',
        objectId: 'scene-b',
        assetId: 'html-scene:scene.package.b',
        sourceTimeUs: 345_678,
      },
    ]);

    expect(targets).toEqual([
      {
        requirementId: 'html-scene:scene-b',
        objectId: 'scene-b',
        assetId: 'html-scene:scene.package.b',
        scenePackageId: 'scene.package.b',
        timeUs: 345_678,
      },
    ]);
  });

  it('keeps the App html-scene capture helper name wired to the planner implementation', () => {
    const project = visualProject();
    const requirements: readonly PlannedCaptureRequirement[] = [
      {
        id: 'html-scene:scene-b',
        kind: 'html-scene',
        objectId: 'scene-b',
        assetId: 'html-scene:scene.package.b',
        sourceTimeUs: 345_678,
      },
    ];

    expect(htmlSceneCaptureTargetsForRequirements(project, requirements)).toEqual(
      plannedHtmlSceneCaptureTargets(project, requirements),
    );
  });

  it('derives published Motion Studio capture targets only from matching object ids', () => {
    const project = {
      ...visualProject(),
      visualObjects: {
        ...visualProject().visualObjects,
        'motion-a': {
          id: 'motion-a',
          kind: 'motion-scene' as const,
          motionSceneId: 'motion-doc-a',
          transform: transform(),
        },
      },
    };
    expect(
      plannedMotionSceneCaptureTargets(project, [
        {
          id: 'motion-scene:motion-a',
          kind: 'motion-scene',
          objectId: 'motion-a',
          assetId: 'motion-scene:motion-doc-a',
          sourceTimeUs: 456_789,
        },
      ]),
    ).toEqual([
      {
        requirementId: 'motion-scene:motion-a',
        objectId: 'motion-a',
        assetId: 'motion-scene:motion-doc-a',
        motionSceneId: 'motion-doc-a',
        timeUs: 456_789,
      },
    ]);
  });

  it('derives still targets only for planner-requested objects and preserves matte/crop data', () => {
    const project = visualProject();
    const targets = plannedStillBitmapTargets(project, [
      {
        id: 'still:still-a',
        kind: 'still-bitmap',
        objectId: 'still-a',
        assetId: 'image-a',
      },
    ]);

    expect(targets).toEqual([
      {
        requirementId: 'still:still-a',
        objectId: 'still-a',
        assetId: 'image-a',
        matteAssetId: 'matte-a',
        crop: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 },
      },
    ]);
  });

  it('tracks required object ids by planner capture kind', () => {
    const requirements: readonly PlannedCaptureRequirement[] = [
      { id: 'still:still-a', kind: 'still-bitmap', objectId: 'still-a', assetId: 'image-a' },
      {
        id: 'html-scene:scene-b',
        kind: 'html-scene',
        objectId: 'scene-b',
        assetId: 'html-scene:scene.package.b',
        sourceTimeUs: 123,
      },
      { id: 'caption-burn-in', kind: 'caption-burn-in' },
    ];

    expect(requiredCaptureObjectIds(requirements, 'still-bitmap')).toEqual(new Set(['still-a']));
    expect(requiredCaptureObjectIds(requirements, 'html-scene')).toEqual(new Set(['scene-b']));
  });
});

function visualProject(): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id: 'visual',
    title: 'Visual',
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
        background: '#000000',
        tracks: [],
      },
    },
    assets: {
      'image-a': { id: 'image-a', kind: 'image', displayName: 'Image A' },
      'image-b': { id: 'image-b', kind: 'image', displayName: 'Image B' },
    },
    variables: {},
    markers: [],
    visualObjects: {
      'still-a': {
        id: 'still-a',
        kind: 'image',
        assetId: 'image-a',
        transform: transform({ left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 }),
      },
      'still-b': {
        id: 'still-b',
        kind: 'image',
        assetId: 'image-b',
        transform: transform(),
      },
      'scene-a': {
        id: 'scene-a',
        kind: 'html-scene',
        scenePackageId: 'scene.package.a',
        transform: transform(),
      },
      'scene-b': {
        id: 'scene-b',
        kind: 'html-scene',
        scenePackageId: 'scene.package.b',
        transform: transform(),
      },
    },
    captionDocuments: {},
    pluginData: { [IMAGE_MATTE_PLUGIN_KEY]: { 'still-a': 'matte-a' } },
  };
}

function transform(
  crop: VisualObjectTransformV1['crop'] = { left: 0, top: 0, right: 0, bottom: 0 },
): VisualObjectTransformV1 {
  return {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop,
  };
}
