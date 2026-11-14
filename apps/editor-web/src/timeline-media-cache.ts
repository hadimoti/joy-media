import { type WaveformBucket, WaveformPeakAccumulator } from '@joy-media/audio-core';
import { BoundedFrameStore } from './timeline-frame-store.js';

const VIDEO_THUMBNAIL_WIDTH = 160;
const VIDEO_THUMBNAIL_HEIGHT = 90;
const MAX_SOURCE_CACHE_BYTES = 8 * 1024 * 1024;
const WAVEFORM_BUCKETS = 512;

const assetBlobs = new BoundedFrameStore<string, Blob>({
  maxEntries: 8,
  maxBytes: 64 * 1024 * 1024,
  estimateBytes: (blob) => blob.size,
});
const filmstripFrames = new BoundedFrameStore<string, string>({
  maxEntries: 384,
  maxBytes: 20 * 1024 * 1024,
  estimateBytes: (dataUrl) => dataUrl.length * 2,
});
const waveforms = new BoundedFrameStore<string, readonly WaveformBucket[]>({
  maxEntries: 48,
  maxBytes: 2 * 1024 * 1024,
  estimateBytes: (peaks) => peaks.length * 24,
});
const pendingBlobs = new Map<string, Promise<Blob | undefined>>();
const pendingFrames = new Map<string, Promise<string | undefined>>();
const pendingWaveforms = new Map<string, Promise<readonly WaveformBucket[] | undefined>>();

export type FilmstripFrameLoader = (
  sourceTimesUs: readonly number[],
) => Promise<ReadonlyMap<number, string>>;

/** One bounded, shared blob load for clips that use the same project asset. */
export async function loadTimelineAssetBlob(
  assetId: string,
  loadBlob: (assetId: string) => Promise<Blob | undefined>,
): Promise<Blob | undefined> {
  const cached = assetBlobs.get(assetId);
  if (cached !== undefined) return cached;
  const existing = pendingBlobs.get(assetId);
  if (existing !== undefined) return existing;

  const pending = Promise.resolve()
    .then(() => loadBlob(assetId))
    .catch(() => undefined)
    .then((blob) => {
      if (blob !== undefined) assetBlobs.put(assetId, blob);
      return blob;
    })
    .finally(() => pendingBlobs.delete(assetId));
  pendingBlobs.set(assetId, pending);
  return pending;
}

/** Returns cached frames immediately and decodes only the missing source times. */
export async function getCachedFilmstripFrames(
  assetId: string,
  sourceTimesUs: readonly number[],
  loadMissing: FilmstripFrameLoader,
): Promise<ReadonlyMap<number, string>> {
  const requested = [...new Set(sourceTimesUs)];
  const values = new Map<number, Promise<string | undefined>>();
  const owned = new Map<number, (value: string | undefined) => void>();

  for (const sourceTimeUs of requested) {
    const key = frameKey(assetId, sourceTimeUs);
    const cached = filmstripFrames.get(key);
    if (cached !== undefined) {
      values.set(sourceTimeUs, Promise.resolve(cached));
      continue;
    }
    const existing = pendingFrames.get(key);
    if (existing !== undefined) {
      values.set(sourceTimeUs, existing);
      continue;
    }
    let resolveValue!: (value: string | undefined) => void;
    const pending = new Promise<string | undefined>((resolve) => {
      resolveValue = resolve;
    });
    pendingFrames.set(key, pending);
    values.set(sourceTimeUs, pending);
    owned.set(sourceTimeUs, resolveValue);
  }

  if (owned.size > 0) {
    void Promise.resolve()
      .then(() => loadMissing([...owned.keys()]))
      .catch(() => new Map<number, string>())
      .then((decoded) => {
        for (const [sourceTimeUs, resolveValue] of owned) {
          const value = decoded.get(sourceTimeUs);
          if (value !== undefined) filmstripFrames.put(frameKey(assetId, sourceTimeUs), value);
          pendingFrames.delete(frameKey(assetId, sourceTimeUs));
          resolveValue(value);
        }
      });
  }

  const resolved = await Promise.all(
    [...values.entries()].map(
      async ([sourceTimeUs, pending]) => [sourceTimeUs, await pending] as const,
    ),
  );
  return new Map(
    resolved.filter((entry): entry is readonly [number, string] => entry[1] !== undefined),
  );
}

