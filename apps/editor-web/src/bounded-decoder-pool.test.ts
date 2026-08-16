import { describe, expect, it } from 'vitest';
import { BoundedDecoderPool } from './bounded-decoder-pool.js';

describe('BoundedDecoderPool', () => {
  it('evicts the least recently used decoder and disposes it', () => {
    const disposed: string[] = [];
    const pool = new BoundedDecoderPool<string, string>({
      maxEntries: 2,
      dispose: (value) => disposed.push(value),
    });
    pool.getOrCreate('a', () => 'decoder-a');
    pool.getOrCreate('b', () => 'decoder-b');
    expect(pool.get('a')).toBe('decoder-a');
    pool.getOrCreate('c', () => 'decoder-c');
    expect(pool.keys()).toEqual(['a', 'c']);
    expect(disposed).toEqual(['decoder-b']);
  });

  it('releases resources exactly once and clears the pool', () => {
    const disposed: string[] = [];
    const pool = new BoundedDecoderPool<string, string>({
      maxEntries: 3,
      dispose: (value) => disposed.push(value),
    });
    pool.getOrCreate('a', () => 'decoder-a');
    expect(pool.release('a')).toBe(true);
    expect(pool.release('a')).toBe(false);
    pool.getOrCreate('b', () => 'decoder-b');
    pool.getOrCreate('c', () => 'decoder-c');
    pool.clear();
    expect(disposed).toEqual(['decoder-a', 'decoder-b', 'decoder-c']);
    expect(pool.size).toBe(0);
  });
});
