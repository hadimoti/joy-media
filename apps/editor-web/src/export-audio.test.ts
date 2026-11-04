import { describe, expect, it } from 'vitest';
import {
  createMonoAudioBuffer,
  createExportAudioBuffer,
  exportAudioSourceWindow,
  prepareExportAudioChannels,
  selectExportAudioClips,
  silentExportAudioChannels,
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

describe('export audio source windows', () => {
  it('covers every source sample the forward mix reads, with a two-sample margin', () => {
    // 2 s into a 48 kHz source for 5 s reads source samples 96_000 up to 336_000.
    expect(
      exportAudioSourceWindow({ sourceInUs: 2_000_000, durationUs: 5_000_000 }, 48_000, 48_000),
    ).toEqual({ startSample: 95_998, endSample: 336_002 });
  });

  it('spans twice as far at playback rate 2', () => {
    expect(
      exportAudioSourceWindow(
        { sourceInUs: 2_000_000, durationUs: 5_000_000, playbackRate: 2 },
        48_000,
        48_000,
      ),
    ).toEqual({ startSample: 95_998, endSample: 576_001 });
  });

  it('runs backwards from the cursor for a reversed clip', () => {
    expect(
      exportAudioSourceWindow(
        { sourceInUs: 2_000_000, durationUs: 1_000_000, reversed: true },
        48_000,
        48_000,
      ),
    ).toEqual({ startSample: 47_999, endSample: 96_003 });
  });

  it('clamps the window at the start of the source', () => {
    expect(
      exportAudioSourceWindow({ sourceInUs: 0, durationUs: 1_000_000 }, 48_000, 48_000),
    ).toEqual({ startSample: 0, endSample: 48_002 });
    expect(
      exportAudioSourceWindow({ sourceInUs: 500_000, durationUs: 1_000_000, reversed: true }, 4, 4),
    ).toEqual({ startSample: 0, endSample: 5 });
  });
});

describe('windowed export audio matches the whole source', () => {
  const source = Float32Array.from(
    { length: 1_000 },
    (_, index) => Math.sin(index * 0.7) + index / 1_000,
  );
  const stereo = [source, Float32Array.from(source, (value) => -value / 2)];
  const cases: Array<{ name: string; clip: Parameters<typeof exportAudioSourceWindow>[0] }> = [
    { name: 'forward', clip: { sourceInUs: 100_000, durationUs: 200_000 } },
    {
      name: 'forward at double speed',
      clip: { sourceInUs: 100_000, durationUs: 200_000, playbackRate: 2 },
    },
    {
      name: 'forward at half speed',
      clip: { sourceInUs: 100_000, durationUs: 200_000, playbackRate: 0.5 },
    },
    { name: 'reversed', clip: { sourceInUs: 500_000, durationUs: 200_000, reversed: true } },
    {
      name: 'reversed at double speed',
      clip: { sourceInUs: 900_000, durationUs: 200_000, playbackRate: 2, reversed: true },
    },
    {
      name: 'running past the end of the source',
      clip: { sourceInUs: 950_000, durationUs: 200_000 },
    },
  ];

  for (const { name, clip } of cases) {
    it(`reads ${name} from a window exactly as from the whole source`, () => {
      const range = exportAudioSourceWindow(clip, 1_000, 1_000);
      const windowed = prepareExportAudioChannels(
        stereo.map((channel) => channel.slice(range.startSample, range.endSample)),
        1_000,
        1_000,
        clip,
        range.startSample,
      );
      const whole = prepareExportAudioChannels(stereo, 1_000, 1_000, clip);
      expect(windowed).toHaveLength(whole.length);
      windowed.forEach((channel, index) => {
        expect(channel.length).toBe(whole[index]!.length);
        channel.forEach((value, frame) => expect(value).toBeCloseTo(whole[index]![frame]!, 6));
      });
    });
  }
});

describe('silent export audio', () => {
  it('is one channel as long as the prepared channels would be', () => {
    const clip = { sourceInUs: 0, durationUs: 750_000 };
    const silent = silentExportAudioChannels(clip, 48_000);
    const prepared = prepareExportAudioChannels([new Float32Array(10)], 48_000, 48_000, clip);
    expect(silent).toHaveLength(1);
    expect(silent[0]!.length).toBe(prepared[0]!.length);
    expect(silent[0]!.every((value) => value === 0)).toBe(true);
  });
});
