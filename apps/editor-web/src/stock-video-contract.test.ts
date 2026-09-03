import { describe, expect, it } from 'vitest';
import {
  browserStockVideo,
  browserStockVideoImport,
  browserStockVideoPage,
} from './browser-projections.js';
import { BrowserControlPlaneClient, STOCK_VIDEO_CATEGORIES } from './control-plane-client.js';

const card = {
  id: 'pexels-123',
  category: 'technology',
  title: 'Circuit board',
  provider: 'pexels',
  creator: 'JOY creator',
  sourcePageUrl: 'https://www.pexels.com/video/circuit-board-123/',
  durationUs: 8_000_000,
  width: 1280,
  height: 720,
  orientation: 'landscape',
};

describe('stock video browser projection', () => {
  it('accepts normalized cards and exactly eight bounded category counts', () => {
    const counts = Object.fromEntries(STOCK_VIDEO_CATEGORIES.map(({ id }) => [id, 6]));
    expect(browserStockVideoPage({ items: [card], counts })).toMatchObject({
      items: [card],
      counts: { technology: 6 },
    });
  });

  it('rejects unsafe source links and mismatched orientation', () => {
    expect(() =>
      browserStockVideo({ ...card, sourcePageUrl: 'http://provider.test/card' }),
    ).toThrow('invalid stock video response');
    expect(() => browserStockVideo({ ...card, width: 720, height: 1280 })).toThrow(
      'invalid stock video response',
    );
  });

  it('normalizes the API seconds projection and per-category count', () => {
    expect(
      browserStockVideoPage(
        {
          items: [{ ...card, category: undefined, durationUs: undefined, durationSeconds: 8.25 }],
          count: 6,
        },
        'technology',
      ),
    ).toMatchObject({
      items: [{ category: 'technology', durationUs: 8_250_000 }],
      counts: { technology: 6 },
    });
  });

  it('requires a completed import to include the returned owned asset', () => {
    expect(() => browserStockVideoImport({ importId: 'import-1', state: 'completed' })).toThrow();
    expect(
      browserStockVideoImport({ importId: 'import-1', state: 'completed', assetId: 'asset-1' }),
    ).toMatchObject({ state: 'completed', assetId: 'asset-1' });
    expect(
      browserStockVideoImport({ importId: 'import-1', state: 'failed', errorCode: 'RETRY' }),
    ).toMatchObject({
      state: 'failed',
      errorCode: 'RETRY',
    });
  });
});

describe('BrowserControlPlaneClient stock video routes', () => {
  it('keeps catalog discovery and media bytes on authenticated same-origin routes', async () => {
    const requests: Array<{ url: string; method?: string; authorization?: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method;
      const authorization = new Headers(init?.headers).get('authorization');
      requests.push({
        url,
        ...(method === undefined ? {} : { method }),
        ...(authorization === null ? {} : { authorization }),
      });
      if (url.endsWith('/poster') || url.endsWith('/preview')) return new Response(new Blob(['x']));
      const counts = Object.fromEntries(STOCK_VIDEO_CATEGORIES.map(({ id }) => [id, 6]));
      return new Response(JSON.stringify({ data: { items: [card], counts } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const client = new BrowserControlPlaneClient('https://media.joyteam.ir/api', () => 'token');
      await client.stockVideos('technology', ' circuit ');
      await client.stockVideoPoster('pexels-123');
      await client.stockVideoPreview('pexels-123');
    } finally {
      globalThis.fetch = original;
    }
    expect(requests).toEqual([
      {
        url: 'https://media.joyteam.ir/api/v1/library/stock-videos?category=technology&q=circuit',
        method: 'GET',
        authorization: 'Bearer token',
      },
      {
        url: 'https://media.joyteam.ir/api/v1/library/stock-videos/pexels-123/poster',
        method: 'GET',
        authorization: 'Bearer token',
      },
      {
        url: 'https://media.joyteam.ir/api/v1/library/stock-videos/pexels-123/preview',
        method: 'GET',
        authorization: 'Bearer token',
      },
    ]);
  });
});
