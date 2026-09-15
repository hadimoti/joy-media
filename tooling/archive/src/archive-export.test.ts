import { describe, expect, it } from 'vitest';
import { exportOwnerArchive } from './archive-export.js';
import type {
  ArchiveMediaAsset,
  ArchiveProjectRecord,
  ProjectArchiveSource,
} from './archive-export.js';
import { decryptArchive } from './encryption.js';
import { verifyManifest } from './manifest.js';
import type { ArchiveBundle } from './archive-export.js';

function fakeSource(
  projectsByOwner: Record<string, readonly ArchiveProjectRecord[]>,
  mediaByProject: Record<string, readonly ArchiveMediaAsset[]> = {},
): ProjectArchiveSource {
  return {
    async listProjects(ownerId) {
      return projectsByOwner[ownerId] ?? [];
    },
    async listMediaAssets(projectId) {
      return mediaByProject[projectId] ?? [];
    },
  };
}

function decryptBundle(result: Awaited<ReturnType<typeof exportOwnerArchive>>): ArchiveBundle {
  const plaintext = decryptArchive(result.encrypted, Buffer.from(result.keyBase64, 'base64'));
  return JSON.parse(plaintext.toString('utf8')) as ArchiveBundle;
}

describe('exportOwnerArchive', () => {
  it('produces an empty-but-valid archive for an owner with no projects', async () => {
    const source = fakeSource({});
    const result = await exportOwnerArchive('user@example.com', source, () => 'T0');
    expect(result.manifest.entryCount).toBe(0);
    const bundle = decryptBundle(result);
    expect(bundle.entries).toEqual([]);
  });

  it('includes one entry per project document', async () => {
    const source = fakeSource({
      'user@example.com': [
        { id: 'proj-1', document: { title: 'A' } },
        { id: 'proj-2', document: { title: 'B' } },
      ],
    });
    const result = await exportOwnerArchive('user@example.com', source, () => 'T0');
    const bundle = decryptBundle(result);
    expect(bundle.entries.map((e) => e.name).sort()).toEqual([
      'projects/proj-1.json',
      'projects/proj-2.json',
    ]);
  });

  it('includes every media asset for every one of the owner’s projects', async () => {
    const source = fakeSource(
      { 'user@example.com': [{ id: 'proj-1', document: {} }] },
      { 'proj-1': [{ id: 'asset-1', displayName: 'clip.mp4', bytes: Buffer.from('abc') }] },
    );
    const result = await exportOwnerArchive('user@example.com', source, () => 'T0');
    const bundle = decryptBundle(result);
    expect(bundle.entries.map((e) => e.name)).toContain('media/proj-1/asset-1-clip.mp4');
  });

  it('sanitizes a display name that tries to escape the media/<projectId>/ namespace', async () => {
    const source = fakeSource(
      { 'user@example.com': [{ id: 'proj-1', document: {} }] },
      {
        'proj-1': [{ id: 'asset-1', displayName: '../../etc/passwd', bytes: Buffer.from('x') }],
      },
    );
    const result = await exportOwnerArchive('user@example.com', source, () => 'T0');
    const bundle = decryptBundle(result);
    const name = bundle.entries.find((e) => e.name.startsWith('media/'))!.name;
    expect(name.startsWith('media/proj-1/')).toBe(true);
    expect(name).not.toContain('..');
    expect(name).not.toContain('/etc/');
  });

  it('never leaks another owner’s projects', async () => {
    const source = fakeSource({
      'owner-a@example.com': [{ id: 'proj-a', document: {} }],
      'owner-b@example.com': [{ id: 'proj-b', document: {} }],
    });
    const result = await exportOwnerArchive('owner-a@example.com', source, () => 'T0');
    const bundle = decryptBundle(result);
    expect(bundle.entries.map((e) => e.name)).toEqual(['projects/proj-a.json']);
  });

  it('produces an archive whose manifest verifies against its own decrypted entries', async () => {
    const source = fakeSource(
      { 'user@example.com': [{ id: 'proj-1', document: { title: 'A' } }] },
      { 'proj-1': [{ id: 'asset-1', displayName: 'clip.mp4', bytes: Buffer.from('abc') }] },
    );
    const result = await exportOwnerArchive('user@example.com', source, () => 'T0');
    const bundle = decryptBundle(result);
    const entries = bundle.entries.map((e) => ({
      name: e.name,
      bytes: Buffer.from(e.bytesBase64, 'base64'),
    }));
    expect(verifyManifest(entries, bundle.manifest)).toEqual({ ok: true });
    expect(verifyManifest(entries, result.manifest)).toEqual({ ok: true });
  });

  it('returns a fresh, unique key for every export', async () => {
    const source = fakeSource({ 'user@example.com': [{ id: 'proj-1', document: {} }] });
    const a = await exportOwnerArchive('user@example.com', source, () => 'T0');
    const b = await exportOwnerArchive('user@example.com', source, () => 'T0');
    expect(a.keyBase64).not.toBe(b.keyBase64);
  });
});
