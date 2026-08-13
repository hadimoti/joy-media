import { describe, expect, it } from 'vitest';
import { canonicalBindingKey, type JoyProjectV1 } from '@joy-media/project-schema';
import {
  hasRenderableExportMedia,
  missingColorLutExportDependencies,
} from './export-media-readiness.js';

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
