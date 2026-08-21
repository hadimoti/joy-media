import { describe, expect, it } from 'vitest';
import type {
  JoyProjectV1,
  SpikeProject,
  VisualObjectTransformV1,
} from '@joy-media/project-schema';
import {
  deliveryPromiseFromManifest,
  preflightDelivery,
  type DeliveryPromiseV1,
  type PreflightInputV1,
} from './index.js';

const SECOND = 1_000_000;
const CAPTION_BURN_IN_KEY = 'joy.captions.burnIn';

describe('delivery preflight', () => {
  it('passes a complete project with ready assets, captions, audio, workflow input, and approval', () => {
    const input = preflightInput();

    const report = preflightDelivery(input);

    expect(report.findings.filter((finding) => finding.status === 'fail')).toEqual([]);
    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'asset-availability',
        'clip-ranges',
        'caption-promise',
        'audio-presence',
        'workflow-inputs',
        'approval',
      ]),
    );
    expect(JSON.stringify(report)).not.toMatch(/[A-Za-z]:[\\/]|file:|https?:\/\//);
  });

  it('finds missing assets, invalid ranges, overlaps, bindings, captions, workflow inputs, and approval', () => {
    const base = preflightInput();
    const bundle = {
      ...base.bundle,
      visualProject: visualProject({
        captionDocument: false,
        captionPromise: false,
        audio: false,
        objectAssetId: 'missing-image',
        effectId: 'noise',
      }),
      timelineProject: timelineProject({ invalidRange: true, overlap: true }),
      assets: {
        'video-a': {
          id: 'video-a',
          kind: 'video',
          opaqueRef: 'asset:video-a',
          availability: 'missing',
        },
      },
    } satisfies PreflightInputV1['bundle'];

    const report = preflightDelivery({
      ...base,
      bundle,
      promise: {
        ...base.promise,
        video: { ...base.promise.video, width: 1920, height: 1080 },
        audio: { ...base.promise.audio, required: true },
        captions: { mode: 'none' },
        deterministic: { requireDeterministicEffects: true, allowedEffectIds: ['brightness'] },
        workflow: { requiredInputIds: ['script', 'voice'], resolvedInputIds: ['script'] },
        approval: { required: true, approved: false },
      },
    });

    expect(failCodes(report)).toEqual(
      expect.arrayContaining([
        'asset-availability',
        'clip-ranges',
        'clip-overlap',
        'asset-binding',
        'caption-binding',
        'caption-promise',
        'audio-presence',
        'dimensions',
        'workflow-inputs',
        'approval',
        'deterministic-effects',
      ]),
    );
  });

  it('rejects invalid deterministic-effect policy before delivery can be promised', () => {
    const base = preflightInput();

    const report = preflightDelivery({
      ...base,
      promise: {
        ...base.promise,
        deterministic: { requireDeterministicEffects: true, allowedEffectIds: [] },
      },
    });

    expect(failCodes(report)).toContain('deterministic-policy');
  });
});

function failCodes(report: ReturnType<typeof preflightDelivery>): readonly string[] {
  return report.findings
    .filter((finding) => finding.status === 'fail')
    .map((finding) => finding.code);
}

function preflightInput(): PreflightInputV1 {
  const visual = visualProject();
  const timeline = timelineProject();
  const bundle: PreflightInputV1['bundle'] = {
    version: 1,
    timelineProject: timeline,
    visualProject: visual,
    compositionId: visual.rootCompositionId,
    outputPreset: 'youtube-1080',
    seed: 'quality-test',
    assets: {
      'video-a': {
        id: 'video-a',
        kind: 'video',
        opaqueRef: 'asset:video-a',
        availability: 'ready',
      },
      'image-a': {
        id: 'image-a',
        kind: 'image',
        opaqueRef: 'asset:image-a',
        availability: 'ready',
      },
      'html-scene:joy.firstparty.title': {
        id: 'html-scene:joy.firstparty.title',
        kind: 'html-scene',
        opaqueRef: 'html-scene:joy.firstparty.title',
        availability: 'ready',
      },
    },
  };
  const promise: DeliveryPromiseV1 = {
    ...deliveryPromiseFromManifest({
      projectId: visual.id,
      revision: 2,
      width: 64,
      height: 36,
      frameRate: 30,
      durationUs: 2 * SECOND,
      preset: 'youtube-1080',
    }),
    captions: { mode: 'burned-in', required: true },
    deterministic: { requireDeterministicEffects: true, allowedEffectIds: ['brightness'] },
    workflow: { requiredInputIds: ['script'], resolvedInputIds: ['script'] },
    approval: { required: true, approved: true, approvalRef: 'approval-1' },
  };
  return { bundle, promise };
}

