import { describe, expect, it } from 'vitest';
import {
  AuthorizedDerivativeResolver,
  DerivativeAuthorityRevokedError,
  type AuthorizedDerivativeTransport,
} from './asset-resolver.js';
import {
  OpfsDerivativeCache,
  openOpfsDerivativeCache,
  type ObjectUrlApi,
  type OpfsDirectoryHandle,
  type OpfsFileHandle,
  type WritableOpfsFile,
} from './opfs-asset-cache.js';

const bytes = new TextEncoder().encode('verified thumbnail');
const SHA256 = 'a'.repeat(64);
const REAL_SHA256 = '6a2d406289a16feb9d919d48587109a89344f7bbd0152069489939ad5c47a820';
const derivative = {
  derivativeId: 'derivative-thumb-1',
  sha256: SHA256,
  byteLength: bytes.byteLength,
  mimeType: 'image/jpeg',
} as const;

describe('authorized derivative resolver', () => {
  it('does not invent a non-OPFS fallback when browser OPFS is unavailable', async () => {
    const cache = await openOpfsDerivativeCache({ digest: digestOfKnownBytes });
    // Vitest's Node environment has no browser navigator storage root.
    await expect(cache.resolve(derivative)).resolves.toEqual({ state: 'unsupported' });
  });

  it('uses a verified OPFS hit without asking the transport for bytes', async () => {
    const opfs = memoryOpfs();
    const cache = new OpfsDerivativeCache({
      root: opfs.root,
      digest: digestOfKnownBytes,
      objectUrls: opfs.urls,
    });
    await cache.put(derivative, new Blob([bytes], { type: derivative.mimeType }));
    const transport: AuthorizedDerivativeTransport = {
      fetch: async () => {
        throw new Error('must not fetch');
      },
    };

    const result = await new AuthorizedDerivativeResolver(cache, transport).resolve(request());

    expect(result).toMatchObject({ state: 'available-local', url: 'blob:derivative-1' });
    if (result.state === 'available-local') result.revoke();
    expect(opfs.revoked).toEqual(['blob:derivative-1']);
  });

  it('uses browser Web Crypto before exposing a cached blob URL', async () => {
    const opfs = memoryOpfs();
    const cache = new OpfsDerivativeCache({ root: opfs.root, objectUrls: opfs.urls });
    const realDigestDerivative = { ...derivative, sha256: REAL_SHA256 };

    await cache.put(
      realDigestDerivative,
      new Blob([bytes], { type: realDigestDerivative.mimeType }),
    );

    await expect(cache.resolve(realDigestDerivative)).resolves.toMatchObject({
      state: 'available-local',
      url: 'blob:derivative-1',
    });
  });

  it('accepts private authorized bytes only after integrity verification and caches them', async () => {
    const opfs = memoryOpfs();
    let fetches = 0;
    const cache = new OpfsDerivativeCache({
      root: opfs.root,
      digest: digestOfKnownBytes,
      objectUrls: opfs.urls,
    });
    const resolver = new AuthorizedDerivativeResolver(cache, {
      fetch: async () => {
        fetches += 1;
        return new Blob([bytes], { type: derivative.mimeType });
      },
    });

    await expect(resolver.resolve(request())).resolves.toMatchObject({ state: 'available-local' });
    await expect(resolver.resolve(request())).resolves.toMatchObject({ state: 'available-local' });
    expect(fetches).toBe(1);
  });

  it('never plays tampered bytes and removes the failed local cache entry', async () => {
    const opfs = memoryOpfs();
    const cache = new OpfsDerivativeCache({
      root: opfs.root,
      digest: digestOfKnownBytes,
      objectUrls: opfs.urls,
    });
    const resolver = new AuthorizedDerivativeResolver(cache, {
      fetch: async () => new Blob(['tampered'], { type: derivative.mimeType }),
    });

    await expect(resolver.resolve(request())).resolves.toEqual({ state: 'unavailable' });
    await expect(cache.resolve(derivative)).resolves.toEqual({ state: 'missing' });
  });

  it('preserves a specific revoked authority state and never exposes a remote URL', async () => {
    const opfs = memoryOpfs();
    const resolver = new AuthorizedDerivativeResolver(
      new OpfsDerivativeCache({
        root: opfs.root,
        digest: digestOfKnownBytes,
        objectUrls: opfs.urls,
      }),
      {
        fetch: async () => {
          throw new DerivativeAuthorityRevokedError();
        },
      },
    );

    await expect(resolver.resolve(request())).resolves.toEqual({ state: 'revoked' });
  });
});

function request() {
  return { projectId: 'project-1', assetId: 'asset-1', derivative };
}

async function digestOfKnownBytes(data: ArrayBuffer): Promise<ArrayBuffer> {
  expect(new Uint8Array(data)).toEqual(bytes);
  return new Uint8Array(Array.from({ length: 32 }, () => 0xaa)).buffer;
}

function memoryOpfs(): {
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
          return new File([value], name, { type: value.type });
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
      createObjectURL: () => `blob:derivative-${nextUrl++}`,
      revokeObjectURL: (url) => revoked.push(url),
    },
    revoked,
  };
}

function notFound(): DOMException {
  return new DOMException('missing', 'NotFoundError');
}
