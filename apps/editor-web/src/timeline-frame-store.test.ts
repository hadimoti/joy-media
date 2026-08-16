import { describe, expect, it } from 'vitest';
import { BoundedFrameStore } from './timeline-frame-store.js';

describe('BoundedFrameStore', () => {
  it('coalesces stale source requests and keeps the newest value', () => {
    const store = new BoundedFrameStore<string, { bytes: number }>({
      maxEntries: 4,
      maxBytes: 100,
      estimateBytes: (value) => value.bytes,
    });
    const first = store.beginRequest('clip-a');
    const second = store.beginRequest('clip-a');
    expect(store.put('clip-a', { bytes: 2 }, first)).toBe(false);
    expect(store.put('clip-a', { bytes: 3 }, second)).toBe(true);
    expect(store.get('clip-a')).toEqual({ bytes: 3 });
  });

  it('evicts by entry and byte limits and reports resource totals', () => {
    const evicted: string[] = [];
    const store = new BoundedFrameStore<string, { bytes: number }>({
      maxEntries: 2,
      maxBytes: 5,
      estimateBytes: (value) => value.bytes,
      onEvict: (key) => evicted.push(key),
    });
    store.put('a', { bytes: 3 });
    store.put('b', { bytes: 2 });
    store.put('c', { bytes: 2 });
    expect([...store.keys()]).toEqual(['b', 'c']);
    expect(store.totalBytes).toBe(4);
    expect(evicted).toEqual(['a']);
  });
});
