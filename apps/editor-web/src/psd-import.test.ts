import { describe, expect, it } from 'vitest';
import {
  PsdImportError,
  buildPsdDocumentSnapshot,
  parsePsdFile,
  registerPsdAssets,
  type PsdParseResult,
} from './psd-import.js';
import type { BrowserAssetRegistration } from './control-plane-client.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';

const parsed: PsdParseResult = {
  width: 1200,
  height: 800,
  bytes: 10,
  sha256: 'a'.repeat(64),
  parseTimeMs: 1,
  sourceName: 'نمونه.psd',
  sourceMimeType: 'image/vnd.adobe.photoshop',
  warnings: [
    {
      code: 'smart-object-unsupported',
      layerId: 'smart',
      message: 'unsupported',
    },
  ],
  layers: [
    {
      id: 'hero',
      name: 'قهرمان',
      bounds: { x: 10, y: 20, width: 300, height: 200 },
      opacity: 1,
      visible: true,
      type: 'raster',
    },
    {
      id: 'headline',
      name: 'عنوان فارسی',
      bounds: { x: 40, y: 60, width: 500, height: 100 },
      opacity: 0.8,
      visible: true,
      type: 'text',
      text: 'سلام JOY',
    },
  ],
};

describe('bounded PSD import', () => {
  it('maps image and Persian text layers into a validated document snapshot', () => {
    const project = buildPsdDocumentSnapshot(
      INITIAL_EDITOR_PROJECT,
      parsed,
      { hero: 'image-object', headline: 'text-object' },
      { sourceAssetId: 'psd-source', layerAssetIds: { hero: 'psd-hero' } },
      'seed-1',
    );
    expect(project.visualObjects['psd-seed-1-hero']).toMatchObject({
      kind: 'image',
      assetId: 'psd-hero',
    });
    expect(project.visualObjects['psd-seed-1-headline']).toMatchObject({
      kind: 'text',
      text: 'سلام JOY',
    });
    expect(project.assets['psd-source']).toMatchObject({ kind: 'image', displayName: 'نمونه.psd' });
  });

  it('registers the source and selected raster with real content hashes', async () => {
    const registrations: BrowserAssetRegistration[] = [];
    const cached: string[] = [];
    const file = new Blob(['source'], { type: 'image/vnd.adobe.photoshop' });
    const raster = new Blob(['raster'], { type: 'image/png' });
    const result = await registerPsdAssets({
      client: {
        registerAsset: async (_projectId, registration) => {
          registrations.push(registration);
          return registration as never;
        },
      },
      projectId: 'project-1',
      cache: {
        put: async (descriptor) => {
          cached.push(`${descriptor.assetId}:${descriptor.sha256}:${descriptor.bytes}`);
        },
      },
      file,
      parsed: { ...parsed, layers: [{ ...parsed.layers[0]!, rasterBlob: raster }] },
      selectedLayerIds: ['hero'],
    });
    expect(result.sourceAssetId).toMatch(/^psd-/);
    expect(result.layerAssetIds.hero).toMatch(/^psd-/);
    expect(registrations).toHaveLength(2);
    expect(registrations.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
    expect(cached.every((entry) => entry.split(':')[1]?.length === 64)).toBe(true);
  });

  it('rejects malformed and oversized PSD inputs with typed user-safe errors', async () => {
    await expect(parsePsdFile(new Blob(['not-a-psd']), { maxBytes: 2 })).rejects.toMatchObject({
      code: 'too-large',
    } satisfies Partial<PsdImportError>);
    await expect(parsePsdFile(new Blob(['not-a-psd']))).rejects.toMatchObject({
      code: 'invalid-psd',
    } satisfies Partial<PsdImportError>);
  });
});
