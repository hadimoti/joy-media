import { describe, expect, it } from 'vitest';
import { measurePeak, detectClipping, measureLoudness, detectSilence } from './analysis.js';

describe('audio analysis', () => {
  describe('measurePeak', () => {
    it('measures peak amplitude', () => {
      const samples = new Float32Array([0.5, -0.8, 0.3, -0.2]);
      const result = measurePeak(samples);
      expect(result.peak).toBeCloseTo(0.8, 6);
      expect(result.peakDb).toBeCloseTo(20 * Math.log10(0.8), 2);
      expect(result.clipping).toBe(false);
    });

    it('detects clipping at 1.0', () => {
      const samples = new Float32Array([0.5, 1.0, -0.5]);
      const result = measurePeak(samples);
      expect(result.peak).toBe(1.0);
      expect(result.clipping).toBe(true);
    });

    it('detects clipping above 1.0', () => {
      const samples = new Float32Array([0.5, 1.5, -0.5]);
      const result = measurePeak(samples);
      expect(result.peak).toBe(1.5);
      expect(result.clipping).toBe(true);
    });

    it('handles silence', () => {
      const samples = new Float32Array([0, 0, 0]);
      const result = measurePeak(samples);
      expect(result.peak).toBe(0);
      expect(result.clipping).toBe(false);
    });
  });

  describe('detectClipping', () => {
    it('detects no clipping', () => {
      const samples = new Float32Array([0.5, -0.8, 0.3]);
      const result = detectClipping(samples);
      expect(result.clipping).toBe(false);
      expect(result.clipCount).toBe(0);
      expect(result.clipPositions).toEqual([]);
    });

    it('detects single clip', () => {
      const samples = new Float32Array([0.5, 1.0, -0.5]);
      const result = detectClipping(samples);
      expect(result.clipping).toBe(true);
      expect(result.clipCount).toBe(1);
      expect(result.clipPositions).toEqual([1]);
    });

    it('detects multiple clips', () => {
      const samples = new Float32Array([1.0, 0.5, -1.0, 1.5]);
      const result = detectClipping(samples);
      expect(result.clipping).toBe(true);
      expect(result.clipCount).toBe(3);
      expect(result.clipPositions).toEqual([0, 2, 3]);
    });
  });

  describe('measureLoudness', () => {
    it('measures integrated loudness for sine wave', () => {
      const sampleRate = 48000;
      const duration = 10;
      const samples = new Float32Array(sampleRate * duration);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * 0.5;
      }

      const result = measureLoudness(samples, sampleRate);
      expect(result.integrated).toBeLessThan(0);
      expect(result.integrated).toBeGreaterThan(-50);
      expect(result.shortTerm).toBeDefined();
      expect(result.range).toBeDefined();
    });

    it('higher amplitude produces higher loudness', () => {
      const sampleRate = 48000;
      const duration = 5;

      const samples1 = new Float32Array(sampleRate * duration);
      const samples2 = new Float32Array(sampleRate * duration);

      for (let i = 0; i < samples1.length; i++) {
        samples1[i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * 0.3;
        samples2[i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * 0.6;
      }

      const result1 = measureLoudness(samples1, sampleRate);
      const result2 = measureLoudness(samples2, sampleRate);

      expect(result2.integrated).toBeGreaterThan(result1.integrated);
    });
  });

  describe('detectSilence', () => {
    it('detects no silence', () => {
      const samples = new Float32Array([0.5, -0.5, 0.3, -0.2]);
      const result = detectSilence(samples, -60);
      expect(result.silent).toBe(false);
      expect(result.silentRegions).toEqual([]);
    });

    it('detects silence at the start', () => {
      const samples = new Float32Array([0, 0, 0, 0.5, -0.5]);
      const result = detectSilence(samples, -60);
      expect(result.silent).toBe(false);
      expect(result.silentRegions.length).toBeGreaterThan(0);
      expect(result.silentRegions[0]!.start).toBe(0);
    });

    it('detects silence at the end', () => {
      const samples = new Float32Array([0.5, -0.5, 0, 0, 0]);
      const result = detectSilence(samples, -60);
      expect(result.silent).toBe(false);
      expect(result.silentRegions.length).toBeGreaterThan(0);
      const lastRegion = result.silentRegions[result.silentRegions.length - 1];
      expect(lastRegion!.end).toBe(samples.length);
    });

    it('detects complete silence', () => {
      const samples = new Float32Array([0, 0, 0, 0]);
      const result = detectSilence(samples, -60);
      expect(result.silent).toBe(true);
      expect(result.silentRegions.length).toBe(1);
      expect(result.silentRegions[0]!.start).toBe(0);
      expect(result.silentRegions[0]!.end).toBe(samples.length);
    });

    it('detects silence in the middle', () => {
      const samples = new Float32Array([0.5, 0, 0, 0, -0.5]);
      const result = detectSilence(samples, -60);
      expect(result.silent).toBe(false);
      expect(result.silentRegions.length).toBeGreaterThan(0);
    });
  });
});
