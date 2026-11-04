import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, type AudioSample } from 'mediabunny';
import { exportAudioSourceWindow, type ExportAudioClipTiming } from './export-audio.js';

/**
 * The longest window one clip may decode. A window this long means a whole-file decode has come
 * back, which is the failure this module exists to prevent.
 */
export const EXPORT_AUDIO_MAX_WINDOW_SECONDS = 3_600;

/** Compressed bytes the Blob reader keeps in memory, as the video frame source does. */
const SOURCE_CACHE_BYTES = 16 * 1024 * 1024;

export interface ExportAudioWindow {
  /** Planar source channels, starting at source sample `firstSample`. */
  readonly channels: readonly Float32Array[];
  /** The source's own sample rate, which `channels` are in. */
  readonly sampleRate: number;
  /** Source sample index of the first frame in `channels`. */
  readonly firstSample: number;
}

export interface DecodeExportAudioWindowOptions {
  readonly blob: Blob;
  readonly clip: ExportAudioClipTiming;
  readonly outputSampleRate: number;
  /** Names the source in errors. */
  readonly label: string;
  readonly signal: AbortSignal;
}

/**
 * Decodes only the source samples one clip reads, never the whole file. Resolves `undefined` when
 * the source has no audio track, and the caller plays that clip as silence.
 */
export async function decodeExportAudioWindow(
  options: DecodeExportAudioWindowOptions,
): Promise<ExportAudioWindow | undefined> {
  const { blob, clip, outputSampleRate, label, signal } = options;
  throwIfAborted(signal);
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(blob, { maxCacheSize: SOURCE_CACHE_BYTES }),
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (track === null) return undefined;
    if (track.numberOfChannels > 2)
      throw new Error('Export currently supports mono or stereo source audio');
    const range = exportAudioSourceWindow(clip, track.sampleRate, outputSampleRate);
    const frames = range.endSample - range.startSample;
    const seconds = frames / track.sampleRate;
    if (seconds > EXPORT_AUDIO_MAX_WINDOW_SECONDS)
      throw new Error(`Export audio window too long: ${Math.ceil(seconds)} s for ${label}`);
    const channels = Array.from({ length: track.numberOfChannels }, () => new Float32Array(frames));
    const sink = new AudioSampleSink(track);
    for await (const sample of sink.samples(
      range.startSample / track.sampleRate,
      range.endSample / track.sampleRate,
    )) {
      try {
        throwIfAborted(signal);
        copySampleIntoWindow(sample, channels, range.startSample, track.sampleRate);
      } finally {
        sample.close();
      }
    }
    return { channels, sampleRate: track.sampleRate, firstSample: range.startSample };
  } finally {
    input.dispose();
  }
}

/** Copies the frames of one decoded sample that fall inside the window. */
function copySampleIntoWindow(
  sample: AudioSample,
  channels: readonly Float32Array[],
  windowStart: number,
  sampleRate: number,
): void {
  if (sample.numberOfChannels !== channels.length)
    throw new Error('Export audio changed its channel count part way through the file');
  const sampleStart = Math.round(sample.timestamp * sampleRate);
  const from = Math.max(windowStart, sampleStart);
  const to = Math.min(windowStart + channels[0]!.length, sampleStart + sample.numberOfFrames);
  if (to <= from) return;
  const count = to - from;
  channels.forEach((channel, planeIndex) => {
    const plane = new Float32Array(count);
    sample.copyTo(plane, {
      planeIndex,
      format: 'f32-planar',
      frameOffset: from - sampleStart,
      frameCount: count,
    });
    channel.set(plane, from - windowStart);
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
}