/** One bounded waveform extraction per asset, shared across visible clips. */
export async function getCachedWaveformPeaks(
  assetId: string,
  loadPeaks: () => Promise<readonly WaveformBucket[] | undefined>,
): Promise<readonly WaveformBucket[] | undefined> {
  const cached = waveforms.get(assetId);
  if (cached !== undefined) return cached;
  const existing = pendingWaveforms.get(assetId);
  if (existing !== undefined) return existing;

  const pending = Promise.resolve()
    .then(loadPeaks)
    .catch(() => undefined)
    .then((peaks) => {
      if (peaks !== undefined) waveforms.put(assetId, peaks);
      return peaks;
    })
    .finally(() => pendingWaveforms.delete(assetId));
  pendingWaveforms.set(assetId, pending);
  return pending;
}

/** Decode a small set of source frames using Mediabunny without touching playback. */
export async function decodeTimelineFilmstripFrames(
  blob: Blob,
  sourceTimesUs: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  if (sourceTimesUs.length === 0 || typeof document === 'undefined') return new Map();
  const { ALL_FORMATS, BlobSource, Input, VideoSampleSink } = await import('mediabunny');
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(blob, { maxCacheSize: MAX_SOURCE_CACHE_BYTES }),
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (track === null || !(await track.canDecode())) return new Map();
    const sink = new VideoSampleSink(track);
    const canvas = document.createElement('canvas');
    canvas.width = VIDEO_THUMBNAIL_WIDTH;
    canvas.height = VIDEO_THUMBNAIL_HEIGHT;
    const context = canvas.getContext('2d');
    if (context === null) return new Map();

    const times = [...new Set(sourceTimesUs)].sort((left, right) => left - right);
    const frames = new Map<number, string>();
    const samples = sink.samplesAtTimestamps(times.map((timeUs) => timeUs / 1_000_000));
    let index = 0;
    for await (const sample of samples) {
      const sourceTimeUs = times[index++];
      if (sourceTimeUs === undefined) {
        sample?.close();
        continue;
      }
      if (sample === null) continue;
      try {
        context.clearRect(0, 0, VIDEO_THUMBNAIL_WIDTH, VIDEO_THUMBNAIL_HEIGHT);
        const scale = Math.min(
          VIDEO_THUMBNAIL_WIDTH / Math.max(1, sample.displayWidth),
          VIDEO_THUMBNAIL_HEIGHT / Math.max(1, sample.displayHeight),
        );
        const width = Math.max(1, Math.round(sample.displayWidth * scale));
        const height = Math.max(1, Math.round(sample.displayHeight * scale));
        sample.draw(
          context,
          Math.round((VIDEO_THUMBNAIL_WIDTH - width) / 2),
          Math.round((VIDEO_THUMBNAIL_HEIGHT - height) / 2),
          width,
          height,
        );
        const dataUrl = await encodeCanvasFrame(canvas);
        if (dataUrl !== undefined) frames.set(sourceTimeUs, dataUrl);
      } finally {
        sample.close();
      }
    }
    return frames;
  } finally {
    input.dispose();
  }
}

/** Decode source audio in chunks and retain only 512 real min/max peaks. */
export async function decodeTimelineWaveform(
  blob: Blob,
): Promise<readonly WaveformBucket[] | undefined> {
  const { ALL_FORMATS, AudioBufferSink, BlobSource, Input } = await import('mediabunny');
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(blob, { maxCacheSize: MAX_SOURCE_CACHE_BYTES }),
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (track === null || !(await track.canDecode())) return undefined;
    const sampleRate = await track.getSampleRate();
    const startTime = await input.getFirstTimestamp([track]);
    const metadataEnd = await input.getDurationFromMetadata([track]);
    const endTime = metadataEnd ?? (await input.computeDuration([track]));
    const durationSeconds = Math.max(0, endTime - startTime);
    const sampleCount = Math.ceil(durationSeconds * sampleRate);
    if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) return undefined;

    const peaks = new WaveformPeakAccumulator(sampleCount, WAVEFORM_BUCKETS);
    const sink = new AudioBufferSink(track);
    for await (const wrapped of sink.buffers(startTime, endTime)) {
      const offset = Math.max(0, Math.round((wrapped.timestamp - startTime) * sampleRate));
      for (let channel = 0; channel < wrapped.buffer.numberOfChannels; channel += 1)
        peaks.add(wrapped.buffer.getChannelData(channel), offset);
    }
    return peaks.finish();
  } finally {
    input.dispose();
  }
}

/** Clear all bounded stores; used by deterministic cache tests. */
export function clearTimelineMediaCaches(): void {
  assetBlobs.clear();
  filmstripFrames.clear();
  waveforms.clear();
  pendingBlobs.clear();
  pendingFrames.clear();
  pendingWaveforms.clear();
}

function frameKey(assetId: string, sourceTimeUs: number): string {
  return `${assetId}\0${sourceTimeUs}`;
}

async function encodeCanvasFrame(canvas: HTMLCanvasElement): Promise<string | undefined> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.72),
  );
  if (blob === null) return undefined;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(blob);
  });
}
