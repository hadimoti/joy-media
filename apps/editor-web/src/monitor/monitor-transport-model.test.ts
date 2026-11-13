import { describe, expect, it } from 'vitest';
import {
  JKL_IDLE,
  METER_CLIP_HOLD_MS,
  clipHoldUntil,
  isClipHeld,
  jklSpeed,
  jklSpeedTable,
  jklUsesEnginePlayback,
  meterFill,
  nextJklState,
  rangeEndAction,
  withInPoint,
  withOutPoint,
  type JklState,
  type RangeEndInput,
} from './monitor-transport-model.js';

function press(keys: string): JklState {
  return [...keys].reduce<JklState>(
    (state, key) => nextJklState(state, key as 'j' | 'k' | 'l'),
    JKL_IDLE,
  );
}

describe('J K L speed table', () => {
  it('has the speeds 1, 2, 4 and 8', () => {
    expect(jklSpeedTable()).toEqual([1, 2, 4, 8]);
  });

  it('doubles the speed on repeated L and stops at 8x', () => {
    const speeds = [0, 1, 2, 3, 4, 5].map((count) => jklSpeed(press('l'.repeat(count))));
    expect(speeds).toEqual([0, 1, 2, 4, 8, 8]);
  });

  it('reverses with J and doubles the same way', () => {
    expect(jklSpeed(press('j'))).toBe(1);
    expect(jklSpeed(press('jj'))).toBe(2);
    expect(jklSpeed(press('jjjj'))).toBe(8);
    expect(jklSpeed(press('jjjjj'))).toBe(8);
    expect(press('jj').direction).toBe(-1);
  });

  it('switches direction and restarts at 1x when the key changes', () => {
    expect(press('lll')).toEqual({ direction: 1, level: 2 });
    expect(press('llll')).toEqual({ direction: 1, level: 3 });
    expect(press('lllj')).toEqual({ direction: -1, level: 0 });
    expect(jklSpeed(press('lllj'))).toBe(1);
  });

  it('K stops at once from any speed', () => {
    expect(press('llllk')).toEqual(JKL_IDLE);
    expect(press('jjjk')).toEqual(JKL_IDLE);
    expect(jklSpeed(press('k'))).toBe(0);
  });

  it('lets the engine play only at 1x forward', () => {
    expect(jklUsesEnginePlayback(press('l'))).toBe(true);
    expect(jklUsesEnginePlayback(press('ll'))).toBe(false);
    expect(jklUsesEnginePlayback(press('j'))).toBe(false);
    expect(jklUsesEnginePlayback(JKL_IDLE)).toBe(false);
  });
});

describe('in and out points', () => {
  it('sets an in point and an out point', () => {
    const marks = withOutPoint(withInPoint({}, 1_000_000), 3_000_000);
    expect(marks).toEqual({ inUs: 1_000_000, outUs: 3_000_000 });
  });

  it('drops an out point that falls at or before the in point', () => {
    expect(withInPoint({ outUs: 2_000_000 }, 2_000_000)).toEqual({ inUs: 2_000_000 });
    expect(withInPoint({ outUs: 2_000_000 }, 3_000_000)).toEqual({ inUs: 3_000_000 });
  });

  it('drops an in point that falls at or after the out point', () => {
    expect(withOutPoint({ inUs: 2_000_000 }, 1_000_000)).toEqual({ outUs: 1_000_000 });
    expect(withOutPoint({ inUs: 2_000_000 }, 2_000_000)).toEqual({ outUs: 2_000_000 });
  });

  it('never stores a negative point', () => {
    expect(withInPoint({}, -5)).toEqual({ inUs: 0 });
  });
});

describe('range end while playing', () => {
  const base: RangeEndInput = {
    playing: true,
    playheadUs: 2_500_000,
    marks: { inUs: 1_000_000, outUs: 2_000_000 },
    loop: false,
    rangeRun: false,
    durationUs: 10_000_000,
  };

  it('does nothing when not playing', () => {
    expect(rangeEndAction({ ...base, playing: false, loop: true })).toBe('none');
  });

  it('treats a plain out point as a marker', () => {
    expect(rangeEndAction(base)).toBe('none');
  });

  it('wraps to the in point at the out point when looping', () => {
    expect(rangeEndAction({ ...base, loop: true })).toBe('wrap');
    expect(rangeEndAction({ ...base, loop: true, playheadUs: 1_999_999 })).toBe('none');
  });

  it('stops at the out point during play in to out', () => {
    expect(rangeEndAction({ ...base, rangeRun: true })).toBe('stop');
  });

  it('uses the timeline end as the out point when none is set', () => {
    const noOut = { ...base, marks: {}, rangeRun: true, playheadUs: 10_000_000 };
    expect(rangeEndAction(noOut)).toBe('stop');
    expect(rangeEndAction({ ...noOut, playheadUs: 9_000_000 })).toBe('none');
  });
});

describe('audio meter', () => {
  it('maps dBFS to a bar fill from -60 to 0', () => {
    expect(meterFill(-60)).toBe(0);
    expect(meterFill(0)).toBe(1);
    expect(meterFill(-30)).toBeCloseTo(0.5, 10);
    expect(meterFill(-100)).toBe(0);
    expect(meterFill(6)).toBe(1);
    expect(meterFill(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('holds the clip mark for two seconds after a clipped sample', () => {
    const until = clipHoldUntil(0, true, 1_000);
    expect(until).toBe(1_000 + METER_CLIP_HOLD_MS);
    expect(isClipHeld(until, 1_000 + METER_CLIP_HOLD_MS - 1)).toBe(true);
    expect(isClipHeld(until, 1_000 + METER_CLIP_HOLD_MS)).toBe(false);
  });

  it('keeps an earlier hold when the next sample is not clipped', () => {
    expect(clipHoldUntil(5_000, false, 2_000)).toBe(5_000);
  });
});
