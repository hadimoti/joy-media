import { describe, expect, it } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { buildMediaPlacementDocument, withImportedAsset } from './place-timeline-element.js';

describe('place-timeline-element', () => {
  it('plans asset, renderable image object, binding, and source timing together', () => {
    const project = baseProject();
    const next = buildMediaPlacementDocument({
      baseProject: project,
      asset: {
        id: 'asset-image',
        kind: 'image',
        displayName: 'Poster',
        descriptor: { mimeType: 'image/png', width: 640, height: 360 },
      },
      clipId: 'clip-image',
      planned: {
        compositionId: 'root',
        trackId: 'track-1',
        clip: {
          id: 'clip-image',
          kind: 'video',
          assetId: 'asset-image',
          startUs: 2_000_000,
          durationUs: 5_000_000,
          sourceInUs: 125_000,
        },
      },
    });

    expect(next.assets['asset-image']).toMatchObject({ id: 'asset-image', kind: 'image' });
    expect(next.visualObjects['media-controller-clip-image']).toMatchObject({ kind: 'image' });
    expect(next.pluginData['joy.clipObjects']).toEqual({
      'clip-image': 'media-controller-clip-image',
    });
    expect(next.universalTimeline?.items).toContainEqual(
      expect.objectContaining({
        id: 'clip-image',
        elementKind: 'image',
        source: { kind: 'object', id: 'media-controller-clip-image' },
        sourceInUs: 125_000,
      }),
    );
    expect(project.assets['asset-image']).toBeUndefined();
  });

  it('does not overwrite an existing controller on retry', () => {
    const project = baseProject();
    const withAsset = withImportedAsset(project, {
      id: 'asset-video',
      kind: 'video',
      displayName: 'Video',
      descriptor: { mimeType: 'video/mp4' },
    });
    const existing = {
      ...withAsset,
      visualObjects: {
        ...withAsset.visualObjects,
        'media-controller-clip-video': {
          id: 'media-controller-clip-video',
          kind: 'null' as const,
          transform: {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotationDeg: 0,
            opacity: 1,
            crop: { left: 0, top: 0, right: 0, bottom: 0 },
          },
        },
      },
    };
    expect(
      buildMediaPlacementDocument({
        baseProject: existing,
        asset: { id: 'asset-video', kind: 'video', displayName: 'Video' },
        clipId: 'clip-video',
        planned: {
          compositionId: 'root',
          trackId: 'track-1',
          clip: {
            id: 'clip-video',
            kind: 'video',
            assetId: 'asset-video',
            startUs: 0,
            durationUs: 1_000_000,
            sourceInUs: 0,
          },
        },
      }),
    ).toBe(existing);
  });
});

function baseProject(): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id: 'project',
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
        frameRate: { num: 30, den: 1 },
        pixelAspectRatio: { num: 1, den: 1 },
        background: '#000000',
        durationUs: 10_000_000,
        tracks: [
          {
            id: 'track-1',
            kind: 'video',
            name: 'Layer 1',
            order: 0,
            enabled: true,
            locked: false,
            clips: [],
          },
        ],
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments: {},
    pluginData: {},
  };
}
