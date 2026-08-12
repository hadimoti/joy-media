import { describe, expect, it, vi } from 'vitest';
import { ProjectMediaResolver } from './project-media-resolver.js';

describe('ProjectMediaResolver', () => {
  it('does not query a temporary control-plane binding before authentication is ready', async () => {
    const assets = vi.fn(async () => []);
    const resolver = new ProjectMediaResolver({
      projectId: 'signed-out-project',
      controlPlaneReady: false,
      client: {
        assets,
        originalBytes: vi.fn(async () => {
          throw new Error('media API should not be queried');
        }),
        sharedCloudOriginalBytes: vi.fn(async () => {
          throw new Error('shared cloud should not be queried');
        }),
      },
      originalCache: { get: vi.fn(async () => undefined) },
    });

    await expect(resolver.resolve('asset-intro')).resolves.toMatchObject({
      source: 'reference',
      url: '/media/reference/asset-intro.mp4',
    });
    expect(assets).not.toHaveBeenCalled();
  });

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
        sharedCloudOriginalBytes: vi.fn(async () => {
          throw new Error('shared cloud should not be requested');
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
        sharedCloudOriginalBytes: vi.fn(async () => {
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

  it('uses an integrity-checked shared-library original when project ownership is absent', async () => {
    const cloud = new Blob(['shared'], { type: 'application/octet-stream' });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:shared');
    const resolver = new ProjectMediaResolver({
      projectId: 'project-1',
      project: {
        assets: {
          'shared-video': {
            id: 'shared-video',
            kind: 'video',
            displayName: 'Shared clip',
            bytes: cloud.size,
            descriptor: { mimeType: 'video/mp4' },
          },
        },
      } as never,
      client: {
        assets: vi.fn(async () => []),
        originalBytes: vi.fn(async () => {
          throw new Error('not a project-owned asset');
        }),
        sharedCloudOriginalBytes: vi.fn(async () => cloud),
      },
      originalCache: { get: vi.fn(async () => undefined) },
    });

    await expect(resolver.resolve('shared-video')).resolves.toMatchObject({
      source: 'cloud',
      url: 'blob:shared',
      mimeType: 'video/mp4',
    });
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
        sharedCloudOriginalBytes: vi.fn(async () => cloud),
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
