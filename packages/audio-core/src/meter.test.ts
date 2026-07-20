import { describe, expect, it } from 'vitest';
import { computeMeter } from './meter.js';

describe('audio meter', () => {
  it('computes peak and RMS for simple signal', () => {
    const samples = new Float32Array([0.5, -0.5, 0.3, -0.3]);
    const meter = computeMeter(samples);

    expect(meter.peak).toBe(0.5);
    expect(meter.peakDb).toBeCloseTo(20 * Math.log10(0.5), 2);
    expect(meter.clipping).toBe(false);

    const expectedRms = Math.sqrt((0.5 * 0.5 + 0.5 * 0.5 + 0.3 * 0.3 + 0.3 * 0.3) / 4);
    expect(meter.rms).toBeCloseTo(expectedRms, 5);
  });

  it('detects clipping', () => {
    const samples = new Float32Array([0.5, 1.0, -1.5]);
    const meter = computeMeter(samples);

    expect(meter.peak).toBe(1.5);
    expect(meter.clipping).toBe(true);
  });

  it('handles silence', () => {
    const samples = new Float32Array([0, 0, 0]);
    const meter = computeMeter(samples);

    expect(meter.peak).toBe(0);
    expect(meter.rms).toBe(0);
    expect(meter.clipping).toBe(false);
  });

  it('handles full-scale signal', () => {
    const samples = new Float32Array([1.0, -1.0, 1.0, -1.0]);
    const meter = computeMeter(samples);

    expect(meter.peak).toBe(1.0);
    expect(meter.rms).toBe(1.0);
    expect(meter.clipping).toBe(true);
  });

  it('computes correct RMS for constant signal', () => {
    const samples = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    const meter = computeMeter(samples);

    expect(meter.rms).toBeCloseTo(0.5, 5);
  });
});
