import { describe, expect, it } from 'vitest';
import {
  MONITOR_DEFAULT_FPS,
  formatMonitorTimecode,
  frameIndexToUs,
  monitorFps,
  parseMonitorTimecode,
  stepFrameUs,
  usToFrameIndex,
} from './monitor-timecode.js';

const RATES = [24, 25, 30, 60] as const;

describe('monitorFps', () => {
  it('reads a rational rate and falls back for a missing or broken one', () => {
    expect(monitorFps({ num: 30, den: 1 })).toBe(30);
    expect(monitorFps({ num: 30000, den: 1001 })).toBeCloseTo(29.97, 2);
    expect(monitorFps(undefined)).toBe(MONITOR_DEFAULT_FPS);
    expect(monitorFps({ num: 0, den: 1 })).toBe(MONITOR_DEFAULT_FPS);
  });
});

describe('formatMonitorTimecode', () => {
  it.each(RATES)('formats whole seconds and frames at %i fps', (fps) => {
    expect(formatMonitorTimecode(0, fps)).toBe('00:00:00:00');
    expect(formatMonitorTimecode(1_000_000, fps)).toBe('00:00:01:00');
    expect(formatMonitorTimecode(61_000_000, fps)).toBe('00:01:01:00');
    expect(formatMonitorTimecode(3_600_000_000, fps)).toBe('01:00:00:00');
  });

  it('shows the last frame of a second as the fraction counts it', () => {
    expect(formatMonitorTimecode(frameIndexToUs(23, 24), 24)).toBe('00:00:00:23');
    expect(formatMonitorTimecode(frameIndexToUs(59, 60), 60)).toBe('00:00:00:59');
    expect(formatMonitorTimecode(frameIndexToUs(29, 30), 30)).toBe('00:00:00:29');
    expect(formatMonitorTimecode(frameIndexToUs(24, 25), 25)).toBe('00:00:00:24');
  });
});

describe('parseMonitorTimecode', () => {
  it.each(RATES)('reads mm:ss:ff and frame numbers at %i fps', (fps) => {
    expect(parseMonitorTimecode('00:01:00', fps)).toBe(1_000_000);
    expect(parseMonitorTimecode('00:02:00', fps)).toBe(2_000_000);
    expect(parseMonitorTimecode(`0:0:0:${fps - 1}`, fps)).toBe(frameIndexToUs(fps - 1, fps));
    expect(parseMonitorTimecode(String(fps), fps)).toBe(1_000_000);
    expect(parseMonitorTimecode('01:00:00:00', fps)).toBe(3_600_000_000);
  });

  it.each(RATES)('round-trips format and parse at %i fps', (fps) => {
    for (const us of [0, 1_000_000, 12_345_000, 61_500_000]) {
      const frame = usToFrameIndex(us, fps);
      const text = formatMonitorTimecode(us, fps);
      expect(parseMonitorTimecode(text, fps)).toBe(frameIndexToUs(frame, fps));
    }
  });

  it('refuses a frame at or above the frame count of one second', () => {
    expect(parseMonitorTimecode('00:00:00:24', 24)).toBeUndefined();
    expect(parseMonitorTimecode('00:00:00:30', 30)).toBeUndefined();
    expect(parseMonitorTimecode('00:00:00:60', 60)).toBeUndefined();
    expect(parseMonitorTimecode('00:00:00:25', 25)).toBeUndefined();
  });

  it('refuses seconds or hour minutes of 60 or more and malformed text', () => {
    expect(parseMonitorTimecode('00:60:00', 30)).toBeUndefined();
    expect(parseMonitorTimecode('01:60:00:00', 30)).toBeUndefined();
    expect(parseMonitorTimecode('abc', 30)).toBeUndefined();
    expect(parseMonitorTimecode('', 30)).toBeUndefined();
    expect(parseMonitorTimecode('1:2:3:4:5', 30)).toBeUndefined();
    expect(parseMonitorTimecode('-1', 30)).toBeUndefined();
    expect(parseMonitorTimecode('00:00:01.5', 30)).toBeUndefined();
  });
});

describe('stepFrameUs', () => {
  it('moves exactly one second in 30 steps at 30 fps', () => {
    let position = 0;
    for (let step = 0; step < 30; step++) position = stepFrameUs(position, 1, 30, 10_000_000);
    expect(position).toBe(1_000_000);
    for (let step = 0; step < 30; step++) position = stepFrameUs(position, -1, 30, 10_000_000);
    expect(position).toBe(0);
  });

  it.each(RATES)('steps one frame at %i fps without drift', (fps) => {
    let position = 0;
    for (let step = 0; step < fps; step++) position = stepFrameUs(position, 1, fps, 10_000_000);
    expect(position).toBe(1_000_000);
  });

  it('clamps at zero and at the timeline end', () => {
    expect(stepFrameUs(0, -1, 30, 2_000_000)).toBe(0);
    expect(stepFrameUs(2_000_000, 1, 30, 2_000_000)).toBe(2_000_000);
    expect(stepFrameUs(0, 1, 30, 0)).toBe(0);
  });
});
