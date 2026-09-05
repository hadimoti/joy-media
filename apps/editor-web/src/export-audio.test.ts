import { describe, expect, it } from 'vitest';
import {
  createMonoAudioBuffer,
  createExportAudioBuffer,
  prepareExportAudioChannels,
  selectExportAudioClips,
  type MonoBufferAudioContext,
} from './export-audio.js';

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

describe('export audio lanes and stereo source preparation', () => {
  it('includes independent music and voice alongside visual audio and image replacements', () => {
    const clips = [
      { id: 'video', assetId: 'v' },
      { id: 'music', assetId: 'm' },
      { id: 'voice', assetId: 'a' },
      { id: 'still', assetId: 'i' },
      { id: 'dubbed-still', assetId: 'i' },
    ];
    expect(
      selectExportAudioClips(
        clips,
        { v: { kind: 'video' }, m: { kind: 'audio' }, a: { kind: 'audio' }, i: { kind: 'image' } },
        { 'dubbed-still': { sourceAssetId: 'a' } },
      ).map((clip) => clip.id),
    ).toEqual(['video', 'music', 'voice', 'dubbed-still']);
  });

  it('preserves independent channels when trimming and changing playback rate', () => {
    const result = prepareExportAudioChannels(
      [new Float32Array([0, 1, 2, 3, 4]), new Float32Array([0, -1, -2, -3, -4])],
      4,
      4,
      { sourceInUs: 250_000, durationUs: 750_000, playbackRate: 2 },
    );
    expect(result.map((channel) => [...channel])).toEqual([
      [1, 3, 0],
      [-1, -3, 0],
    ]);
  });

  it('reverses from the authored source cursor and pads beyond the source with silence', () => {
    const result = prepareExportAudioChannels([new Float32Array([1, 2, 3, 4])], 4, 4, {
      sourceInUs: 500_000,
      durationUs: 1_000_000,
      reversed: true,
    });
    expect([...result[0]!]).toEqual([3, 2, 1, 0]);
  });

  it('allocates stereo with the correct argument order and copies both channels', () => {
    const copied = [new Float32Array(2), new Float32Array(2)];
    const calls: number[][] = [];
    const context = {
      createBuffer: (channels: number, length: number, rate: number) => {
        calls.push([channels, length, rate]);
        return { getChannelData: (channel: number) => copied[channel]! } as AudioBuffer;
      },
    };
    createExportAudioBuffer(context, [new Float32Array([1, 0]), new Float32Array([0, 1])], 48000);
    expect(calls).toEqual([[2, 2, 48000]]);
    expect(copied.map((channel) => [...channel])).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });
});
