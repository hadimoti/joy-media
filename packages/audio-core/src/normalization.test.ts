import { describe, expect, it } from 'vitest';
import { normalizeDialogue } from './normalization.js';

describe('dialogue normalization', () => {
  function generateSineWave(
    frequency: number,
    amplitude: number,
    duration: number,
    sampleRate: number,
  ): Float32Array {
    const samples = new Float32Array(sampleRate * duration);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude;
    }
    return samples;
  }

  describe('normalizeDialogue', () => {
    it('reaches target loudness within tolerance', () => {
      const sampleRate = 48000;
      const samples = generateSineWave(1000, 0.3, 5, sampleRate);
      const config = {
        targetLoudness: -16,
        targetPeak: -1.0,
        mode: 'normalize' as const,
      };

      const { result } = normalizeDialogue(samples, sampleRate, config);

      expect(result.outputLoudness).toBeCloseTo(-16, 0);
      expect(result.processing).toBe('normalize');
    });

    it('respects peak limits in normalize mode', () => {
      const sampleRate = 48000;
      const samples = generateSineWave(1000, 0.8, 5, sampleRate);
      const config = {
        targetLoudness: -10,
        targetPeak: -3.0,
        mode: 'normalize' as const,
      };

      const { result } = normalizeDialogue(samples, sampleRate, config);

      expect(result.outputPeak).toBeLessThanOrEqual(-3.0 + 1.0);
    });

    it('applies compression in compress mode', () => {
      const sampleRate = 48000;
      const samples = generateSineWave(1000, 0.8, 5, sampleRate);
      const config = {
        targetLoudness: -16,
        targetPeak: -3.0,
        mode: 'compress' as const,
      };

      const { result } = normalizeDialogue(samples, sampleRate, config);

      expect(result.processing).toBe('compress');
      expect(result.outputPeak).toBeLessThanOrEqual(-2.0);
    });

    it('applies limiting in limit mode', () => {
      const sampleRate = 48000;
      const samples = generateSineWave(1000, 0.9, 5, sampleRate);
      const config = {
        targetLoudness: -14,
        targetPeak: -1.0,
        mode: 'limit' as const,
      };

      const { result } = normalizeDialogue(samples, sampleRate, config);

      expect(result.processing).toBe('limit');
      expect(result.outputPeak).toBeLessThanOrEqual(0);
    });

    it('returns accurate input measurements', () => {
      const sampleRate = 48000;
      const samples = generateSineWave(1000, 0.5, 5, sampleRate);
      const config = {
        targetLoudness: -16,
        targetPeak: -1.0,
        mode: 'normalize' as const,
      };

      const { result } = normalizeDialogue(samples, sampleRate, config);

      expect(result.inputLoudness).toBeLessThan(0);
      expect(result.inputLoudness).toBeGreaterThan(-50);
      expect(result.inputPeak).toBeLessThan(0);
    });

    it('calculates correct gain adjustment', () => {
      const sampleRate = 48000;
      const samples = generateSineWave(1000, 0.3, 5, sampleRate);
      const config = {
        targetLoudness: -16,
        targetPeak: -1.0,
        mode: 'normalize' as const,
      };

      const { result } = normalizeDialogue(samples, sampleRate, config);

      expect(result.gainAdjustment).toBeLessThan(1.0);
    });

    it('handles quiet audio needing boost', () => {
      const sampleRate = 48000;
      const samples = generateSineWave(1000, 0.1, 5, sampleRate);
      const config = {
        targetLoudness: -16,
        targetPeak: -1.0,
        mode: 'normalize' as const,
      };

      const { result } = normalizeDialogue(samples, sampleRate, config);

      expect(result.gainAdjustment).toBeGreaterThan(2.0);
      expect(result.outputLoudness).toBeCloseTo(-16, 0);
    });

    it('handles loud audio needing attenuation', () => {
      const sampleRate = 48000;
      const samples = generateSineWave(1000, 0.9, 5, sampleRate);
      const config = {
        targetLoudness: -23,
        targetPeak: -1.0,
        mode: 'normalize' as const,
      };

      const { result } = normalizeDialogue(samples, sampleRate, config);

      expect(result.gainAdjustment).toBeLessThan(1.0);
      expect(result.outputLoudness).toBeCloseTo(-23, 0);
    });
  });
});
