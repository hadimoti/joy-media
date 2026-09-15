import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  validateJoyProjectV1,
  validateSpikeProject,
  validateLookInstancesDocument,
} from '@joy-media/project-schema';
import { EditorSession } from './editor-session.js';
import {
  parseProjectPackage,
  importProjectPackage,
} from './project-package.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('demo-project.json fixture', () => {
  const fixturePath = fileURLToPath(new URL('../../../tests/desktop/fixtures/demo-project.json', import.meta.url));
  const rawText = readFileSync(fixturePath, 'utf8');
  const json = JSON.parse(rawText) as unknown;

  it('parses as a valid JOY project package via parseProjectPackage', () => {
    const pkg = parseProjectPackage(json);
    expect(pkg.format).toBe('joy-media-project');
    expect(pkg.schemaVersion).toBe(1);
    expect(pkg.app).toBe('JOY Studio');
    expect(pkg.source.id).toBe('demo-project');
    expect(pkg.media).toHaveLength(3);
  });

  it('validates the JoyProjectV1 visual document with zero diagnostics', () => {
    const pkg = parseProjectPackage(json);
    const diagnostics = validateJoyProjectV1(pkg.documents.visual);
    expect(diagnostics).toEqual([]);

    // Also validate when interpreted directly as a JoyProjectV1 document
    const directDiagnostics = validateJoyProjectV1(json);
    expect(directDiagnostics).toEqual([]);
  });

  it('validates the SpikeProject timeline document with zero diagnostics', () => {
    const pkg = parseProjectPackage(json);
    const diagnostics = validateSpikeProject(pkg.documents.timeline);
    expect(diagnostics).toEqual([]);
  });

  it('validates the LookInstancesDocument with zero diagnostics', () => {
    const pkg = parseProjectPackage(json);
    const diagnostics = validateLookInstancesDocument(pkg.documents.lookInstances);
    expect(diagnostics).toEqual([]);
  });

  it('contains video, audio, and visual/image tracks referencing test fixtures', () => {
    const pkg = parseProjectPackage(json);
    const composition = pkg.documents.visual.compositions.root;
    expect(composition).toBeDefined();

    const trackKinds = composition!.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      family: t.family,
    }));

    expect(trackKinds).toContainEqual({
      id: 'track-video',
      name: 'Video 1',
      kind: 'video',
      family: 'visual',
    });

    expect(trackKinds).toContainEqual({
      id: 'track-image',
      name: 'Image 1',
      kind: 'video',
      family: 'visual',
    });

    expect(trackKinds).toContainEqual({
      id: 'track-audio',
      name: 'Audio 1',
      kind: 'audio',
      family: 'audio',
    });

    expect(pkg.documents.visual.assets['asset-video']).toMatchObject({
      kind: 'video',
      displayName: 'video.mp4',
      sha256: 'f4879ec24ebac10f94e5e7273f146444d8b4fb26528c7fc1e22f82d1dfa0c0ee',
      bytes: 43912,
    });
    expect(pkg.documents.visual.assets['asset-image']).toMatchObject({
      kind: 'image',
      displayName: 'image.png',
      sha256: '8f24a572b2b05c02eee94666f40d87134c67abd637e2e0c2b74079566d75052b',
      bytes: 629,
    });
    expect(pkg.documents.visual.assets['asset-audio']).toMatchObject({
      kind: 'audio',
      displayName: 'audio.wav',
      sha256: '66708fb217f7944cc68e6000a1d07d73d7fd87a8ee6786660df36a5d3c0b45af',
      bytes: 288078,
    });
  });

  it('imports cleanly into EditorSession via importProjectPackage', async () => {
    const storage = memoryStorage();
    const pkg = parseProjectPackage(json);
    const writtenBlobs: Record<string, number> = {};

    const imported = await importProjectPackage(storage, pkg, {
      assetWriter: async ({ assetId, blob }) => {
        writtenBlobs[assetId] = blob.size;
      },
    });

    expect(imported.entry.id).toBe('demo-project');
    expect(imported.missingAssetIds).toEqual([]);
    expect(Object.keys(writtenBlobs)).toHaveLength(3);

    const session = new EditorSession(
      storage,
      pkg.documents.timeline,
      pkg.documents.visual,
    );
    expect(session.visualProject.id).toBe('demo-project');
    expect(session.timelineProject.id).toBe('demo-project');
    expect(session.visualProject.title).toBe('Demo Project');
    expect(session.timelineProject.compositions.root).toBeDefined();
  });
});
