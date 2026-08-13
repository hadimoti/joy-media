import { describe, expect, it } from 'vitest';
import {
  copyPropertyKeys,
  filterPropertyLanes,
  groupPropertyLanes,
  pastePropertyKeys,
  setPropertyInterpolation,
  snapPropertyTime,
} from './property-lane-model.js';
import { visiblePropertyKeys } from './TimelinePropertyLanes.js';

describe('advanced property lane model', () => {
  const lane = {
    id: 'clip::composition::x',
    ownerId: 'clip',
    ownerLabel: 'Clip A',
    domain: 'composition' as const,
    propertyId: 'x',
    label: 'Position X',
    modified: true,
    keys: [
      { timeUs: 0, value: 0, interpolation: 'linear' },
      { timeUs: 1_000_000, value: 10, interpolation: 'linear' },
    ],
  };

  it('groups by owner and time domain and supports explicit filters', () => {
    expect(groupPropertyLanes([lane])[0]?.label).toBe('Clip A · composition');
    expect(filterPropertyLanes([lane], { showAnimated: true, showModified: true })).toEqual([lane]);
    expect(filterPropertyLanes([{ ...lane, modified: false }], { showModified: true })).toEqual([]);
  });

  it('snaps normally and preserves alt override precision', () => {
    expect(snapPropertyTime(49_000, 33_333)).toBe(33_333);
    expect(snapPropertyTime(49_000, 33_333, true)).toBe(49_000);
  });

  it('copies, atomically pastes, and changes interpolation for selected keys', () => {
    const clipboard = copyPropertyKeys(lane, [0, 1_000_000]);
    const pasted = pastePropertyKeys(lane, clipboard, 2_000_000, 33_333);
    expect(pasted.map((key) => key.timeUs)).toEqual([0, 1_000_000, 1_999_980, 2_999_980]);
    expect(setPropertyInterpolation(pasted, [1_999_980], 'hold').at(-2)?.interpolation).toBe(
      'hold',
    );
  });

  it('keeps a 50k-key window bounded to the requested interval', () => {
    const keys = Array.from({ length: 50_000 }, (_, index) => ({
      timeUs: index * 10_000,
      value: index,
    }));
    const start = 200_000_000;
    const end = 201_000_000;
    expect(visiblePropertyKeys(keys, start, end, 0)).toHaveLength(101);
  });
});
