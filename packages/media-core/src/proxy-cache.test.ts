import { describe, expect, it } from 'vitest';
import { ProxyCache } from './proxy-cache.js';
describe('proxy cache', () => {
  it('deduplicates, profiles, and invalidates source requests', () => {
    const cache = new ProxyCache();
    const low = { maxHeight: 540, videoCodec: 'h264', audioCodec: 'aac' } as const;
    const request = cache.request('sha256:source', low);
    cache.store(request, 'proxy-1');
    expect(cache.lookup('sha256:source', low)).toBe('proxy-1');
    expect(cache.lookup('sha256:source', { ...low, maxHeight: 720 })).toBeUndefined();
    expect(cache.request('sha256:source', low).idempotencyKey).toBe(request.idempotencyKey);
    cache.invalidateSource('sha256:source');
    expect(cache.lookup('sha256:source', low)).toBeUndefined();
  });
});
