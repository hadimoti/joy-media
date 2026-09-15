import { describe, expect, it } from 'vitest';
import { buildManifest } from './manifest.js';
import { verifyNoDataLoss } from './integrity-verification.js';

function projectEntry(id: string) {
  return { name: `projects/${id}.json`, bytes: Buffer.from(`{"id":"${id}"}`) };
}

function mediaEntry(projectId: string, assetId: string) {
  return { name: `media/${projectId}/${assetId}-clip.mp4`, bytes: Buffer.from('abc') };
}

describe('verifyNoDataLoss', () => {
  it('passes when the archive has exactly the expected project count', () => {
    const manifest = buildManifest([projectEntry('a'), projectEntry('b')]);
    expect(verifyNoDataLoss(manifest, 2)).toEqual({
      ok: true,
      expectedProjectCount: 2,
      manifestProjectCount: 2,
      issues: [],
    });
  });

  it('fails when the archive has fewer projects than the live source reported', () => {
    const manifest = buildManifest([projectEntry('a')]);
    const result = verifyNoDataLoss(manifest, 3);
    expect(result.ok).toBe(false);
    expect(result.manifestProjectCount).toBe(1);
    expect(result.issues[0]).toMatch(/expected 3/);
  });

  it('fails when the archive has more projects than expected (also worth flagging)', () => {
    const manifest = buildManifest([projectEntry('a'), projectEntry('b')]);
    expect(verifyNoDataLoss(manifest, 1).ok).toBe(false);
  });

  it('does not count media entries as projects', () => {
    const manifest = buildManifest([projectEntry('a'), mediaEntry('a', 'asset-1')]);
    expect(verifyNoDataLoss(manifest, 1)).toMatchObject({ ok: true, manifestProjectCount: 1 });
  });

  it('passes for zero projects on both sides', () => {
    const manifest = buildManifest([]);
    expect(verifyNoDataLoss(manifest, 0).ok).toBe(true);
  });
});