function timelineProject(
  options: { readonly invalidRange?: boolean; readonly overlap?: boolean } = {},
): SpikeProject {
  return {
    schemaVersion: 0,
    id: 'timeline',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 64,
        height: 36,
        frameRate: { num: 30, den: 1 },
        durationUs: 2 * SECOND,
        tracks: [
          {
            id: 'video-track',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                id: 'clip-a',
                kind: 'video',
                startUs: 0,
                durationUs: options.invalidRange ? 0 : SECOND,
                assetId: 'video-a',
                sourceInUs: 0,
              },
              {
                id: 'clip-b',
                kind: 'video',
                startUs: options.overlap ? 500_000 : SECOND,
                durationUs: SECOND,
                assetId: 'video-a',
                sourceInUs: SECOND,
              },
              ...(options.overlap
                ? [
                    {
                      id: 'clip-c',
                      kind: 'video' as const,
                      startUs: 750_000,
                      durationUs: 100_000,
                      assetId: 'video-a',
                      sourceInUs: SECOND,
                    },
                  ]
                : []),
            ],
          },
        ],
      },
    },
  };
}

function visualProject(
  options: {
    readonly captionDocument?: boolean;
    readonly captionPromise?: boolean;
    readonly audio?: boolean;
    readonly objectAssetId?: string;
    readonly effectId?: string;
  } = {},
): JoyProjectV1 {
  const includeCaptionDocument = options.captionDocument !== false;
  const includeCaptionPromise = options.captionPromise !== false;
  const includeAudio = options.audio !== false;
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
        width: 64,
        height: 36,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 2 * SECOND,
        background: '#000000',
        tracks: [
          {
            id: 'captions',
            kind: 'caption',
            name: 'Captions',
            order: 0,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'caption-1',
                kind: 'caption',
                startUs: 0,
                durationUs: SECOND,
                captionDocumentId: 'doc-1',
              },
            ],
          },
          {
            id: 'video',
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
                durationUs: SECOND,
                assetId: 'video-a',
                sourceInUs: 0,
              },
            ],
          },
        ],
      },
    },
    assets: {
      'video-a': { id: 'video-a', kind: 'video', displayName: 'Video' },
      'image-a': { id: 'image-a', kind: 'image', displayName: 'Sticker' },
    },
    variables: {},
    markers: [],
    visualObjects: {
      sticker: {
        id: 'sticker',
        kind: 'image',
        assetId: options.objectAssetId ?? 'image-a',
        transform: transform(),
        effects: [
          {
            id: 'effect-1',
            effectId: options.effectId ?? 'brightness',
            enabled: true,
            params: { amount: 0.1 },
          },
        ],
      },
      scene: {
        id: 'scene',
        kind: 'html-scene',
        scenePackageId: 'joy.firstparty.title',
        transform: transform(),
      },
    },
    captionDocuments: includeCaptionDocument
      ? {
          'doc-1': {
            id: 'doc-1',
            language: 'en',
            direction: 'ltr',
            speakers: [],
            words: { w1: { id: 'w1', text: 'Hello', startUs: 0, endUs: SECOND } },
            segments: [{ id: 's1', startUs: 0, endUs: SECOND, wordIds: ['w1'] }],
          },
        }
      : {},
    pluginData: includeCaptionPromise ? { [CAPTION_BURN_IN_KEY]: true } : {},
    ...(includeAudio
      ? {
          audio: {
            clips: { 'clip-a': { gain: 1, pan: 0, mute: false, solo: false } },
            buses: [],
            effects: [],
          },
        }
      : {}),
  };
}

function transform(): VisualObjectTransformV1 {
  return {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  };
}
