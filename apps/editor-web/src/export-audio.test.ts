import { describe, expect, it } from 'vitest';
import { createMonoAudioBuffer, type MonoBufferAudioContext } from './export-audio.js';

/**
 * Regression guard for JOY-001: MP4 export always failed because the sample
 * length was passed into `createBuffer`'s channel-count slot (~1.44M "channels"
 * threw a Web Audio range error). The helper must always allocate with the
 * correct Web Audio argument order `(numberOfChannels=1, length, sampleRate)`.
 */
describe('createMonoAudioBuffer', () => {
  it('allocates a mono buffer with (1, length, sampleRate) argument order', () => {
    const calls: Array<[number, number, number]> = [];
    const ctx: MonoBufferAudioContext = {
      createBuffer: (channels, length, rate) => {
        calls.push([channels, length, rate]);
        return { numberOfChannels: channels, length, sampleRate: rate } as unknown as AudioBuffer;
      },
    };

    const samples = new Float32Array(1_439_999); // the pre-fix sample-count regression
    const result = createMonoAudioBuffer(ctx, samples, 48000);

    // The bug passed length into the channels slot -> must NOT recur.
    expect(calls).toEqual([[1, 1_439_999, 48000]]);
    expect(result).not.toBeUndefined();
  });

  it('keeps numberOfChannels fixed at 1 for any sample length', () => {
    const calls: Array<[number, number, number]> = [];
    const ctx: MonoBufferAudioContext = {
      createBuffer: (channels, length, rate) => {
        calls.push([channels, length, rate]);
        return { numberOfChannels: channels, length, sampleRate: rate } as unknown as AudioBuffer;
      },
    };

    createMonoAudioBuffer(ctx, new Float32Array(10), 44100);
    expect(calls).toEqual([[1, 10, 44100]]);
  });

  it('rejects an empty sample array', () => {
    const ctx: MonoBufferAudioContext = {
      createBuffer: () => ({}) as unknown as AudioBuffer,
    };
    expect(() => createMonoAudioBuffer(ctx, new Float32Array(0), 48000)).toThrow('empty audio');
  });

  it('rejects a non-positive sample rate', () => {
    const ctx: MonoBufferAudioContext = {
      createBuffer: () => ({}) as unknown as AudioBuffer,
    };
    expect(() => createMonoAudioBuffer(ctx, new Float32Array(4), 0)).toThrow(
      'sample rate must be positive',
    );
  });
});
