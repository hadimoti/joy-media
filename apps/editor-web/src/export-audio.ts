/**
 * Export/preview audio buffer allocation.
 *
 * Web Audio's `createBuffer(numberOfChannels, length, sampleRate)` takes
 * (channels, length, rate). JOY-001 was a regression where the *sample length*
 * was passed into the *channels* slot — a ~1.44M sample count became
 * "1.44M channels", which threw a Web Audio range error and failed every MP4
 * export. This helper pins the correct argument order and is unit-tested so the
 * mistake cannot be reintroduced.
 */

export interface MonoBufferAudioContext {
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer;
}

export function selectExportAudioClips<T extends { readonly id: string; readonly assetId: string }>(
  timelineClips: readonly T[],
  assets: Readonly<Record<string, { readonly kind: string }>>,
  configs: Readonly<Record<string, { readonly sourceAssetId?: string }>>,
): readonly T[] {
  return timelineClips.filter(
    (clip) =>
      assets[clip.assetId]?.kind === 'audio' ||
      assets[clip.assetId]?.kind === 'video' ||
      configs[clip.id]?.sourceAssetId !== undefined,
  );
}

/** Allocate and populate planar audio without collapsing stereo to mono. */
export function createExportAudioBuffer(
  audioContext: MonoBufferAudioContext,
  channels: readonly Float32Array[],
  sampleRate: number,
): AudioBuffer {
  const length = channels[0]?.length ?? 0;
  if (length === 0) throw new Error('cannot allocate a buffer for empty audio');
  if (!Number.isFinite(sampleRate) || sampleRate <= 0)
    throw new Error('sample rate must be positive');
  if (channels.length > 2 || channels.some((channel) => channel.length !== length))
    throw new Error('export audio requires one or two equally sized channels');
  const buffer = audioContext.createBuffer(channels.length, length, sampleRate);
  channels.forEach((channel, index) => buffer.getChannelData(index).set(channel));
  return buffer;
}

/** Sample source time directly so trims, rate, reverse and end padding stay aligned. */
export function prepareExportAudioChannels(
  channels: readonly Float32Array[],
  sourceSampleRate: number,
  outputSampleRate: number,
  clip: {
    readonly sourceInUs: number;
    readonly durationUs: number;
    readonly playbackRate?: number;
    readonly reversed?: boolean;
  },
): readonly Float32Array[] {
  const rate =
    Number.isFinite(clip.playbackRate) && (clip.playbackRate ?? 0) > 0 ? clip.playbackRate! : 1;
  const length = Math.max(1, Math.ceil((clip.durationUs * outputSampleRate) / 1_000_000));
  return channels.map((channel) =>
    Float32Array.from({ length }, (_, index) => {
      const source =
        (clip.sourceInUs * sourceSampleRate) / 1_000_000 +
        ((clip.reversed ? -1 : 1) * index * rate * sourceSampleRate) / outputSampleRate;
      if (source < 0 || source >= channel.length) return 0;
      const before = Math.floor(source);
      const fraction = source - before;
      return channel[before]! * (1 - fraction) + (channel[before + 1] ?? 0) * fraction;
    }),
  );
}

/** Allocate a mono AudioBuffer in the correct `(1, length, sampleRate)` order. */
export function createMonoAudioBuffer(
  audioContext: MonoBufferAudioContext,
  samples: ArrayLike<number>,
  sampleRate: number,
): AudioBuffer {
  if (samples.length <= 0) throw new Error('cannot allocate a buffer for empty audio');
  if (!(sampleRate > 0)) throw new Error('sample rate must be positive');
  return audioContext.createBuffer(1, samples.length, sampleRate);
}
