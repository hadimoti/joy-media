import { describe, expect, it } from 'vitest';
import type {
  JoyProjectV1,
  SpikeProject,
  VisualObjectTransformV1,
} from '@joy-media/project-schema';
import {
  CAPTION_BURN_IN_KEY,
  createRenderBundle,
  planRenderFrame,
  type OpaqueAssetDescriptor,
} from './index.js';

const SECOND = 1_000_000;

describe('planRenderFrame', () => {
  it('plans video, still, sticker, html scene, caption, effect, audio, and output preset without local media refs', () => {
    const frameTimeUs = SECOND + 250_000;
    const plan = planRenderFrame({
      bundle: createRenderBundle({
        timelineProject: timelineProject(),
        visualProject: visualProject(),
        outputPreset: 'reels-1080',
        seed: 'seed-1',
      }),
      timeUs: frameTimeUs,
      imageSizesByObjectId: { sticker: { width: 320, height: 200 } },
    });

    expect(plan.outputPreset).toBe('reels-1080');
    expect(plan.seed).toBe('seed-1');
    expect(
      plan.frame.nodes.some((node) => node.kind === 'video-frame' && node.id === 'sticker'),
    ).toBe(true);
    expect(
      plan.frame.nodes.some(
        (node) =>
          node.id === 'title' &&
          node.kind === 'text' &&
          'effects' in node &&
          node.effects?.[0]?.kind === 'noise',
      ),
    ).toBe(true);
    expect(plan.captureRequirements.map((requirement) => requirement.kind)).toEqual(
      expect.arrayContaining(['video-frame', 'still-bitmap', 'html-scene', 'caption-burn-in']),
    );
    expect(plan.captureRequirements).toContainEqual({
      id: 'html-scene:scene',
      kind: 'html-scene',
      objectId: 'scene',
      assetId: 'html-scene:joy.firstparty.title',
      sourceTimeUs: frameTimeUs,
    });
    expect(plan.requiredAssets.map((requirement) => requirement.assetId)).toEqual(
      expect.arrayContaining(['video-a', 'image-a', 'html-scene:joy.firstparty.title']),
    );
    expect(plan.videoSamples).toEqual([
      { clipId: 'clip-a', assetId: 'video-a', sourceTimeUs: 6_250_000, role: 'primary' },
    ]);
    expect(plan.audioSamples).toEqual([
      { clipId: 'clip-a', assetId: 'video-a', sourceTimeUs: 6_250_000, gain: 0.75, pan: -0.2 },
    ]);
    expect(plan.findings.find((finding) => finding.code === 'caption-burn-in')).toBeDefined();
    expect(JSON.stringify(plan)).not.toMatch(/[A-Za-z]:[\\/]|file:|\/tmp\//);
  });

  it('plans transition dual inputs and honors playback rate plus freeze source samples', () => {
    const plan = planRenderFrame({
      bundle: createRenderBundle({
        timelineProject: timelineProject(),
        visualProject: visualProject({ transition: true }),
        seed: 'seed-transition',
      }),
      timeUs: 1_750_000,
    });

    expect(plan.videoSamples).toEqual([
      { clipId: 'clip-a', assetId: 'video-a', sourceTimeUs: 6_750_000, role: 'primary' },
      { clipId: 'clip-a', assetId: 'video-a', sourceTimeUs: 6_750_000, role: 'transition-left' },
      { clipId: 'clip-b', assetId: 'video-b', sourceTimeUs: 10_000_000, role: 'transition-right' },
    ]);
    expect(plan.frame.nodes.some((node) => node.kind === 'transition')).toBe(true);
  });

  it('reports missing media descriptors instead of inventing fixture success', () => {
    const descriptors = createRenderBundle({
      timelineProject: timelineProject(),
      visualProject: visualProject(),
      seed: 'missing',
    }).assets;
    const { ['video-a']: _removed, ...withoutVideo } = descriptors;
    const plan = planRenderFrame({
      bundle: createRenderBundle({
        timelineProject: timelineProject(),
        visualProject: visualProject(),
        assets: withoutVideo,
        seed: 'missing',
      }),
      timeUs: 500_000,
    });

    expect(plan.findings).toContainEqual(
      expect.objectContaining({ code: 'missing-media', severity: 'error', refId: 'video-a' }),
    );
  });

  it('rejects local filesystem paths in render bundles', () => {
    const assets: Record<string, OpaqueAssetDescriptor> = {
      'video-a': {
        id: 'video-a',
        kind: 'video',
        opaqueRef: 'C:\\media\\clip.mp4',
      },
    };
    expect(() =>
      createRenderBundle({
        timelineProject: timelineProject(),
        visualProject: visualProject(),
        assets,
        seed: 'path',
      }),
    ).toThrow(/opaque ref/);
  });
});

function timelineProject(): SpikeProject {
  return {
    schemaVersion: 0,
    id: 'timeline',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 1080,
        height: 1920,
        frameRate: { num: 30, den: 1 },
        durationUs: 4 * SECOND,
        tracks: [
          {
            id: 'track-1',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-a',
                startUs: 0,
                durationUs: 2 * SECOND,
                assetId: 'video-a',
                sourceInUs: 5 * SECOND,
              },
              {
                kind: 'video',
                id: 'clip-b',
                startUs: 2 * SECOND,
                durationUs: 2 * SECOND,
                assetId: 'video-b',
                sourceInUs: 10 * SECOND,
                playbackRate: 0,
              },
            ],
          },
        ],
      },
    },
  };
}

