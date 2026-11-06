import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAsset } from './control-plane-client.js';
import { ProjectMediaResolver } from './project-media-resolver.js';
import { clearMediaSource } from './media-object-url.js';

/**
 * A Blob that refuses the whole-file read. Only sliced reads are possible, so a
 * descriptor digest can only be verified without copying the file into one buffer.
 */
class WholeFileReadForbiddenBlob extends Blob {
  override async arrayBuffer(): Promise<ArrayBuffer> {
    throw new Error('whole-file read is not allowed');
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function catalogAsset(sha256: string, bytes: number): BrowserAsset {
  return {
    id: 'media-1',
    projectId: 'project-1',
    kind: 'video',
    displayName: 'clip.mp4',
    sha256,
    bytes,
    descriptor: { mimeType: 'video/mp4' },
    createdAt: 0,
    cloudBacked: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ProjectMediaResolver', () => {
  afterEach(() => vi.restoreAllMocks());

  it('invalidates a pending local read on clear without creating or caching a stale URL', async () => {
    const local = deferred<Blob | undefined>();
    const get = vi.fn(() => local.promise);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stale');
    const resolver = new ProjectMediaResolver({
      projectId: 'project-1',
      controlPlaneReady: false,
      client: {
        assets: vi.fn(async () => []),
      },
      originalCache: { get },
    });

    const pending = resolver.resolve('media-1');
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    resolver.clear();
    const invalidated = expect(pending).rejects.toThrow('invalidated');
    local.resolve(new Blob(['old'], { type: 'video/mp4' }));
    await invalidated;
    expect(create).not.toHaveBeenCalled();

    const fresh = new Blob(['fresh'], { type: 'video/mp4' });
    get.mockResolvedValue(fresh);
    create.mockReturnValue('blob:fresh');
    await expect(resolver.resolve('media-1')).resolves.toMatchObject({ url: 'blob:fresh' });
    expect(get).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledExactlyOnceWith(fresh);
    resolver.clear();
  });

  it('releases a preview media element before resolver clear revokes its URL', async () => {
    let source = '';
    const events: string[] = [];
    const video = {
      pause: () => events.push('pause'),
      removeAttribute: (name: string) => {
        if (name === 'src') source = '';
        events.push(name === 'src' ? 'remove-src' : 'remove-poster');
      },
      load: () => events.push('load'),
      getAttribute: (name: string) => (name === 'src' ? source : null),
    } as unknown as HTMLVideoElement;
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      expect(source).toBe('');
      events.push(`revoke:${url}`);
    });
    const resolver = new ProjectMediaResolver({
      projectId: 'project-1',
      controlPlaneReady: false,
      client: {
        assets: vi.fn(async () => []),
      },
      originalCache: { get: vi.fn(async () => new Blob(['preview'], { type: 'video/mp4' })) },
    });

    const resolved = await resolver.resolve('media-1');
    source = resolved.url;
    resolver.clear(() => clearMediaSource(video));

    expect(events).toEqual(['pause', 'remove-src', 'remove-poster', 'load', 'revoke:blob:preview']);
  });

  it('preserves concurrent deduplication in the new epoch when an older request settles', async () => {
    const oldRead = deferred<Blob | undefined>();
    const currentRead = deferred<Blob | undefined>();
    const get = vi.fn().mockReturnValueOnce(oldRead.promise).mockReturnValue(currentRead.promise);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:current');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const resolver = new ProjectMediaResolver({
      projectId: 'project-1',
      controlPlaneReady: false,
      client: {
        assets: vi.fn(async () => []),
      },
      originalCache: { get },
    });

    const oldRequest = resolver.resolve('media-1');
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    resolver.clear();
    const currentRequest = resolver.resolve('media-1');
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    const invalidated = expect(oldRequest).rejects.toThrow('invalidated');
    oldRead.resolve(new Blob(['old'], { type: 'video/mp4' }));
    await invalidated;
    const duplicateRequest = resolver.resolve('media-1');
    currentRead.resolve(new Blob(['current'], { type: 'video/mp4' }));
    const current = await currentRequest;
    expect(await duplicateRequest).toBe(current);
    expect(await resolver.resolve('media-1')).toBe(current);
    expect(get).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    resolver.clear();
    resolver.clear();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:current');
  });

  it('prefers OPFS bytes and reuses the object URL', async () => {
    const blob = new Blob(['local'], { type: 'video/mp4' });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const resolver = new ProjectMediaResolver({
      projectId: 'project-1',
      client: {
        assets: vi.fn(async () => []),
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

  it('verifies a matching descriptor sha256 without reading the whole blob', async () => {
    const bytes = new TextEncoder().encode('local-bytes-never-read-whole');
    const blob = new WholeFileReadForbiddenBlob([bytes], { type: 'video/mp4' });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const resolver = new ProjectMediaResolver({
      projectId: 'project-1',
      client: {
        assets: vi.fn(async () => [catalogAsset(sha256Hex(bytes), bytes.byteLength)]),
      },
      originalCache: { get: vi.fn(async () => blob) },
    });

    await expect(resolver.resolve('media-1')).resolves.toEqual({
      url: 'blob:local',
      mimeType: 'video/mp4',
      source: 'opfs',
    });
    expect(create).toHaveBeenCalledExactlyOnceWith(blob);
    resolver.clear();
  });

  it('hashes a file larger than one slice in bounded slices and never as one read', async () => {
    // Larger than the 8 MiB hashing slice, so a whole-file read through a slice would show up as an oversized slice.
    const bytes = new Uint8Array(20 * 1024 * 1024).fill(7);
    const sliceSizes: number[] = [];
    class SliceRecordingBlob extends WholeFileReadForbiddenBlob {
      override slice(start?: number, end?: number, contentType?: string): Blob {
        const part = super.slice(start, end, contentType);
        sliceSizes.push(part.size);
        return part;
      }
    }
    const blob = new SliceRecordingBlob([bytes], { type: 'video/mp4' });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const resolver = new ProjectMediaResolver({
      projectId: 'project-1',
      client: {
        assets: vi.fn(async () => [catalogAsset(sha256Hex(bytes), bytes.byteLength)]),
      },
      originalCache: { get: vi.fn(async () => blob) },
    });

    await expect(resolver.resolve('media-1')).resolves.toMatchObject({ source: 'opfs' });
    expect(sliceSizes.length).toBeGreaterThan(1);
    expect(Math.max(...sliceSizes)).toBeLessThanOrEqual(8 * 1024 * 1024);
    resolver.clear();
  });

  it('rejects a local blob whose digest does not match the descriptor', async () => {
    const bytes = new TextEncoder().encode('local-bytes-never-read-whole');
    const blob = new WholeFileReadForbiddenBlob([bytes], { type: 'video/mp4' });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const actual = sha256Hex(bytes);
    const wrong = actual.startsWith('a') ? `b${actual.slice(1)}` : `a${actual.slice(1)}`;
    const resolver = new ProjectMediaResolver({
      projectId: 'project-1',
      client: {
        assets: vi.fn(async () => [catalogAsset(wrong, bytes.byteLength)]),
      },
      originalCache: { get: vi.fn(async () => blob) },
    });

    await expect(resolver.resolve('media-1')).rejects.toThrow(
      'Media clip.mp4 is unavailable in the local cache',
    );
    expect(create).not.toHaveBeenCalled();
    resolver.clear();
  });

  it('provides only owner-authorized local bytes to the observation host', async () => {
    const blob = new Blob(['local-observation'], { type: 'video/mp4' });
    const resolver = new ProjectMediaResolver({
      projectId: 'project-1',
      client: {
        assets: vi.fn(async () => []),
      },
      originalCache: { get: vi.fn(async () => blob) },
    });

    await expect(resolver.resolveObservationSource('media-1')).resolves.toEqual({
      blob,
      mimeType: 'video/mp4',
      source: 'opfs',
    });
    resolver.clear();
  });

  it('does not reinterpret an allowlisted reference URL as local user observation bytes', async () => {
    const resolver = new ProjectMediaResolver({
      projectId: 'signed-out-project',
      controlPlaneReady: false,
      client: {
        assets: vi.fn(async () => []),
      },
      originalCache: { get: vi.fn(async () => undefined) },
    });

    await expect(resolver.resolveObservationSource('asset-intro')).rejects.toThrow(
      'trusted local observation bytes',
    );
  });

  it('correctly reports owned URLs and consumer elements, detaching only when owned', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned-url');
    const resolver = new ProjectMediaResolver({
      projectId: 'project-1',
      controlPlaneReady: false,
      client: {
        assets: vi.fn(async () => []),
      },
      originalCache: { get: vi.fn(async () => new Blob(['data'], { type: 'video/mp4' })) },
    });

    expect(resolver.ownsUrl(null)).toBe(false);
    expect(resolver.ownsUrl('blob:unresolved')).toBe(false);

    const resolved = await resolver.resolve('media-1');
    expect(resolved.url).toBe('blob:owned-url');
    expect(resolver.ownsUrl('blob:owned-url')).toBe(true);
    expect(resolver.ownsUrl('blob:other-url')).toBe(false);

    let ownedSrc: string | null = 'blob:owned-url';
    const ownedElement = {
      getAttribute: (name: string) => (name === 'src' ? ownedSrc : null),
      removeAttribute: (name: string) => {
        if (name === 'src') ownedSrc = null;
      },
      pause: vi.fn(),
      load: vi.fn(),
    } as unknown as HTMLVideoElement;

    let otherSrc: string | null = 'blob:other-url';
    const otherElement = {
      getAttribute: (name: string) => (name === 'src' ? otherSrc : null),
      removeAttribute: (name: string) => {
        if (name === 'src') otherSrc = null;
      },
      pause: vi.fn(),
      load: vi.fn(),
    } as unknown as HTMLVideoElement;

    expect(resolver.ownsConsumer(null)).toBe(false);
    expect(resolver.ownsConsumer(ownedElement)).toBe(true);
    expect(resolver.ownsConsumer(otherElement)).toBe(false);

    expect(resolver.detachConsumerIfOwned(otherElement)).toBe(false);
    expect(otherSrc).toBe('blob:other-url');

    expect(resolver.detachConsumerIfOwned(ownedElement)).toBe(true);
    expect(ownedSrc).toBeNull();

    resolver.clear();
  });

  it('detaches a detached video element holding a resolved URL on clear', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:detached-partner');
    const revokedUrls: string[] = [];
    let detachedSrc: string | null = null;
    const detachedVideo = {
      getAttribute: (name: string) => (name === 'src' ? detachedSrc : null),
      removeAttribute: (name: string) => {
        if (name === 'src') detachedSrc = null;
      },
      pause: vi.fn(),
      load: vi.fn(),
    } as unknown as HTMLVideoElement;

    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      expect(detachedSrc).toBeNull();
      revokedUrls.push(url);
    });

    const resolver = new ProjectMediaResolver({
      projectId: 'project-1',
      controlPlaneReady: false,
      client: {
        assets: vi.fn(async () => []),
      },
      originalCache: { get: vi.fn(async () => new Blob(['data'], { type: 'video/mp4' })) },
    });

    const resolved = await resolver.resolve('media-1');
    detachedSrc = resolved.url;
    expect(resolver.ownsConsumer(detachedVideo)).toBe(true);

    resolver.clear(() => {
      expect(resolver.detachConsumerIfOwned(detachedVideo)).toBe(true);
      expect(detachedSrc).toBeNull();
    });

    expect(revokedUrls).toEqual(['blob:detached-partner']);
  });
});
