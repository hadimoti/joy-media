import { describe, expect, it, vi } from 'vitest';
import { ProjectMediaResolver } from './project-media-resolver.js';

describe('ProjectMediaResolver', () => {
  it('prefers OPFS bytes and reuses the object URL', async () => {
    const blob = new Blob(['local'], { type: 'video/mp4' });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const resolver = new ProjectMediaResolver({
      projectId: 'project-1',
      client: {
        assets: vi.fn(async () => []),
        originalBytes: vi.fn(async () => {
          throw new Error('cloud should not be requested');
        }),
      },
      originalCache: { get: vi.fn(async () => blob) },
    });

    await expect(resolver.resolve('media-1')).resolves.toEqual({
      url: 'blob:local',
      mimeType: 'video/mp4',
      source: 'opfs',
    });
    await expect(resolver.resolve('media-1')).resolves.toBe(await resolver.resolve('media-1'));
    resolver.clear();
    expect(revoke).toHaveBeenCalledWith('blob:local');
    create.mockRestore();
    revoke.mockRestore();
  });

  it('uses owner-authorized cloud bytes before the allowlisted reference fallback', async () => {
    const cloud = new Blob(['cloud'], { type: 'video/mp4' });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cloud');
    const resolver = new ProjectMediaResolver({
      projectId: 'project-1',
      client: {
        assets: vi.fn(async () => []),
        originalBytes: vi.fn(async (_projectId, assetId) => {
          if (assetId === 'media-1') return cloud;
          throw new Error('not stored');
        }),
      },
      originalCache: { get: vi.fn(async () => undefined) },
    });

    await expect(resolver.resolve('media-1')).resolves.toMatchObject({
      url: 'blob:cloud',
      source: 'cloud',
    });
    await expect(resolver.resolve('asset-intro')).resolves.toEqual({
      url: '/media/reference/asset-intro.mp4',
      mimeType: 'video/mp4',
      source: 'reference',
    });
    await expect(resolver.resolve('media-missing')).rejects.toThrow('unavailable');
    create.mockRestore();
  });

  it('rejects stale cached bytes and accepts the integrity-checked cloud copy', async () => {
    const expected = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode('cloud')),
    );
    const sha256 = Array.from(expected, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:verified');
    const cloud = new Blob(['cloud'], { type: 'video/mp4' });
    const resolver = new ProjectMediaResolver({
      projectId: 'project-1',
      project: {
        assets: {
          'media-1': {
            id: 'media-1',
            kind: 'video',
            displayName: 'Imported',
            sha256,
            bytes: cloud.size,
          },
        },
      } as never,
      client: {
        assets: vi.fn(async () => []),
        originalBytes: vi.fn(async () => cloud),
      },
      originalCache: { get: vi.fn(async () => new Blob(['stale'], { type: 'video/mp4' })) },
    });

    await expect(resolver.resolve('media-1')).resolves.toMatchObject({
      source: 'cloud',
      url: 'blob:verified',
    });
    create.mockRestore();
  });
});
