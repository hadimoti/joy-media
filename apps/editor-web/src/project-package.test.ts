import { describe, expect, it } from 'vitest';
import { EditorSession } from './editor-session.js';
import { createBlankProjectDocuments } from './project-factory.js';
import { upsertCatalogProject, type ProjectCatalogEntry } from './project-catalog.js';
import {
  createProjectPackage,
  importProjectPackage,
  parseProjectPackage,
  serializeProjectPackage,
} from './project-package.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function createEntry(storage: ReturnType<typeof memoryStorage>, id = 'source-project') {
  const now = '2026-09-05T00:00:00.000Z';
  const seeds = createBlankProjectDocuments(id, 'Source project', now);
  const session = new EditorSession(storage, seeds.timeline, seeds.visual);
  session.replaceVisualProject({
    ...session.visualProject,
    assets: {
      'asset-original': {
        id: 'asset-original',
        kind: 'image',
        displayName: 'Poster.png',
        sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
        bytes: 1,
        descriptor: { mimeType: 'image/png', width: 1, height: 1 },
      },
    },
  });
  const entry: ProjectCatalogEntry = {
    id,
    title: 'Source project',
    createdAt: now,
    updatedAt: now,
    timelineProjectId: id,
    visualProjectId: id,
  };
  upsertCatalogProject(storage, entry);
  return entry;
}

describe('portable project packages', () => {
  it('embeds verified originals and round-trips the editable documents', async () => {
    const storage = memoryStorage();
    const entry = createEntry(storage);
    const pkg = await createProjectPackage(entry, storage, {
      assetBlobLoader: async () => new Blob(['a'], { type: 'image/png' }),
      now: () => '2026-09-05T01:00:00.000Z',
    });
    expect(pkg.media[0]).toMatchObject({ status: 'embedded', dataBase64: 'YQ==' });
    expect(parseProjectPackage(JSON.parse(serializeProjectPackage(pkg))).source.id).toBe(
      'source-project',
    );

    const imported = await importProjectPackage(storage, pkg, {
      createId: () => 'imported-project',
      assetWriter: async ({ assetId, blob }) => {
        expect(assetId).toMatch(/^asset-/);
        expect(await blob.text()).toBe('a');
      },
      now: () => '2026-09-05T02:00:00.000Z',
    });
    expect(imported.entry.id).toBe('imported-project');
    expect(imported.missingAssetIds).toEqual([]);
    expect(imported.assetIdMap['asset-original']).not.toBe('asset-original');
  });

  it('reports unavailable media instead of pretending the package is portable', async () => {
    const storage = memoryStorage();
    const entry = createEntry(storage);
    const pkg = await createProjectPackage(entry, storage);
    expect(pkg.media[0]).toMatchObject({ status: 'missing', missingReason: 'unavailable' });
    const imported = await importProjectPackage(storage, pkg, {
      createId: () => 'metadata-only-project',
      now: () => '2026-09-05T03:00:00.000Z',
    });
    expect(imported.missingAssetIds).toHaveLength(1);
  });

  it('handles collisions explicitly and rejects malformed packages', async () => {
    const storage = memoryStorage();
    const entry = createEntry(storage);
    const pkg = await createProjectPackage(entry, storage);
    await expect(importProjectPackage(storage, pkg, { collision: 'reject' })).rejects.toThrow(
      'already exists',
    );
    expect(() => parseProjectPackage({ format: 'joy-media-project', schemaVersion: 99 })).toThrow(
      'Unsupported',
    );
  });
});
