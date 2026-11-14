import { describe, expect, it } from 'vitest';
import { readPlayheadMemory, writePlayheadMemory } from './playhead-memory.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe('playhead memory (a reopened project keeps its playhead)', () => {
  it('returns what was written, per project', () => {
    const storage = memoryStorage();
    writePlayheadMemory(storage, 'a', 25_100_000);
    writePlayheadMemory(storage, 'b', 3_000_000);
    expect(readPlayheadMemory(storage, 'a')).toBe(25_100_000);
    expect(readPlayheadMemory(storage, 'b')).toBe(3_000_000);
    expect(readPlayheadMemory(storage, 'c')).toBeUndefined();
  });

  it('ignores a zero, a negative or a garbled value', () => {
    const storage = memoryStorage();
    storage.setItem('joy-media.playhead.v1.z', '0');
    storage.setItem('joy-media.playhead.v1.n', '-5');
    storage.setItem('joy-media.playhead.v1.g', 'abc');
    expect(readPlayheadMemory(storage, 'z')).toBeUndefined();
    expect(readPlayheadMemory(storage, 'n')).toBeUndefined();
    expect(readPlayheadMemory(storage, 'g')).toBeUndefined();
  });

  it('never throws when the storage is blocked', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readPlayheadMemory(blocked, 'a')).toBeUndefined();
    expect(() => writePlayheadMemory(blocked, 'a', 1)).not.toThrow();
  });
});
