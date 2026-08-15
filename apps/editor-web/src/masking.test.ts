import { describe, expect, it } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import {
  defaultMaskSettings,
  maskJobPayload,
  readMaskSettings,
  readVideoMaskSourceMap,
  writeMaskSettings,
  writeVideoMaskSource,
} from './masking.js';

describe('durable masking state', () => {
  it('normalizes image defaults into the provider-neutral Worker contract', () => {
    const settings = readMaskSettings(project(), 'image-1', 'image');
    expect(settings).toMatchObject({
      schemaVersion: 1,
      provider: 'auto',
      selection: { mode: 'subject' },
      edge: { featherPx: 2, decontaminate: true },
      output: 'matte',
    });
    expect(maskJobPayload(settings)).not.toHaveProperty('preview');
    expect(maskJobPayload(settings)).not.toHaveProperty('lastJob');
  });

  it('round-trips normalized points and a tracked video result source', () => {
    const settings = {
      ...defaultMaskSettings('video'),
      provider: 'sam2-grounded' as const,
      selection: {
        mode: 'points' as const,
        points: [
          { x: 0.25, y: 0.4, label: 'foreground' as const },
          { x: 0.8, y: 0.2, label: 'background' as const },
        ],
      },
    };
    const persisted = writeMaskSettings(project(), 'clip-1', settings);
    expect(readMaskSettings(persisted, 'clip-1', 'video')).toMatchObject(settings);
    expect(maskJobPayload(settings, 'cutout', 2_500_000).selection.timeUs).toBe(2_500_000);
    const linked = writeVideoMaskSource(persisted, 'clip-1', 'mask-video-1');
    expect(readVideoMaskSourceMap(linked)).toEqual({ 'clip-1': 'mask-video-1' });
    expect(readVideoMaskSourceMap(writeVideoMaskSource(linked, 'clip-1', undefined))).toEqual({});
  });
});

function project(): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id: 'p',
    title: 'Mask test',
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
