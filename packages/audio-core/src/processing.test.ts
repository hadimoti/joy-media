import { describe, expect, it } from 'vitest';
import { applyGain, applyPan, applyFade, applyCrossfade, mixBuses } from './processing.js';
import type { AudioBus } from './graph.js';

describe('audio processing', () => {
  describe('applyGain', () => {
    it('applies linear gain to samples', () => {
      const input = new Float32Array([0.5, -0.5, 1.0, -1.0]);
      const output = applyGain(input, 0.5);
      expect(Array.from(output)).toEqual([0.25, -0.25, 0.5, -0.5]);
    });

    it('handles zero gain', () => {
      const input = new Float32Array([1.0, -1.0, 0.5]);
      const output = applyGain(input, 0);
      expect(Array.from(output)).toEqual([0, 0, 0]);
    });

    it('handles gain > 1', () => {
      const input = new Float32Array([0.5, -0.5]);
      const output = applyGain(input, 2.0);
      expect(Array.from(output)).toEqual([1.0, -1.0]);
    });
  });

  describe('applyPan', () => {
    it('pans center (pan=0) equally to left and right', () => {
      const input = new Float32Array([1.0, -1.0, 0.5]);
      const { left, right } = applyPan(input, 0);
      expect(Array.from(left)[0]).toBeCloseTo(0.707, 3);
      expect(Array.from(right)[0]).toBeCloseTo(0.707, 3);
    });

    it('pans full left (pan=-1)', () => {
      const input = new Float32Array([1.0, -1.0]);
      const { left, right } = applyPan(input, -1);
      expect(Array.from(left)[0]).toBeCloseTo(1.0, 3);
      expect(Array.from(right)[0]).toBeCloseTo(0.0, 3);
    });

    it('pans full right (pan=1)', () => {
      const input = new Float32Array([1.0, -1.0]);
      const { left, right } = applyPan(input, 1);
      expect(Array.from(left)[0]).toBeCloseTo(0.0, 3);
      expect(Array.from(right)[0]).toBeCloseTo(1.0, 3);
    });

    it('clamps pan outside [-1, 1]', () => {
      const input = new Float32Array([1.0]);
      const { left: left1, right: right1 } = applyPan(input, -2);
      expect(Array.from(left1)[0]).toBeCloseTo(1.0, 3);
      expect(Array.from(right1)[0]).toBeCloseTo(0.0, 3);

      const { left: left2, right: right2 } = applyPan(input, 2);
      expect(Array.from(left2)[0]).toBeCloseTo(0.0, 3);
      expect(Array.from(right2)[0]).toBeCloseTo(1.0, 3);
    });
  });

  describe('applyFade', () => {
    it('applies fade-in at the start', () => {
      const input = new Float32Array(100).fill(1.0);
      const output = applyFade(input, 50_000, 0, 48000);
      expect(output[0]).toBeCloseTo(0.0, 3);
      expect(output[24]).toBeCloseTo(0.5, 2);
      expect(output[49]).toBeCloseTo(1.0, 2);
      expect(output[50]).toBeCloseTo(1.0, 3);
    });

    it('applies fade-out at the end', () => {
      const input = new Float32Array(100).fill(1.0);
      const output = applyFade(input, 0, 50_000, 48000);
      expect(output[49]).toBeCloseTo(1.0, 3);
      expect(output[50]).toBeCloseTo(1.0, 2);
      expect(output[75]).toBeCloseTo(0.5, 2);
      expect(output[99]).toBeCloseTo(0.0, 2);
    });

    it('applies both fade-in and fade-out', () => {
      const input = new Float32Array(100).fill(1.0);
      const output = applyFade(input, 25_000, 25_000, 48000);
      expect(output[0]).toBeCloseTo(0.0, 3);
      expect(output[12]).toBeCloseTo(0.5, 2);
      expect(output[24]).toBeCloseTo(1.0, 2);
      expect(output[75]).toBeCloseTo(1.0, 2);
      expect(output[87]).toBeCloseTo(0.5, 2);
      expect(output[99]).toBeCloseTo(0.0, 2);
    });
  });

  describe('applyCrossfade', () => {
    it('performs equal-power crossfade', () => {
      const outgoing = new Float32Array(100).fill(1.0);
      const incoming = new Float32Array(100).fill(0.5);
      const output = applyCrossfade(outgoing, incoming, 100_000, 48000);

      expect(output.length).toBe(48);
      expect(output[0]).toBeCloseTo(1.0, 2);
      expect(output[24]).toBeCloseTo(0.707, 2);
      expect(output[47]).toBeCloseTo(0.5, 2);
    });

    it('handles different buffer lengths', () => {
      const outgoing = new Float32Array(50).fill(1.0);
      const incoming = new Float32Array(30).fill(0.5);
      const output = applyCrossfade(outgoing, incoming, 100_000, 48000);

      expect(output.length).toBe(48);
    });
  });

  describe('mixBuses', () => {
    it('mixes multiple buses with gain and pan', () => {
      const buffers = new Map<string, Float32Array>();
      buffers.set('bus1', new Float32Array([1.0, 1.0]));
      buffers.set('bus2', new Float32Array([0.5, 0.5]));

      const routing: AudioBus[] = [
        {
          id: 'bus1',
          name: 'Bus 1',
          gain: 1.0,
          pan: 0,
          mute: false,
          solo: false,
          inputs: [],
        },
        {
          id: 'bus2',
          name: 'Bus 2',
          gain: 0.5,
          pan: 0,
          mute: false,
          solo: false,
          inputs: [],
        },
      ];

      const { left, right } = mixBuses(buffers, routing);
      expect(left[0]).toBeCloseTo(1.0 + 0.25 * 0.707, 2);
      expect(right[0]).toBeCloseTo(1.0 + 0.25 * 0.707, 2);
    });

    it('skips muted buses', () => {
      const buffers = new Map<string, Float32Array>();
      buffers.set('bus1', new Float32Array([1.0]));
      buffers.set('bus2', new Float32Array([1.0]));

      const routing: AudioBus[] = [
        {
          id: 'bus1',
          name: 'Bus 1',
          gain: 1.0,
          pan: 0,
          mute: false,
          solo: false,
          inputs: [],
        },
        {
          id: 'bus2',
          name: 'Bus 2',
          gain: 1.0,
          pan: 0,
          mute: true,
          solo: false,
          inputs: [],
        },
      ];

      const { left, right } = mixBuses(buffers, routing);
      expect(left[0]).toBeCloseTo(0.707, 2);
      expect(right[0]).toBeCloseTo(0.707, 2);
    });

    it('handles missing buffers', () => {
      const buffers = new Map<string, Float32Array>();
      buffers.set('bus1', new Float32Array([1.0]));

      const routing: AudioBus[] = [
        {
          id: 'bus1',
          name: 'Bus 1',
          gain: 1.0,
          pan: 0,
          mute: false,
          solo: false,
          inputs: [],
        },
        {
          id: 'bus2',
          name: 'Bus 2',
          gain: 1.0,
          pan: 0,
          mute: false,
          solo: false,
          inputs: [],
        },
      ];

      const { left } = mixBuses(buffers, routing);
      expect(left[0]).toBeCloseTo(0.707, 2);
    });
  });
});
