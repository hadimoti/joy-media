import { describe, expect, it } from 'vitest';
import { canonicalBindingKey, type JoyProjectV1 } from '@joy-media/project-schema';
import {
  activePreparedExportClipAt,
  hasRenderableExportMedia,
  isExportDurationTimelineClip,
  isExportVisualTimelineClip,
  missingColorLutExportDependencies,
} from './export-media-readiness.js';

describe('isExportVisualTimelineClip', () => {
  it.each([
    ['video media', 'video' as const, 'video' as const],
    ['still or animated image media', 'video' as const, 'image' as const],
    ['legacy unresolved media', 'overlay' as const, undefined],
    ['3D render media', 'scene3d' as const, 'image' as const],
  ])('accepts %s', (_label, elementKind, assetKind) => {
    expect(isExportVisualTimelineClip(elementKind, assetKind)).toBe(true);
  });

  it.each([
    ['audio element', 'audio' as const, 'audio' as const],
    ['caption controller', 'caption' as const, undefined],
    ['filter controller', 'filter' as const, undefined],
    ['HTML scene render layer', 'html-scene' as const, undefined],
    ['LUT asset', 'video' as const, 'lut' as const],
    ['other asset', 'video' as const, 'other' as const],
  ])('rejects %s', (_label, elementKind, assetKind) => {
    expect(isExportVisualTimelineClip(elementKind, assetKind)).toBe(false);
  });
});

describe('isExportDurationTimelineClip', () => {
  it.each([
    ['video media', 'video' as const, 'video' as const],
    ['animated image media', 'video' as const, 'image' as const],
    ['semantic audio element', 'audio' as const, 'audio' as const],
    ['legacy audio asset', 'video' as const, 'audio' as const],
    ['3D render media', 'scene3d' as const, 'image' as const],
    ['HTML scene render layer', 'html-scene' as const, undefined],
  ])('counts %s', (_label, elementKind, assetKind) => {
    expect(isExportDurationTimelineClip(elementKind, assetKind)).toBe(true);
  });

  it.each([
    ['caption controller', 'caption' as const, undefined],
    ['motion controller', 'motion' as const, undefined],
    ['filter controller', 'filter' as const, undefined],
    ['adjustment controller', 'adjust' as const, undefined],
    ['LUT asset', 'video' as const, 'lut' as const],
  ])('does not let %s pad the program', (_label, elementKind, assetKind) => {
    expect(isExportDurationTimelineClip(elementKind, assetKind)).toBe(false);
  });
});

describe('hasRenderableExportMedia', () => {
  it.each([
    ['detached video', { video: {} }],
    ['static image', { stillFrame: {} }],
    ['animated image', { animatedFrameSource: {} }],
    ['video with decoded image fields', { video: {}, animatedFrameSource: {} }],
  ])('accepts %s media', (_label, media) => {
    expect(hasRenderableExportMedia(media)).toBe(true);
  });

  it.each([
    ['audio-only', { audio: {} }],
    ['unprepared', {}],
    ['explicitly empty', { video: undefined, stillFrame: undefined }],
  ])('rejects %s media', (_label, media) => {
    expect(hasRenderableExportMedia(media)).toBe(false);
  });
});

describe('activePreparedExportClipAt', () => {
  const clips = [
    { id: 'animated-image', startUs: 0, durationUs: 1_000_000, layer: 1 },
    { id: 'base-video', startUs: 0, durationUs: 1_000_000, layer: 0 },
    { id: 'later-image', startUs: 1_000_000, durationUs: 1_000_000, layer: 0 },
  ] as const;

  it('selects prepared animated-image media instead of requiring an HTML video', () => {
    const media = new Map([['animated-image', { animatedFrameSource: {} }]]);
    expect(activePreparedExportClipAt(clips, 250_000, media)?.id).toBe('animated-image');
  });

  it('ignores unprepared and inactive clips while honoring stable layer priority', () => {
    const media = new Map([
      ['animated-image', { stillFrame: {} }],
      ['base-video', { video: {} }],
      ['later-image', { stillFrame: {} }],
    ]);
    expect(activePreparedExportClipAt(clips, 250_000, media, (clip) => clip.layer)?.id).toBe(
      'base-video',
    );
    expect(activePreparedExportClipAt(clips, 1_000_000, media)?.id).toBe('later-image');
  });
});

describe('missingColorLutExportDependencies', () => {
  const base = (): JoyProjectV1 =>
    ({
      schemaVersion: 1,
      id: 'project',
      title: 'project',
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z',
      rootCompositionId: 'root',
      settings: { defaultLocale: 'en' },
      compositions: {},
      assets: {},
      variables: {},
      markers: [],
      visualObjects: {},
      captionDocuments: {},
      pluginData: {},
    }) as JoyProjectV1;

  it('blocks export for a missing static LUT or unresolved hold key', () => {
    const binding = {
      ownerKind: 'color-output' as const,
      ownerId: 'output',
      propertyId: 'lut.reference',
      timeDomain: 'output' as const,
    };
    const project = {
      ...base(),
      colorGrade: {
        version: 2 as const,
        enabled: true,
        lut: { assetId: 'missing-static', sha256: 'a'.repeat(64), intensity: 1 },
      },
      propertyAnimations: {
        [canonicalBindingKey(binding)]: {
          binding,
          value: {
            kind: 'string' as const,
            keys: [{ timeUs: 0, value: `asset:missing-key:${'b'.repeat(64)}` }],
          },
        },
      },
    };
    expect(missingColorLutExportDependencies(project)).toEqual(['missing-key', 'missing-static']);
  });

  it('accepts a hash-matching private LUT asset', () => {
    const project = {
      ...base(),
      assets: {
        lut: {
          id: 'lut',
          kind: 'lut' as const,
          displayName: 'grade.cube',
          sha256: 'a'.repeat(64),
        },
      },
      colorGrade: {
        version: 2 as const,
        enabled: true,
        lut: { assetId: 'lut', sha256: 'a'.repeat(64), intensity: 1 },
      },
    };
    expect(missingColorLutExportDependencies(project)).toEqual([]);
  });
});
