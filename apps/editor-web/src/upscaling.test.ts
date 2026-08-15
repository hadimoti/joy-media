import { describe, expect, it } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import {
  defaultUpscaleSettings,
  readUpscaleSettings,
  upscaleJobPayload,
  writeUpscaleSettings,
} from './upscaling.js';

describe('durable upscaling state', () => {
  it('uses safe local-first defaults and emits a provider-neutral image request', () => {
    const settings = defaultUpscaleSettings();
    expect(upscaleJobPayload(settings, { kind: 'image' })).toEqual({
      schemaVersion: 1,
      mediaKind: 'image',
      preset: 'quality',
      output: { mode: 'scale', scale: 2, imageFormat: 'png' },
      processing: {
        memoryMode: 'auto',
        restorationStrength: 0.75,
        denoiseStrength: 0.25,
      },
    });
  });

  it('round-trips video settings and constrains the request range to the clip', () => {
    const settings = {
      ...defaultUpscaleSettings(),
      preset: 'fast' as const,
      scale: 4 as const,
      keepAudio: false,
    };
    const persisted = writeUpscaleSettings(project(), 'clip-1', settings);
    expect(readUpscaleSettings(persisted, 'clip-1')).toMatchObject(settings);
    expect(
      upscaleJobPayload(settings, {
        kind: 'video',
        durationUs: 1_000_000,
        playheadUs: 900_000,
      }),
    ).toMatchObject({
      mediaKind: 'video',
      output: { mode: 'scale', scale: 4, videoProfile: 'h264-aac-mp4' },
      processing: { keepAudio: false },
      range: { startUs: 900_000, endUs: 1_000_000, purpose: 'full' },
    });
  });
});

function project(): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id: 'p',
    title: 'Upscale test',
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
        durationUs: 1_000_000,
        background: '#000000',
        tracks: [],
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
