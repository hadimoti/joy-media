import { describe, expect, it } from 'vitest';

/**
 * Contract tests for the native stock-video provider boundary.
 *
 * The implementation modules are intentionally not present at the baseline
 * commit. These tests use a dynamic import so the current failure is an
 * actionable contract failure rather than a TypeScript module-resolution
 * failure. The implementation should export the small, provider-neutral
 * surface named below (or update this contract in the same focused slice).
 */
async function providerModule(): Promise<Record<string, unknown>> {
  try {
    return (await import('./stock-video-providers.js')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `stock-video-providers contract is not implemented: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function exported<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name];
  if (value === undefined) throw new Error(`stock-video-providers must export ${name}`);
  return value as T;
}

const CATEGORIES = [
  'business-work',
  'technology',
  'people-lifestyle',
  'nature',
  'travel-places',
  'city-transport',
  'food-drink',
  'abstract-backgrounds',
] as const;

describe('stock-video provider safety contract', () => {
  it('publishes exactly the eight stable category slugs', async () => {
    const module = await providerModule();
    const categories = exported<readonly string[]>(module, 'STOCK_VIDEO_CATEGORIES');
    expect(categories).toEqual(CATEGORIES);
  });

  it('accepts only official HTTPS media hosts and rejects SSRF targets', async () => {
    const module = await providerModule();
    const assertUrl = exported<(provider: 'pexels' | 'pixabay', value: string) => URL>(
      module,
      'assertProviderUrl',
    );
    for (const value of ['https://videos.pexels.com/video-files/1/1.mp4'])
      expect(assertUrl('pexels', value)).toBeInstanceOf(URL);
    expect(assertUrl('pixabay', 'https://cdn.pixabay.com/video/2/2.mp4')).toBeInstanceOf(URL);
    for (const value of [
      'http://videos.pexels.com/video-files/1.mp4',
      'file:///etc/passwd',
      'https://127.0.0.1/private.mp4',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/private.mp4',
      'https://user:pass@videos.pexels.com/video.mp4',
      'https://evil.example/video.mp4',
    ])
      expect(() => assertUrl('pexels', value)).toThrow();
  });

  it('revalidates each redirect and never forwards provider credentials', async () => {
    let module: Record<string, unknown>;
    try {
      module = (await import('./pexels-stock-video-provider.js')) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `pexels-stock-video-provider contract is not implemented: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const Provider = exported<
      new (options: Record<string, unknown>) => {
        fetchPoster(url: string, signal?: AbortSignal): Promise<Response>;
      }
    >(module, 'PexelsStockVideoProvider');
    const fetchImpl = async (input: string) => {
      if (input.includes('redirect'))
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } });
      return new Response(new Uint8Array([0]), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '1' },
      });
    };
    const provider = new Provider({
      apiKey: 'fixture-only-secret',
      fetchImplementation: fetchImpl,
    });
    const response = await provider.fetchPoster('https://videos.pexels.com/redirect.mp4');
    expect(response.status).not.toBe(302);
  });

  it('normalizes current Pixabay rendition thumbnails as posters', async () => {
    let module: Record<string, unknown>;
    try {
      module = (await import('./pixabay-stock-video-provider.js')) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `pixabay-stock-video-provider contract is not implemented: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const Provider = exported<
      new (options: Record<string, unknown>) => {
        search(request: Record<string, unknown>): Promise<readonly Record<string, unknown>[]>;
      }
    >(module, 'PixabayStockVideoProvider');
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          hits: [
            {
              id: 42,
              pageURL: 'https://pixabay.com/videos/fixture-42/',
              user: 'Fixture creator',
              duration: 8,
              videos: {
                medium: {
                  width: 1280,
                  height: 720,
                  size: 1_000,
                  url: 'https://cdn.pixabay.com/video/fixture-42.mp4',
                  thumbnail: 'https://cdn.pixabay.com/video/fixture-42.jpg',
                },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const provider = new Provider({
      apiKey: 'fixture-only-secret',
      fetchImplementation: fetchImpl,
    });
    const cards = await provider.search({ category: 'nature', perPage: 3 });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.posterUrl).toBe('https://cdn.pixabay.com/video/fixture-42.jpg');
  });

  it('enforces response byte and media metadata limits before acceptance', async () => {
    const module = await providerModule();
    const validate = exported<(candidate: Record<string, unknown>) => boolean>(
      module,
      'eligibleStockVideo',
    );
    const base = {
      provider: 'pexels',
      providerAssetId: '1',
      category: 'nature',
      title: 'Fixture clip',
      creator: 'Fixture creator',
      sourcePageUrl: 'https://www.pexels.com/video/1/',
      termsUrl: 'https://www.pexels.com/license/',
      renditionId: 'hd',
      mediaUrl: 'https://videos.pexels.com/video-files/1/1.mp4',
      posterUrl: 'https://images.pexels.com/video/1.jpg',
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      durationSeconds: 10,
      orientation: 'landscape',
      bytes: 1_000,
    };
    const isEligible = (candidate: Record<string, unknown>) => {
      try {
        return validate(candidate);
      } catch {
        return false;
      }
    };
    expect(isEligible(base)).toBe(true);
    expect(isEligible({ ...base, bytes: 60 * 1024 * 1024 + 1 })).toBe(false);
    expect(isEligible({ ...base, durationSeconds: 21 })).toBe(false);
    expect(isEligible({ ...base, mimeType: 'text/html' })).toBe(false);
    expect(isEligible({ ...base, sourcePageUrl: 'https://evil.example/1' })).toBe(false);
  });

  it('redacts keys, credential-bearing URLs, and upstream response bodies', async () => {
    const module = await providerModule();
    const redact = exported<(value: string) => string>(module, 'redactStockVideoDiagnostic');
    const secret = 'fixture-pexels-key-never-real';
    const line = `GET https://api.pixabay.com/videos?key=${secret} body={"error":"${secret}"}`;
    const result = redact(line);
    expect(result).not.toContain(secret);
    expect(result).not.toContain('api.pixabay.com/videos?key=');
    expect(result).toMatch(/redacted/i);
  });

  it('deduplicates provider asset/rendition identity and SHA-256', async () => {
    const module = await providerModule();
    const deduplicate = exported<
      (items: readonly Record<string, unknown>[]) => readonly Record<string, unknown>[]
    >(module, 'dedupeCandidates');
    const item = {
      provider: 'pexels',
      providerAssetId: '1',
      title: 'Fixture clip',
      creator: 'Fixture creator',
      sourcePageUrl: 'https://www.pexels.com/video/1/',
      termsUrl: 'https://www.pexels.com/license/',
      renditionId: 'hd',
      mediaUrl: 'https://videos.pexels.com/video-files/1/1.mp4',
      posterUrl: 'https://images.pexels.com/video/1.jpg',
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      durationSeconds: 10,
      orientation: 'landscape',
      sha256: 'a'.repeat(64),
    };
    expect(
      deduplicate([item, { ...item }, { ...item, providerAssetId: '2', sha256: 'b'.repeat(64) }]),
    ).toHaveLength(2);
  });

  it('normalizes cache identity and classifies provider rate failures as retryable', async () => {
    const module = await providerModule();
    const normalize = exported<(value: string | undefined) => string>(
      module,
      'normalizeSearchQuery',
    );
    const key = exported<(request: { category?: string; query?: string }) => string>(
      module,
      'cacheKey',
    );
    const errorCode = exported<(status: number) => string>(module, 'providerErrorCode');
    expect(normalize('  nature   walk  '.repeat(20))).toHaveLength(120);
    expect(key({ category: 'nature', query: '  Trees  ' })).toBe(
      key({ category: 'nature', query: 'trees' }),
    );
    expect(key({ category: 'nature', query: 'trees' })).not.toBe(
      key({ category: 'technology', query: 'trees' }),
    );
    expect(errorCode(429)).toBe('UNAVAILABLE');
    expect(errorCode(503)).toBe('UNAVAILABLE');
  });
});