function visualProject(options: { readonly transition?: boolean } = {}): JoyProjectV1 {
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
        durationUs: 4 * SECOND,
        background: '#000000',
        tracks: [
          {
            id: 'caption-track',
            kind: 'caption',
            name: 'Captions',
            order: 0,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'caption-1',
                kind: 'caption',
                startUs: SECOND,
                durationUs: SECOND,
                captionDocumentId: 'doc-1',
              },
            ],
          },
          {
            id: 'video-track',
            kind: 'video',
            name: 'Video',
            order: 1,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'clip-a',
                kind: 'video',
                startUs: 0,
                durationUs: 2 * SECOND,
                assetId: 'video-a',
                sourceInUs: 5 * SECOND,
              },
              {
                id: 'clip-b',
                kind: 'video',
                startUs: 2 * SECOND,
                durationUs: 2 * SECOND,
                assetId: 'video-b',
                sourceInUs: 10 * SECOND,
              },
            ],
          },
        ],
      },
    },
    assets: {
      'video-a': { id: 'video-a', kind: 'video', displayName: 'Video A' },
      'video-b': { id: 'video-b', kind: 'video', displayName: 'Video B' },
      'image-a': { id: 'image-a', kind: 'image', displayName: 'Image A' },
    },
    variables: {},
    markers: [],
    visualObjects: {
      title: {
        id: 'title',
        kind: 'text',
        text: 'Hello',
        transform: transform(10, 20),
        effects: [
          { id: 'effect-noise', effectId: 'noise', enabled: true, params: { amount: 0.1 } },
        ],
      },
      sticker: {
        id: 'sticker',
        kind: 'image',
        assetId: 'image-a',
        transform: transform(100, 200),
      },
      scene: {
        id: 'scene',
        kind: 'html-scene',
        scenePackageId: 'joy.firstparty.title',
        transform: transform(0, 0),
      },
    },
    captionDocuments: {
      'doc-1': {
        id: 'doc-1',
        language: 'en',
        direction: 'ltr',
        speakers: [],
        words: { w1: { id: 'w1', text: 'Caption', startUs: 0, endUs: SECOND } },
        segments: [{ id: 's1', startUs: 0, endUs: SECOND, wordIds: ['w1'] }],
      },
    },
    pluginData: { [CAPTION_BURN_IN_KEY]: true },
    audio: {
      clips: { 'clip-a': { gain: 0.75, pan: -0.2, mute: false, solo: false } },
      buses: [],
      effects: [],
    },
    ...(options.transition
      ? {
          transitions: [
            {
              id: 'transition-1',
              trackId: 'video-track',
              type: 'dissolve',
              leftClipId: 'clip-a',
              rightClipId: 'clip-b',
              durationUs: 500_000,
              params: {},
            },
          ],
        }
      : {}),
  };
}

function transform(x: number, y: number): VisualObjectTransformV1 {
  return {
    x,
    y,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  };
}
