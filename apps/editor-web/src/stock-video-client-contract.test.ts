import { describe, expect, it } from 'vitest';
import { BrowserControlPlaneClient } from './control-plane-client.js';

describe('stock-video browser client contract', () => {
  it('exposes read-only catalog/poster/preview and idempotent import polling methods', () => {
    const prototype = BrowserControlPlaneClient.prototype as unknown as Record<string, unknown>;
    for (const method of [
      'stockVideos',
      'stockVideoPoster',
      'stockVideoPreview',
      'startStockVideoImport',
      'stockVideoImportStatus',
    ]) {
      expect(typeof prototype[method], `${method} must be implemented`).toBe('function');
    }
  });

  it('does not expose provider keys, mutable media URLs, object refs, or local paths in cards', async () => {
    const prototype = BrowserControlPlaneClient.prototype as unknown as Record<string, unknown>;
    const method = prototype.stockVideos;
    if (typeof method !== 'function')
      throw new Error('stockVideos must be implemented before projection leakage can be checked');
    const client = new BrowserControlPlaneClient('/api', () => 'fixture-token');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            items: [
              {
                id: 'pexels-1',
                title: 'Fixture',
                category: 'nature',
                durationUs: 10_000_000,
                width: 1280,
                height: 720,
                orientation: 'landscape',
                provider: 'pexels',
                creator: 'Fixture creator',
                sourcePageUrl: 'https://www.pexels.com/video/1/',
              },
            ],
            counts: {
              'business-work': 0,
              technology: 0,
              'people-lifestyle': 0,
              nature: 1,
              'travel-places': 0,
              'city-transport': 0,
              'food-drink': 0,
              'abstract-backgrounds': 0,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    try {
      const cards = await (
        method as (this: BrowserControlPlaneClient, ...args: unknown[]) => Promise<unknown>
      ).call(client, 'nature');
      const serialized = JSON.stringify(cards);
      expect(serialized).not.toMatch(
        /api[-_]?key|authorization|object-store|(?:[A-Za-z]:\\|\/opt\/)/i,
      );
      expect(serialized).not.toContain('videos.pexels.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
