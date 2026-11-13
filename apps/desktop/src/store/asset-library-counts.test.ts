import { describe, expect, it } from 'vitest';
import {
  countLibraryAssets,
  countsAddUp,
  countsFromStoredCounts,
  EMPTY_ASSET_LIBRARY_COUNTS,
} from './asset-library-counts.js';

describe('asset library counts', () => {
  it('counts each kind and adds up to the total', () => {
    const counts = countLibraryAssets([
      { kind: 'video' },
      { kind: 'video' },
      { kind: 'image' },
      { kind: 'audio' },
    ]);

    expect(counts).toEqual({ total: 4, video: 2, image: 1, audio: 1, other: 0 });
    expect(countsAddUp(counts)).toBe(true);
  });

  it('puts kinds it does not name into "other", so the numbers still add up', () => {
    const counts = countLibraryAssets([{ kind: 'video' }, { kind: 'model' }, { kind: 'font' }]);

    expect(counts.other).toBe(2);
    expect(countsAddUp(counts)).toBe(true);
  });

  it('counts an empty library as nothing at all', () => {
    expect(countLibraryAssets([])).toEqual(EMPTY_ASSET_LIBRARY_COUNTS);
    expect(countsAddUp(EMPTY_ASSET_LIBRARY_COUNTS)).toBe(true);
  });

  it('reads a stored count block and keeps the numbers adding up', () => {
    const counts = countsFromStoredCounts({ total: 9, audio: 3, image: 2, video: 1 });

    expect(counts).toEqual({ total: 9, video: 1, image: 2, audio: 3, other: 3 });
    expect(countsAddUp(counts)).toBe(true);
  });

  it('treats a missing or broken count block as an empty library', () => {
    expect(countsFromStoredCounts(undefined)).toEqual(EMPTY_ASSET_LIBRARY_COUNTS);
    expect(countsFromStoredCounts({ total: 'many' })).toEqual(EMPTY_ASSET_LIBRARY_COUNTS);
    expect(countsAddUp(countsFromStoredCounts({ total: 'many' }))).toBe(true);
  });
});
