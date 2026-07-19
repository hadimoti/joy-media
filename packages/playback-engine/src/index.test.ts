import { describe, expect, it } from 'vitest';
import { FrameCache, PlaybackScheduler } from './index.js';
describe('playback scheduler', () => {
  it('cancels stale requests, tracks drops, and switches to proxy quality', () => {
    const scheduler = new PlaybackScheduler();
    const stale = scheduler.requestToken();
    scheduler.seek(1_000_000);
    expect(scheduler.acceptFrame(stale, true)).toBe(false);
    const active = scheduler.requestToken();
    scheduler.acceptFrame(active, false);
    scheduler.acceptFrame(active, false);
    scheduler.acceptFrame(active, false);
    expect(scheduler.droppedFrames).toBe(3);
    expect(scheduler.quality()).toBe('proxy');
    expect(scheduler.metrics).toEqual({ decodedFrames: 3, droppedFrames: 3, quality: 'proxy' });
  });
  it('bounds decoded frames with LRU promotion', () => {
    const cache = new FrameCache(2);
    cache.put({ assetId: 'a', sourceTimeUs: 0, token: 'a' });
    cache.put({ assetId: 'b', sourceTimeUs: 0, token: 'b' });
    cache.get('a', 0);
    cache.put({ assetId: 'c', sourceTimeUs: 0, token: 'c' });
    expect(cache.get('b', 0)).toBeUndefined();
    expect(cache.get('a', 0)?.token).toBe('a');
  });
});
