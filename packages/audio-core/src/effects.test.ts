import { describe, expect, it } from 'vitest';
import { applyEq, applyCompressor, applyLimiter, applyGate } from './effects.js';

describe('audio effects', () => {
  describe('applyEq', () => {
    it('applies lowpass filter', () => {
      const sampleRate = 48000;
      const samples = new Float32Array(4800);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
      }

      const output = applyEq(
        samples,
        [{ frequency: 500, gain: 0, q: 1, type: 'lowpass' }],
        sampleRate,
      );
      expect(output.length).toBe(samples.length);

      const inputRms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
      const outputRms = Math.sqrt(output.reduce((sum, s) => sum + s * s, 0) / output.length);
      expect(outputRms).toBeLessThan(inputRms * 0.5);
    });

    it('applies highpass filter', () => {
      const sampleRate = 48000;
      const samples = new Float32Array(4800);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * 100 * i) / sampleRate);
      }

      const output = applyEq(
        samples,
        [{ frequency: 1000, gain: 0, q: 1, type: 'highpass' }],
        sampleRate,
      );
      expect(output.length).toBe(samples.length);

      const inputRms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
      const outputRms = Math.sqrt(output.reduce((sum, s) => sum + s * s, 0) / output.length);
      expect(outputRms).toBeLessThan(inputRms * 0.5);
    });

    it('applies peaking EQ boost', () => {
      const sampleRate = 48000;
      const samples = new Float32Array(4800);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
      }

      const output = applyEq(
        samples,
        [{ frequency: 1000, gain: 6, q: 1, type: 'peaking' }],
        sampleRate,
      );
      expect(output.length).toBe(samples.length);

      const inputRms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
      const outputRms = Math.sqrt(output.reduce((sum, s) => sum + s * s, 0) / output.length);
      expect(outputRms).toBeGreaterThan(inputRms);
    });

    it('applies multiple bands', () => {
      const sampleRate = 48000;
      const samples = new Float32Array(4800).fill(0.5);

      const output = applyEq(
        samples,
        [
          { frequency: 100, gain: 0, q: 1, type: 'lowpass' },
          { frequency: 1000, gain: 3, q: 1, type: 'peaking' },
        ],
        sampleRate,
      );

      expect(output.length).toBe(samples.length);
    });
  });

  describe('applyCompressor', () => {
    it('reduces gain above threshold', () => {
      const sampleRate = 48000;
      const samples = new Float32Array(4800);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * 100 * i) / sampleRate) * 0.8;
      }

      const output = applyCompressor(
        samples,
        { threshold: -20, ratio: 4, attackUs: 1000, releaseUs: 10000, knee: 6 },
        sampleRate,
      );

      expect(output.length).toBe(samples.length);

      const inputPeak = Math.max(...Array.from(samples).map(Math.abs));
      const outputPeak = Math.max(...Array.from(output).map(Math.abs));
      expect(outputPeak).toBeLessThan(inputPeak);
    });

    it('preserves signal below threshold', () => {
      const sampleRate = 48000;
      const samples = new Float32Array(4800);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * 100 * i) / sampleRate) * 0.1;
      }

      const output = applyCompressor(
        samples,
        { threshold: -20, ratio: 4, attackUs: 1000, releaseUs: 10000, knee: 6 },
        sampleRate,
      );

      const inputRms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
      const outputRms = Math.sqrt(output.reduce((sum, s) => sum + s * s, 0) / output.length);
      expect(outputRms).toBeCloseTo(inputRms, 1);
    });
  });

  describe('applyLimiter', () => {
    it('prevents samples from exceeding ceiling', () => {
      const sampleRate = 48000;
      const samples = new Float32Array(4800);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * 100 * i) / sampleRate) * 1.5;
      }

      const output = applyLimiter(samples, -1, 10000, sampleRate);
      const ceiling = Math.pow(10, -1 / 20);

      const outputPeak = Math.max(...Array.from(output).map(Math.abs));
      expect(outputPeak).toBeLessThanOrEqual(ceiling * 1.01);
    });

    it('passes signal below ceiling unchanged', () => {
      const sampleRate = 48000;
      const samples = new Float32Array(4800);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * 100 * i) / sampleRate) * 0.5;
      }

      const output = applyLimiter(samples, -1, 10000, sampleRate);
      const inputRms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
      const outputRms = Math.sqrt(output.reduce((sum, s) => sum + s * s, 0) / output.length);
      expect(outputRms).toBeCloseTo(inputRms, 1);
    });
  });

  describe('applyGate', () => {
    it('attenuates signal below threshold', () => {
      const sampleRate = 48000;
      const samples = new Float32Array(4800);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * 100 * i) / sampleRate) * 0.01;
      }

      const output = applyGate(
        samples,
        { threshold: -40, attackUs: 100, releaseUs: 1000, holdUs: 10000 },
        sampleRate,
      );

      const inputRms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
      const outputRms = Math.sqrt(output.reduce((sum, s) => sum + s * s, 0) / output.length);
      expect(outputRms).toBeLessThan(inputRms * 0.5);
    });

    it('passes signal above threshold', () => {
      const sampleRate = 48000;
      const samples = new Float32Array(4800);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * 100 * i) / sampleRate) * 0.5;
      }

      const output = applyGate(
        samples,
        { threshold: -40, attackUs: 100, releaseUs: 1000, holdUs: 10000 },
        sampleRate,
      );

      const inputRms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
      const outputRms = Math.sqrt(output.reduce((sum, s) => sum + s * s, 0) / output.length);
      expect(outputRms).toBeCloseTo(inputRms, 1);
    });
  });
});
