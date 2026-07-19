import { describe, expect, it } from 'vitest';
import { decodeWaveformPeaks, encodeWaveformPeaks } from './peaks.js';
describe('waveform peak format', () => {
  it('round trips compact min/max pairs', () => {
    const decoded = decodeWaveformPeaks(
      encodeWaveformPeaks([
        { min: -1, max: 0.5 },
        { min: -0.25, max: 1 },
      ]),
    );
    expect(decoded[0]!.min).toBe(-1);
    expect(decoded[0]!.max).toBeCloseTo(0.5, 4);
    expect(decoded[1]!.max).toBe(1);
  });
});
