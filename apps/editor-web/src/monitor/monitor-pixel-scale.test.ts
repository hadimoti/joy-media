import { describe, expect, it } from 'vitest';
import { monitorPixelScale } from './monitor-pixel-scale.js';

describe('monitorPixelScale', () => {
  it('is quality x screen pixel ratio', () => {
    expect(monitorPixelScale('full', 1)).toBe(1);
    expect(monitorPixelScale('full', 1.25)).toBe(1.25);
    expect(monitorPixelScale('full', 2)).toBe(2);
    expect(monitorPixelScale('half', 1.25)).toBe(0.625);
    expect(monitorPixelScale('quarter', 2)).toBe(0.5);
  });

  it('gives one device pixel per CSS pixel at full quality on a 1x screen', () => {
    expect(monitorPixelScale('full', 1)).toBe(1);
  });

  it('treats a missing or broken pixel ratio as 1 and keeps the 0.1 floor', () => {
    expect(monitorPixelScale('half', 0)).toBe(0.5);
    expect(monitorPixelScale('half', Number.NaN)).toBe(0.5);
    expect(monitorPixelScale('quarter', 0.2)).toBe(0.1);
  });
});
