import { describe, expect, it } from 'vitest';
import { normalizeUniversalTimeline } from '@joy-media/project-schema';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import {
  buildMediaPlacementDocument,
  buildTimelineElementDocument,
  withImportedAsset,
  withVisualTrackMirror,
} from './place-timeline-element.js';

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

  it('mirrors a timeline-only track so the universal timeline keeps the scene enabled', () => {
    const clip = {
      id: 'clip-scene',
      kind: 'video' as const,
      assetId: 'html-scene:joy.firstparty.title',
      startUs: 1_000_000,
      durationUs: 4_000_000,
      sourceInUs: 0,
    };
    const placed = buildTimelineElementDocument({
      baseProject: baseProject(),
      clipId: 'clip-scene',
      planned: { compositionId: 'root', trackId: 'track-2', clip },
      elementKind: 'html-scene',
      source: { kind: 'object', id: 'scene-title' },
      visualObject: {
        id: 'scene-title',
        kind: 'html-scene',
        scenePackageId: 'joy.firstparty.title',
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
    });
    expect(normalizeUniversalTimeline(placed).diagnostics.map((item) => item.code)).toContain(
      'UNIVERSAL_TIMELINE_DANGLING_TRACK',
    );

    const mirrored = withVisualTrackMirror(placed, {
      compositionId: 'root',
      trackId: 'track-2',
      name: 'Scene',
      order: 1,
    });
    expect(mirrored.compositions.root!.tracks.map((track) => track.id)).toContain('track-2');
    const normalized = normalizeUniversalTimeline(mirrored);
    expect(normalized.diagnostics.map((item) => item.code)).not.toContain(
      'UNIVERSAL_TIMELINE_DANGLING_TRACK',
    );
    expect(normalized.items.find((item) => item.id === 'clip-scene')).toMatchObject({
      trackEnabled: true,
      startUs: 1_000_000,
      durationUs: 4_000_000,
    });
  });

  it('mirrors a new track once and leaves existing visual tracks unchanged', () => {
    const base = baseProject();
    const placement = { compositionId: 'root', trackId: 'track-2', name: 'Scene', order: 1 };
    const once = withVisualTrackMirror(base, placement);
    const twice = withVisualTrackMirror(once, placement);
    expect(twice.compositions.root!.tracks.map((track) => track.id)).toEqual([
      ...base.compositions.root!.tracks.map((track) => track.id),
      'track-2',
    ]);
    expect(withVisualTrackMirror(base, { ...placement, trackId: 'track-1', order: 0 })).toBe(base);
    expect(withVisualTrackMirror(base, { ...placement, compositionId: 'missing' })).toBe(base);
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
