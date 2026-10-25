import { describe, expect, it } from 'vitest';
import {
  fetchLatestSignedManifest,
  isAllowedReleaseUrl,
  latestReleaseAssetUrl,
  PINNED_RELEASE_PUBLIC_KEYS_PEM,
  RELEASE_KEY_OVERRIDE_ENV,
  releasePageUrl,
  ReleaseSourceError,
  resolveReleaseKeys,
} from './index.js';

const manifestUrl = latestReleaseAssetUrl('release-manifest.json');
const signatureUrl = latestReleaseAssetUrl('release-manifest.json.sig');

function response(
  body: Uint8Array,
  options: { readonly url: string; readonly status?: number; readonly contentLength?: string },
): Response {
  const status = options.status ?? 200;
  const headers = new Map<string, string>();
  if (options.contentLength !== undefined) headers.set('content-length', options.contentLength);
  return {
    ok: status >= 200 && status < 300,
    status,
    url: options.url,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () => body.slice().buffer,
  } as unknown as Response;
}

function fakeFetch(handler: (url: string) => Response | Error): typeof fetch {
  return (async (input: string | URL | Request) => {
    const result = handler(String(input));
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof fetch;
}

describe('release URLs and hosts', () => {
  it('builds the latest-release asset and the release page URLs', () => {
    expect(manifestUrl).toBe(
      'https://github.com/hadimoti/joy-media/releases/latest/download/release-manifest.json',
    );
    expect(releasePageUrl('1.0.3')).toBe(
      'https://github.com/hadimoti/joy-media/releases/tag/v1.0.3',
    );
  });

  it('allows only https URLs on the GitHub release hosts', () => {
    expect(isAllowedReleaseUrl('https://github.com/x')).toBe(true);
    expect(isAllowedReleaseUrl('https://objects.githubusercontent.com/x')).toBe(true);
    expect(isAllowedReleaseUrl('https://release-assets.githubusercontent.com/x')).toBe(true);
    expect(isAllowedReleaseUrl('http://github.com/x')).toBe(false);
    expect(isAllowedReleaseUrl('https://user:secret@github.com/x')).toBe(false);
    expect(isAllowedReleaseUrl('https://joyst.ir/x')).toBe(false);
    expect(isAllowedReleaseUrl('https://github.com.evil.example/x')).toBe(false);
    expect(isAllowedReleaseUrl('not a url')).toBe(false);
  });
});

describe('fetching the signed manifest', () => {
  it('returns the exact manifest bytes and the signature text', async () => {
    const manifest = new TextEncoder().encode('{"channel":"stable"}');
    const fetchFn = fakeFetch((url) =>
      response(url === manifestUrl ? manifest : new TextEncoder().encode('sig\n'), { url }),
    );
    const result = await fetchLatestSignedManifest({ fetch: fetchFn });
    expect(Array.from(result.manifestBytes)).toEqual(Array.from(manifest));
    expect(result.signature).toBe('sig\n');
  });

  it('refuses a redirect that lands outside the allowed hosts', async () => {
    const fetchFn = fakeFetch(() =>
      response(new Uint8Array([1]), { url: 'https://evil.example/release-manifest.json' }),
    );
    await expect(fetchLatestSignedManifest({ fetch: fetchFn })).rejects.toBeInstanceOf(
      ReleaseSourceError,
    );
  });

  it('refuses a response with no final URL, because its host cannot be checked', async () => {
    const fetchFn = fakeFetch(() => response(new Uint8Array([1]), { url: '' }));
    await expect(fetchLatestSignedManifest({ fetch: fetchFn })).rejects.toBeInstanceOf(
      ReleaseSourceError,
    );
  });

  it('refuses a failed HTTP status', async () => {
    const fetchFn = fakeFetch((url) => response(new Uint8Array(), { url, status: 404 }));
    await expect(fetchLatestSignedManifest({ fetch: fetchFn })).rejects.toBeInstanceOf(
      ReleaseSourceError,
    );
  });

  it('refuses a manifest whose declared length is over the cap', async () => {
    const fetchFn = fakeFetch((url) =>
      response(new Uint8Array([1]), { url, contentLength: '2000000' }),
    );
    await expect(fetchLatestSignedManifest({ fetch: fetchFn })).rejects.toBeInstanceOf(
      ReleaseSourceError,
    );
  });

  it('refuses a manifest whose body is over the cap, even without a declared length', async () => {
    const fetchFn = fakeFetch((url) => response(new Uint8Array(1024 * 1024 + 1), { url }));
    await expect(fetchLatestSignedManifest({ fetch: fetchFn })).rejects.toBeInstanceOf(
      ReleaseSourceError,
    );
  });

  it('refuses when the network call itself fails', async () => {
    const fetchFn = fakeFetch(() => new Error('offline'));
    await expect(fetchLatestSignedManifest({ fetch: fetchFn })).rejects.toBeInstanceOf(
      ReleaseSourceError,
    );
  });

  it('keeps the signature URL on the release host list', () => {
    expect(signatureUrl).toBe(
      'https://github.com/hadimoti/joy-media/releases/latest/download/release-manifest.json.sig',
    );
  });
});

describe('release keys', () => {
  const PEM = '-----BEGIN PUBLIC KEY-----\nexample\n-----END PUBLIC KEY-----';

  it('lets a packaged app trust only the pinned keys, ignoring the environment override', () => {
    expect(
      resolveReleaseKeys({ isPackaged: true, env: { [RELEASE_KEY_OVERRIDE_ENV]: PEM } }),
    ).toEqual(PINNED_RELEASE_PUBLIC_KEYS_PEM);
  });

  it('lets a build that is not packaged use the environment override', () => {
    expect(
      resolveReleaseKeys({ isPackaged: false, env: { [RELEASE_KEY_OVERRIDE_ENV]: PEM } }),
    ).toEqual([PEM]);
  });

  it('ignores a blank override outside a packaged app', () => {
    expect(
      resolveReleaseKeys({ isPackaged: false, env: { [RELEASE_KEY_OVERRIDE_ENV]: '   ' } }),
    ).toEqual(PINNED_RELEASE_PUBLIC_KEYS_PEM);
  });
});
