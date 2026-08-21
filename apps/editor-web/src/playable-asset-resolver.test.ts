import * as assetResolverModule from './asset-resolver.js';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthorizedDerivativeResolver,
  DerivativeAuthorityRevokedError,
  PlayableAssetResolver,
  type AuthorizedDerivativeTransport,
  type AuthorizedOriginalTransport,
  type PlayableAssetRequest,
} from './asset-resolver.js';
import { OpfsDerivativeCache, type ObjectUrlApi } from './opfs-asset-cache.js';
import {
  OpfsOriginalAssetCache,
  type OriginalAssetDescriptor,
} from './opfs-original-asset-cache.js';
import type { OpfsDirectoryHandle, OpfsFileHandle, WritableOpfsFile } from './opfs-asset-cache.js';

const bytes = new TextEncoder().encode('playable original bytes');
const DERIVATIVE_BYTES = new TextEncoder().encode('verified proxy derivative');
const SHA256 = 'a'.repeat(64);
const DERIVATIVE_SHA256 = 'b'.repeat(64);

describe('playable asset resolver', () => {
  it('returns a ready OPFS original when the browser already has verified original bytes', async () => {
    const opfs = memoryOpfs('asset');
    const originalCache = new OpfsOriginalAssetCache({
      root: opfs.root,
      objectUrls: opfs.urls,
      digest: digestOfKnownBytes,
    });
    await originalCache.put(assetDescriptor(), new Blob([bytes], { type: 'video/mp4' }));
    const derivativeResolver = derivativeResolverReturning({ state: 'unavailable' });
    const originalTransport = {
      fetch: vi.fn(async () => new Blob([bytes], { type: 'video/mp4' })),
    } satisfies AuthorizedOriginalTransport;

    const result = await new PlayableAssetResolver(
      originalCache,
      derivativeResolver,
      originalTransport,
    ).resolve(request());

    expect(result).toMatchObject({
      state: 'ready',
      source: 'opfs-original',
      url: 'blob:asset-1',
      mimeType: 'video/mp4',
    });
    expect(originalTransport.fetch).not.toHaveBeenCalled();
  });

  it('returns a ready verified derivative when there is no OPFS original', async () => {
    const opfs = memoryOpfs('asset');
    const originalCache = new OpfsOriginalAssetCache({
      root: opfs.root,
      objectUrls: opfs.urls,
      digest: digestOfKnownBytes,
    });
    const derivativeResolver = readyDerivativeResolver();

    const result = await new PlayableAssetResolver(
      originalCache,
      derivativeResolver,
      unavailableOriginalTransport(),
    ).resolve(
      request({
        derivative: {
          ...derivativeDescriptor(),
          kind: 'proxy',
          availability: 'available-local',
        },
      }),
    );

    expect(result).toMatchObject({
      state: 'ready',
      source: 'derivative',
      url: 'blob:derivative-1',
      mimeType: 'video/mp4',
    });
  });

  it('falls back to authorized private original bytes and caches them for later playback', async () => {
    const opfs = memoryOpfs('asset');
    const originalCache = new OpfsOriginalAssetCache({
      root: opfs.root,
      objectUrls: opfs.urls,
      digest: digestOfKnownBytes,
    });
    const derivativeResolver = derivativeResolverReturning({ state: 'unavailable' });
    const originalTransport = {
      fetch: vi.fn(async () => new Blob([bytes], { type: 'video/mp4' })),
    } satisfies AuthorizedOriginalTransport;
    const resolver = new PlayableAssetResolver(
      originalCache,
      derivativeResolver,
      originalTransport,
    );

    const first = await resolver.resolve(request());
    const second = await resolver.resolve(request());

    expect(first).toMatchObject({ state: 'ready', source: 'authorized-private' });
    expect(second).toMatchObject({ state: 'ready', source: 'opfs-original' });
    expect(originalTransport.fetch).toHaveBeenCalledTimes(1);
  });

  it('prefers an authorized private original over a pending proxy when original bytes are fetchable', async () => {
    const opfs = memoryOpfs('asset');
    const originalTransport = {
      fetch: vi.fn(async () => new Blob([bytes], { type: 'video/mp4' })),
    } satisfies AuthorizedOriginalTransport;
    const resolver = new PlayableAssetResolver(
      new OpfsOriginalAssetCache({
        root: opfs.root,
        objectUrls: opfs.urls,
        digest: digestOfKnownBytes,
      }),
      derivativeResolverReturning({ state: 'unavailable' }),
      originalTransport,
    );

    const result = await resolver.resolve(
      request({
        derivative: {
          ...derivativeDescriptor(),
          kind: 'proxy',
          availability: 'pending',
        },
      }),
    );

    expect(result).toMatchObject({
      state: 'ready',
      source: 'authorized-private',
      url: 'blob:asset-1',
      mimeType: 'video/mp4',
    });
    expect(originalTransport.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns pending while a proxy derivative is still being prepared and no original is available', async () => {
    const resolver = new PlayableAssetResolver(
      new OpfsOriginalAssetCache({ digest: digestOfKnownBytes }),
      derivativeResolverReturning({ state: 'unavailable' }),
      unavailableOriginalTransport(),
    );

    await expect(
      resolver.resolve(
        request({
          derivative: {
            derivativeId: 'derivative-proxy-1',
            kind: 'proxy',
            availability: 'pending',
            sha256: DERIVATIVE_SHA256,
            byteLength: DERIVATIVE_BYTES.byteLength,
            mimeType: 'video/mp4',
          },
        }),
      ),
    ).resolves.toEqual({ state: 'pending' });
  });

  it('returns revoked when private original authority is denied', async () => {
    const resolver = new PlayableAssetResolver(
      new OpfsOriginalAssetCache({ digest: digestOfKnownBytes }),
      derivativeResolverReturning({ state: 'unavailable' }),
      {
        fetch: async () => {
          throw new DerivativeAuthorityRevokedError();
        },
      },
    );

    await expect(resolver.resolve(request())).resolves.toEqual({ state: 'revoked' });
  });

  it('returns unavailable when neither local nor authorized playback bytes exist', async () => {
    const resolver = new PlayableAssetResolver(
      new OpfsOriginalAssetCache({ digest: digestOfKnownBytes }),
      derivativeResolverReturning({ state: 'unavailable' }),
      unavailableOriginalTransport(),
    );

    await expect(resolver.resolve(request())).resolves.toEqual({ state: 'unavailable' });
  });

  it('releases object URLs exactly once for ready handles', async () => {
    const opfs = memoryOpfs('asset');
    const originalCache = new OpfsOriginalAssetCache({
      root: opfs.root,
      objectUrls: opfs.urls,
      digest: digestOfKnownBytes,
    });
    await originalCache.put(assetDescriptor(), new Blob([bytes], { type: 'video/mp4' }));
    const resolver = new PlayableAssetResolver(
      originalCache,
      derivativeResolverReturning({ state: 'unavailable' }),
      unavailableOriginalTransport(),
    );

    const result = await resolver.resolve(request());
    expect(result.state).toBe('ready');
    if (result.state === 'ready') {
      result.release();
      result.release();
    }

    expect(opfs.revoked).toEqual(['blob:asset-1']);
  });

  it('keeps the production resolver module free of fixture-factory exports', () => {
    expect(assetResolverModule).not.toHaveProperty('createDemoOnlyFixturePlayableAssetResolver');
  });

  it('creates fixture-only resolvers through explicit test/demo bootstrap', async () => {
    const resolver = createFixturePlayableAssetResolverForTests({
      'asset-intro': {
        url: '/media/reference/asset-intro.mp4',
        mimeType: 'video/mp4',
      },
    });

    await expect(resolver.resolve(request({ assetId: 'asset-intro' }))).resolves.toMatchObject({
      state: 'ready',
      source: 'fixture',
      url: '/media/reference/asset-intro.mp4',
      mimeType: 'video/mp4',
    });
    await expect(resolver.resolve(request({ assetId: 'asset-missing' }))).resolves.toEqual({
      state: 'unavailable',
    });
  });
});

function request(
  overrides: Partial<
    PlayableAssetRequest & {
      assetId: string;
      derivative: NonNullable<PlayableAssetRequest['derivative']>;
    }
  > = {},
): PlayableAssetRequest {
  const assetId = overrides.assetId ?? 'asset-1';
  return {
    projectId: 'project-1',
    asset: {
      assetId,
      kind: 'video',
      sha256: SHA256,
      byteLength: bytes.byteLength,
      mimeType: 'video/mp4',
    },
    ...(overrides.derivative !== undefined ? { derivative: overrides.derivative } : {}),
    ...(overrides.projectId !== undefined ? { projectId: overrides.projectId } : {}),
    ...(overrides.asset !== undefined ? { asset: overrides.asset } : {}),
  };
}

function createFixturePlayableAssetResolverForTests(
  fixtures: Readonly<Record<string, { readonly url: string; readonly mimeType: string }>>,
): Pick<PlayableAssetResolver, 'resolve'> {
  return {
    async resolve(playable) {
      const fixture = fixtures[playable.asset.assetId];
      if (fixture === undefined) return { state: 'unavailable' };
      return {
        state: 'ready',
        source: 'fixture',
        url: fixture.url,
        mimeType: fixture.mimeType,
        release: () => undefined,
      };
    },
  };
}

function assetDescriptor(): OriginalAssetDescriptor {
  return {
    assetId: 'asset-1',
    sha256: SHA256,
    bytes: bytes.byteLength,
    mimeType: 'video/mp4',
  };
}

function derivativeDescriptor() {
  return {
    derivativeId: 'derivative-proxy-1',
    sha256: DERIVATIVE_SHA256,
    byteLength: DERIVATIVE_BYTES.byteLength,
    mimeType: 'video/mp4',
  } as const;
}

function readyDerivativeResolver(): AuthorizedDerivativeResolver {
  const opfs = memoryOpfs('derivative');
  const cache = new OpfsDerivativeCache({
    root: opfs.root,
    objectUrls: opfs.urls,
    digest: digestOfDerivativeBytes,
  });
  const transport: AuthorizedDerivativeTransport = {
    fetch: async () => new Blob([DERIVATIVE_BYTES], { type: 'video/mp4' }),
  };
  return new AuthorizedDerivativeResolver(cache, transport);
}

function derivativeResolverReturning(
  value: Awaited<ReturnType<AuthorizedDerivativeResolver['resolve']>>,
): AuthorizedDerivativeResolver {
  return { resolve: vi.fn().mockResolvedValue(value) } as unknown as AuthorizedDerivativeResolver;
}

function unavailableOriginalTransport(): AuthorizedOriginalTransport {
  return {
    fetch: async () => {
      throw new Error('missing');
    },
  };
}

async function digestOfKnownBytes(data: ArrayBuffer): Promise<ArrayBuffer> {
  expect(new Uint8Array(data)).toEqual(bytes);
  return new Uint8Array(Array.from({ length: 32 }, () => 0xaa)).buffer;
}

async function digestOfDerivativeBytes(data: ArrayBuffer): Promise<ArrayBuffer> {
  expect(new Uint8Array(data)).toEqual(DERIVATIVE_BYTES);
  return new Uint8Array(Array.from({ length: 32 }, () => 0xbb)).buffer;
}

function memoryOpfs(prefix: 'asset' | 'derivative'): {
  readonly root: OpfsDirectoryHandle;
  readonly urls: ObjectUrlApi;
  readonly revoked: string[];
} {
  const files = new Map<string, Blob>();
  const revoked: string[] = [];
  let nextUrl = 1;
  const root: OpfsDirectoryHandle = {
    async getDirectoryHandle() {
      return root;
    },
    async getFileHandle(name, options) {
      if (!files.has(name) && options?.create !== true) throw notFound();
      const file: OpfsFileHandle = {
        async getFile() {
          const value = files.get(name);
          if (value === undefined) throw notFound();
          return new File([value], name);
        },
        async createWritable() {
          let pending: Blob | undefined;
          const writable: WritableOpfsFile = {
            async write(data) {
              pending = data;
            },
            async close() {
              if (pending !== undefined) files.set(name, pending);
            },
          };
          return writable;
        },
      };
      return file;
    },
    async removeEntry(name) {
      if (!files.delete(name)) throw notFound();
    },
  };
  return {
    root,
    urls: {
      createObjectURL: () => `blob:${prefix}-${nextUrl++}`,
      revokeObjectURL: (url) => revoked.push(url),
    },
    revoked,
  };
}

function notFound(): DOMException {
  return new DOMException('missing', 'NotFoundError');
}
