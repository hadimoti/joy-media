import { AudioSample, AudioSampleSource, type Output } from 'mediabunny';

export interface OfflineAudioFeeder {
  /** Adds the audio track to `output`. Called once, before `output.start()`. */
  readonly attach: (output: Output) => void;
  /** Encodes and adds every sample that starts before `untilSeconds` and was not added yet. Resolves when the output can take more. */
  readonly feedUntil: (untilSeconds: number) => Promise<void>;
  /** Encodes and adds all remaining samples, then closes its source. */
  readonly finish: () => Promise<void>;
  /** Releases the encoder and source without finishing. Safe to call twice. */
  readonly abort: () => void;
}

export interface OfflineAacTrackOptions {
  readonly channelData: readonly Float32Array[];
  readonly sampleRate: number;
  readonly durationUs: number;
  readonly bitrate?: number;
}

interface AudioSampleLike {
  close(): void;
}

interface AudioSampleSourceLike {
  add(sample: unknown): Promise<void>;
  close(): void;
}

interface AudioSampleInitLike {
  readonly data: Float32Array;
  readonly format: 'f32-planar';
  readonly numberOfChannels: 2;
  readonly sampleRate: number;
  readonly timestamp: number;
}

export interface OfflineAacTrackDeps {
  readonly createAudioSampleSource: (config: {
    codec: 'aac';
    bitrate: number;
  }) => AudioSampleSourceLike;
  readonly createAudioSample: (init: AudioSampleInitLike) => AudioSampleLike;
}

const DEFAULT_BITRATE = 128_000;

const defaultDeps: OfflineAacTrackDeps = {
  createAudioSampleSource: (config) =>
    new AudioSampleSource(config) as unknown as AudioSampleSourceLike,
  createAudioSample: (init) => new AudioSample(init),
};

function abortedError(): Error {
  return new Error('Offline AAC track was aborted');
}

export function createOfflineAacTrack(
  options: OfflineAacTrackOptions,
  deps: OfflineAacTrackDeps = defaultDeps,
): OfflineAudioFeeder {
  const { channelData, sampleRate, durationUs } = options;
  if (!Number.isFinite(sampleRate) || !Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError('sampleRate must be a positive finite integer');
  }
  if (!Number.isFinite(durationUs) || durationUs < 0) {
    throw new RangeError('durationUs must be finite and non-negative');
  }
  if (channelData.length > 2) {
    throw new RangeError('channelData must contain at most two channels');
  }
  if (
    channelData.length > 1 &&
    channelData.some((channel) => channel.length !== channelData[0]!.length)
  ) {
    throw new RangeError('channelData channels must all have the same length');
  }

  const totalSamples = Math.round((durationUs * sampleRate) / 1_000_000);
  if (!Number.isSafeInteger(totalSamples)) {
    throw new RangeError('durationUs produces an unsupported sample count');
  }

  const source = deps.createAudioSampleSource({
    codec: 'aac',
    bitrate: options.bitrate ?? DEFAULT_BITRATE,
  });
  let nextSample = 0;
  let attached = false;
  let aborted = false;
  let finished = false;
  let sourceClosed = false;
  let queuedOperation: Promise<void> = Promise.resolve();

  const throwIfAborted = () => {
    if (aborted) throw abortedError();
  };

  const closeSource = (ignoreErrors: boolean) => {
    if (sourceClosed) return;
    sourceClosed = true;
    try {
      source.close();
    } catch (error) {
      // mediabunny refuses to close a source that is not attached to a started output. There is
      // no encoder to release then, so an abort stays safe to call at any time; a normal finish
      // still reports the failure.
      if (!ignoreErrors) throw error;
    }
  };

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const result = queuedOperation.then(operation);
    queuedOperation = result.catch(() => undefined);
    return result;
  };

  const addNextChunk = async (): Promise<void> => {
    throwIfAborted();
    const frames = Math.min(sampleRate, totalSamples - nextSample);
    if (frames <= 0) return;

    const data = new Float32Array(frames * 2);
    const left = channelData[0];
    const right = channelData.length > 1 ? channelData[1] : left;
    const availableFrames = Math.max(0, Math.min(frames, (left?.length ?? 0) - nextSample));

    if (left && availableFrames > 0) {
      data.set(left.subarray(nextSample, nextSample + availableFrames), 0);
      if (right) data.set(right.subarray(nextSample, nextSample + availableFrames), frames);
      else data.set(left.subarray(nextSample, nextSample + availableFrames), frames);
    }

    const sample = deps.createAudioSample({
      data,
      format: 'f32-planar',
      numberOfChannels: 2,
      sampleRate,
      timestamp: nextSample / sampleRate,
    });
    try {
      await source.add(sample);
    } finally {
      sample.close();
    }

    throwIfAborted();
    nextSample += frames;
  };

  const feedUntilInternal = async (untilSeconds: number): Promise<void> => {
    throwIfAborted();
    if (finished) return;
    while (nextSample < totalSamples && nextSample / sampleRate < untilSeconds) {
      await addNextChunk();
    }
  };

  return {
    attach: (output) => {
      throwIfAborted();
      if (finished || sourceClosed) throw new Error('Offline AAC track has already been finished');
      if (attached) throw new Error('Offline AAC track is already attached');
      output.addAudioTrack(source as unknown as AudioSampleSource);
      attached = true;
    },
    feedUntil: (untilSeconds) => enqueue(() => feedUntilInternal(untilSeconds)),
    finish: () =>
      enqueue(async () => {
        throwIfAborted();
        if (finished) return;
        await feedUntilInternal(Number.POSITIVE_INFINITY);
        throwIfAborted();
        closeSource(false);
        finished = true;
      }),
    abort: () => {
      if (aborted || finished) return;
      aborted = true;
      closeSource(true);
    },
  };
}
