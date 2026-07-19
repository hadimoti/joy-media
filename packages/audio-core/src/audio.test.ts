import { describe, expect, it } from 'vitest';
import {
  AudioPreviewClock,
  buildWaveform,
  exportPcm16Wav,
  measureAudioClockDrift,
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
