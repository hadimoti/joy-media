import { describe, expect, it } from 'vitest';
import {
  AudioPreviewClock,
  AudioSpikeError,
  buildWaveform,
  buildWaveformDirect,
  exportPcm16Wav,
  measureAudioClockDrift,
  mixAudioTracks,
  sampleIndexAtUs,
  sampleStartUs,
} from './audio.js';

const RATE = 48_000;

describe('audio sync spike', () => {
  it('builds deterministic min/max waveform peaks', () => {
    const waveform = buildWaveform(new Float32Array([-1, -0.5, 0.25, 1, 0.1, -0.2, 0.9, 0.4]), 4);
    expect(waveform).toHaveLength(4);
    expect(waveform[0]).toEqual({ min: -1, max: -0.5 });
    expect(waveform[1]).toEqual({ min: 0.25, max: 1 });
    expect(waveform[2]!.min).toBeCloseTo(-0.2);
    expect(waveform[2]!.max).toBeCloseTo(0.1);
    expect(waveform[3]!.min).toBeCloseTo(0.4);
    expect(waveform[3]!.max).toBeCloseTo(0.9);
  });

  it('seeks and advances playback from exact timeline time', () => {
    const clock = new AudioPreviewClock(RATE);
    expect(clock.seek(1_500_000)).toBe(72_000);
    expect(clock.advanceBy(500_000)).toBe(96_000);
    expect(clock.timeUs).toBe(2_000_000);
    expect(clock.sampleIndex).toBe(sampleIndexAtUs(2_000_000, RATE));
  });

  it('exports a deterministic mono PCM16 WAV through the Worker export seam', () => {
    const exported = exportPcm16Wav(new Float32Array([-1, 0, 1]), RATE);
    const view = new DataView(exported.bytes.buffer);
    expect(new TextDecoder().decode(exported.bytes.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(exported.bytes.slice(8, 12))).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint32(40, true)).toBe(6);
    expect(Array.from(exported.bytes.slice(44))).toEqual([0, 128, 0, 0, 255, 127]);
    expect(exportPcm16Wav(new Float32Array([-1, 0, 1]), RATE).sha256).toBe(exported.sha256);
  });

  it('reopens a serialized PCM spike fixture with the same waveform and export', () => {
    const saved = JSON.stringify({ sampleRate: RATE, samples: [-1, -0.25, 0.5, 1] });
    const reopened = JSON.parse(saved) as { sampleRate: number; samples: number[] };
    const original = new Float32Array([-1, -0.25, 0.5, 1]);
    const revived = new Float32Array(reopened.samples);
    expect(buildWaveform(revived, 2)).toEqual(buildWaveform(original, 2));
    expect(exportPcm16Wav(revived, reopened.sampleRate).sha256).toBe(
      exportPcm16Wav(original, RATE).sha256,
    );
  });

  it('keeps one-hour reference playback drift below one 48 kHz sample', () => {
    const hourUs = 60 * 60 * 1_000_000;
    const measurement = measureAudioClockDrift(hourUs, RATE, [0, 1, 33_333, 123_456_789, hourUs]);
    expect(measurement.maxAbsoluteDriftUs).toBeLessThanOrEqual(21); // ceil(1e6 / 48000) µs
    expect(sampleStartUs(sampleIndexAtUs(hourUs, RATE), RATE)).toBe(hourUs);
  });
});

describe('buildWaveformDirect', () => {
  it('writes quantised int16 min/max pairs into a contiguous buffer', () => {
    const samples = new Float32Array([-1, -0.5, 0.25, 1, 0.1, -0.2, 0.9, 0.4]);
    const out = buildWaveformDirect(samples, 4);
    expect(out).toBeInstanceOf(Int16Array);
    expect(out.length).toBe(8);
    expect(out[0]).toBe(-32768); // -1 floor
    expect(out[1]).toBe(-16384); // -0.5
    expect(out[2]).toBe(8192); // 0.25
    expect(out[3]).toBe(32767); // +1 ceiling
  });

  it('reuses a caller-provided buffer when large enough and zeroes trailing slots', () => {
    const reuse = new Int16Array(8);
    // 2 samples, 4 buckets → only bucket 1 ([0,1)) and bucket 3 ([1,2)) have samples.
    const out = buildWaveformDirect(new Float32Array([0.5, -0.25]), 4, reuse);
    expect(out).toBe(reuse);
    // Empty buckets must be zeroed in the reused buffer.
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    // Bucket 1: min 0.5, max 0.5
    expect(out[2]).toBe(16384);
    expect(out[3]).toBe(16384);
    // Bucket 3: min -0.25, max -0.25
    expect(out[6]).toBe(-8192);
    expect(out[7]).toBe(-8192);
  });

  it('returns a zeroed buffer for empty samples', () => {
    const out = buildWaveformDirect(new Float32Array(0), 3);
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('rejects invalid bucketCount', () => {
    expect(() => buildWaveformDirect(new Float32Array([0]), 0)).toThrow(AudioSpikeError);
    expect(() => buildWaveformDirect(new Float32Array([0]), -1)).toThrow(AudioSpikeError);
    expect(() => buildWaveformDirect(new Float32Array([0]), 1.5)).toThrow(AudioSpikeError);
  });
});

describe('mixAudioTracks', () => {
  it('sums scaled sources into the destination with no extra allocation', () => {
    const dest = new Float32Array(4);
    const result = mixAudioTracks([new Float32Array([0.2, 0.2, 0.2, 0.2])], dest, [0.5]);
    expect(result).toBe(dest);
    expect(dest[0]).toBeCloseTo(0.1, 6);
    expect(dest[1]).toBeCloseTo(0.1, 6);
    expect(dest[2]).toBeCloseTo(0.1, 6);
    expect(dest[3]).toBeCloseTo(0.1, 6);
  });

  it('mixes multiple sources with per-track gains and clamps to [-1, 1]', () => {
    const dest = new Float32Array(3);
    mixAudioTracks(
      [new Float32Array([0.8, -0.9, 0.5]), new Float32Array([0.7, 0.5, -1.0])],
      dest,
      [1, 1],
    );
    // 1.5 -> clamp 1, -0.4 stays, -0.5 stays
    expect(dest[0]).toBe(1);
    expect(dest[1]).toBeCloseTo(-0.4, 6);
    expect(dest[2]).toBeCloseTo(-0.5, 6);
  });

  it('assumes unity gain when no gains array is supplied', () => {
    const dest = new Float32Array(2);
    mixAudioTracks([new Float32Array([0.3, 0.4]), new Float32Array([0.1, -0.2])], dest);
    expect(dest[0]).toBeCloseTo(0.4, 6);
    expect(dest[1]).toBeCloseTo(0.2, 6);
  });

  it('only mixes the shorter source into the longer destination and zeroes the tail', () => {
    const dest = new Float32Array(5).fill(0.99);
    mixAudioTracks([new Float32Array([-1, -1])], dest);
    expect(Array.from(dest)).toEqual([-1, -1, 0, 0, 0]);
  });

  it('rejects mismatched gains length', () => {
    expect(() => mixAudioTracks([new Float32Array([1])], new Float32Array(1), [])).toThrow(
      AudioSpikeError,
    );
  });

  it('returns the zeroed destination when no sources are supplied', () => {
    const dest = new Float32Array([0.5, 0.5, 0.5]);
    expect(Array.from(mixAudioTracks([], dest))).toEqual([0, 0, 0]);
  });
});
