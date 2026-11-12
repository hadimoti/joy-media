import { describe, expect, it, vi } from 'vitest';
import type { ColorGradeIR } from '@joy-media/render-ir';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { createProjectColorLutResolver } from './project-color-luts.js';

const cubeBytes = new TextEncoder().encode(
  'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1',
);

function projectWithLut(sha256: string): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id: 'project',
    title: 'project',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {},
    assets: {
      'lut-1': {
        id: 'lut-1',
        kind: 'lut',
        displayName: 'small.cube',
        sha256,
      },
    },
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments: {},
    pluginData: {},
    colorGrade: {
      version: 2,
      enabled: true,
      lut: { assetId: 'lut-1', sha256, intensity: 1 },
    },
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('project color LUT resolver', () => {
  it('reads and parses a small .cube asset through the project asset channel', async () => {
    const sha256 = await sha256Hex(cubeBytes);
    const loadProjectAssetBlob = vi.fn(async (assetId: string) => {
      expect(assetId).toBe('lut-1');
      return new Blob([cubeBytes], { type: 'text/plain' });
    });
    const resolver = createProjectColorLutResolver({
      project: projectWithLut(sha256),
      loadProjectAssetBlob,
    });
    const grade = {
      version: 2,
      enabled: true,
      lift: 0,
      gamma: 1,
      gain: 1,
      saturation: 1,
      lut: { assetId: 'lut-1', sha256, intensity: 1 },
    } satisfies ColorGradeIR;

    expect(resolver.resolveColorLut(grade)).toBeUndefined();
    await resolver.prepareProjectColorLuts();

    expect(loadProjectAssetBlob).toHaveBeenCalledOnce();
    expect(resolver.resolveColorLut(grade)).toMatchObject({ size: 2 });
  });

  it('warns and leaves the remaining grade usable when a LUT cannot be parsed', async () => {
    const malformed = new TextEncoder().encode('LUT_3D_SIZE 2\n0 0 0');
    const sha256 = await sha256Hex(malformed);
    const onWarning = vi.fn();
    const resolver = createProjectColorLutResolver({
      project: projectWithLut(sha256),
      loadProjectAssetBlob: async () => new Blob([malformed], { type: 'text/plain' }),
      onWarning,
    });
    const grade: ColorGradeIR = {
      version: 2,
      enabled: true,
      lift: 0.1,
      gamma: 1,
      gain: 1,
      saturation: 1,
      lut: { assetId: 'lut-1', sha256, intensity: 1 },
    };

    await resolver.prepareProjectColorLuts();

    expect(resolver.resolveColorLut(grade)).toBeUndefined();
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('The rest of the color grade is still applied without it.'),
    );
  });

  it('warns when a custom LUT reference is incomplete', () => {
    const onWarning = vi.fn();
    const resolver = createProjectColorLutResolver({
      project: projectWithLut('a'.repeat(64)),
      loadProjectAssetBlob: async () => new Blob([cubeBytes]),
      onWarning,
    });
    const grade: ColorGradeIR = {
      version: 2,
      enabled: true,
      lift: 0.1,
      gamma: 1,
      gain: 1,
      saturation: 1,
      lut: { assetId: 'lut-1', intensity: 1 },
    };

    expect(resolver.resolveColorLut(grade)).toBeUndefined();
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('project asset reference is incomplete'),
    );
  });
});
