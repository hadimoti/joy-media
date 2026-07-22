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
      expect(Array.from(left)[0]).toBeCloseTo(1.0, 3);
      expect(Array.from(right)[0]).toBeCloseTo(1.0, 3);
      expect(Array.from(left)[1]).toBeCloseTo(-1.0, 3);
      expect(Array.from(right)[1]).toBeCloseTo(-1.0, 3);
      expect(Array.from(left)[2]).toBeCloseTo(0.5, 3);
      expect(Array.from(right)[2]).toBeCloseTo(0.5, 3);
    });

    it('pans full left', () => {
      const input = new Float32Array([1.0]);
      const { left, right } = applyPan(input, -1);
      expect(Array.from(left)[0]).toBeCloseTo(1.0, 3);
      expect(Array.from(right)[0]).toBeCloseTo(0.0, 3);
    });

    it('pans full right', () => {
      const input = new Float32Array([1.0]);
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
      const input = new Float32Array(96).fill(1.0);
      const output = applyFade(input, 1_000, 0, 48000);
      // fadeInSamples = 48, so gain = i/48 for i=0..47
      expect(output[0]).toBeCloseTo(0.0, 3);
      expect(output[24]).toBeCloseTo(0.5, 2); // 24/48 = 0.5
      expect(output[47]).toBeCloseTo(47 / 48, 2); // 47/48 ≈ 0.979
      expect(output[48]).toBeCloseTo(1.0, 3); // outside fade
    });

    it('applies fade-out at the end', () => {
      const input = new Float32Array(96).fill(1.0);
      const output = applyFade(input, 0, 1_000, 48000);
      // fadeOutSamples = 48, fadeOutStart = 96-48 = 48
      // gain = 1 - i/48 for i=0..47
      expect(output[47]).toBeCloseTo(1.0, 3); // before fade
      expect(output[48]).toBeCloseTo(1.0, 2); // start of fade, i=0: 1-0/48 = 1
      expect(output[71]).toBeCloseTo(1 - 23 / 48, 2); // i=23: 25/48 ≈ 0.521
      expect(output[72]).toBeCloseTo(1 - 24 / 48, 2); // i=24: 24/48 = 0.5
      expect(output[95]).toBeCloseTo(1 - 47 / 48, 2); // i=47: 1/48 ≈ 0.021
    });

    it('applies both fade-in and fade-out', () => {
      const input = new Float32Array(96).fill(1.0);
      const output = applyFade(input, 500, 500, 48000);
      // fadeInSamples = 24, fadeOutSamples = 24, fadeOutStart = 72
      // fade-in: i=0..23, gain = i/24
      // fade-out: i=0..23 at idx 72..95, gain = 1 - i/24
      expect(output[0]).toBeCloseTo(0.0, 3);
      expect(output[12]).toBeCloseTo(12 / 24, 2); // i=12: 0.5
      expect(output[23]).toBeCloseTo(23 / 24, 2); // i=23: ~0.958
      expect(output[72]).toBeCloseTo(1.0, 2); // start of fade-out
      expect(output[84]).toBeCloseTo(1 - 12 / 24, 2); // i=12: 0.5
      expect(output[95]).toBeCloseTo(1 - 23 / 24, 2); // i=23: ~0.042
    });
  });

  describe('applyCrossfade', () => {
    it('performs equal-power crossfade', () => {
      const outgoing = new Float32Array(100).fill(1.0);
      const incoming = new Float32Array(100).fill(0.5);
      const output = applyCrossfade(outgoing, incoming, 1_000, 48000);

      expect(output.length).toBe(48);
      expect(output[0]).toBeCloseTo(1.0, 2);
      // At midpoint: outgoing * cos(pi/4) + incoming * sin(pi/4) = 1.0 * 0.707 + 0.5 * 0.707 = 1.0605
      expect(output[24]).toBeCloseTo(1.0606, 3);
      // At end: outgoingGain ≈ cos(47/48 * π/2) ≈ 0.031, incomingGain ≈ 0.999
      // result ≈ 1.0 * 0.031 + 0.5 * 0.999 ≈ 0.5305
      expect(output[47]).toBeCloseTo(0.531, 2);
    });

    it('handles different buffer lengths', () => {
      const outgoing = new Float32Array(50).fill(1.0);
      const incoming = new Float32Array(30).fill(0.5);
      const output = applyCrossfade(outgoing, incoming, 1_000, 48000);

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
      expect(left[0]).toBeCloseTo(1.25, 2);
      expect(right[0]).toBeCloseTo(1.25, 2);
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
      expect(left[0]).toBeCloseTo(1.0, 2);
      expect(right[0]).toBeCloseTo(1.0, 2);
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
      expect(left[0]).toBeCloseTo(1.0, 2);
    });
  });
});
