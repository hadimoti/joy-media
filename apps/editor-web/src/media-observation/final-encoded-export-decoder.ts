import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  EncodedPacketSink,
  Input,
  UnsupportedInputFormatError,
  VideoSampleSink,
  type AudioSample,
  type InputAudioTrack,
  type InputVideoTrack,
  type VideoSample,
} from 'mediabunny';
import {
  MAX_FINAL_ENCODED_ARTIFACT_BYTES,
  MAX_FINAL_ENCODED_AUDIO_SAMPLE_VALUES,
  MAX_FINAL_ENCODED_DECODED_FRAMES,
  MAX_FINAL_ENCODED_FRAME_PIXELS,
  MAX_FINAL_ENCODED_PIXEL_BYTES,
  MAX_FINAL_ENCODED_PRESENTATION_PTS,
  MAX_FINAL_ENCODED_REQUESTED_AUDIO_WINDOWS,
} from './render-verification.js';
import type {
  DecodedFinalEncodedAudioStream,
  DecodedFinalEncodedAudioWindow,
  DecodedFinalEncodedExport,
  DecodedFinalEncodedVideoFrame,
  DecodedFinalEncodedVideoStream,
  FinalEncodedExportDecodeLimits,
  FinalEncodedExportDecodeRequest,
  FinalEncodedExportDecoder,
  FinalEncodedExportDecoderResult,
} from './render-verification.js';

/**
 * An actual final-export decoder, rather than a source/canvas/preview adapter.
 *
 * This implementation is deliberately safe to execute in a dedicated browser
 * Worker later: it receives one final `Blob`, opens it with Mediabunny, and
 * uses WebCodecs sample copies. It never asks an HTML media element for a
 * frame, never creates an object URL, and never accepts a path, URL, canvas,
 * source asset, or Monitor readback.
 */
export const FINAL_ENCODED_EXPORT_BROWSER_DECODER_VERSION =
  'joy-browser-final-encoded-export-decoder-v1' as const;

const DEFAULT_SOURCE_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_TRACKS = 8;
const MAX_REQUESTED_AUDIO_WINDOWS = MAX_FINAL_ENCODED_REQUESTED_AUDIO_WINDOWS;
const MICROSECONDS_PER_SECOND = 1_000_000;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._=-]{0,127}$/;

export interface BrowserFinalEncodedExportDecoderOptions {
  /**
   * A separate compressed-byte cache ceiling for the final Blob. Decoded
   * pixels/audio remain governed by the verifier request limits.
   */
  readonly maxSourceCacheBytes?: number;
}

/**
 * A browser-only implementation of the `actual-encoded-export-decoder`
 * contract. It is intentionally independent of App state so App can later
 * hand it only the completed `remuxedBlob` at the export seam.
 */
export class BrowserFinalEncodedExportDecoder implements FinalEncodedExportDecoder {
  readonly kind = 'actual-encoded-export-decoder' as const;
  readonly version = FINAL_ENCODED_EXPORT_BROWSER_DECODER_VERSION;
  readonly #maxSourceCacheBytes: number;

  constructor(options: BrowserFinalEncodedExportDecoderOptions = {}) {
    this.#maxSourceCacheBytes = normalizeSourceCacheBytes(options.maxSourceCacheBytes);
  }

  async decode(request: FinalEncodedExportDecodeRequest): Promise<FinalEncodedExportDecoderResult> {
    if (!isFinalBlobRequest(request)) return blocked('artifact-not-readable');
    if (request.signal.aborted) throw new BrowserFinalEncodedExportDecodeAbortError();
    if (request.requestedAudioWindows.length > MAX_REQUESTED_AUDIO_WINDOWS)
      return blocked('decoder-policy');
    if (request.artifact.encoded.size > request.limits.maxArtifactBytes)
      return blocked('decoder-policy');

    let input: Input | undefined;
    try {
      input = new Input({
        formats: ALL_FORMATS,
        source: new BlobSource(request.artifact.encoded, {
          maxCacheSize: Math.min(this.#maxSourceCacheBytes, request.limits.maxArtifactBytes),
        }),
      });
      const format = await input.getFormat();
      throwIfAborted(request.signal);
      const container = normalizeContainer(format.name);
      if (container === undefined) return unavailable('format-unsupported');

      const videoTracks = await input.getVideoTracks();
      throwIfAborted(request.signal);
      const audioTracks = await input.getAudioTracks();
      throwIfAborted(request.signal);
      const durationSeconds = await input.computeDuration();
      throwIfAborted(request.signal);
      if (videoTracks.length < 1 || videoTracks.length + audioTracks.length > MAX_TRACKS)
        return unavailable('format-unsupported');

      const durationUs = secondsToPositiveUs(durationSeconds);
      const pixelAllocationBudget = new DecoderAllocationBudget(
        request.limits.maxDecodedPixelBytes,
      );
      const audioAllocationBudget = new DecoderAllocationBudget(
        request.limits.maxAudioSampleValues,
      );
      const videoStreams: DecodedFinalEncodedVideoStream[] = [];
      for (const [index, track] of videoTracks.entries()) {
        videoStreams.push(
          await decodeVideoTrack(
            track,
            index,
            index === 0 ? request.requestedPixelPtsUs : [],
            request.limits,
            pixelAllocationBudget,
            request.signal,
          ),
        );
      }

      const audioStreams: DecodedFinalEncodedAudioStream[] = [];
      for (const [index, track] of audioTracks.entries()) {
        audioStreams.push(
          await decodeAudioTrack(
            track,
            index,
            index === 0 ? request.requestedAudioWindows : [],
            request.limits,
            audioAllocationBudget,
            request.signal,
          ),
        );
      }

      throwIfAborted(request.signal);
      return Object.freeze({
        status: 'decoded' as const,
        decoded: Object.freeze({
          container,
          durationUs,
          videoStreams: Object.freeze(videoStreams),
          audioStreams: Object.freeze(audioStreams),
        } satisfies DecodedFinalEncodedExport),
      });
    } catch (error) {
      if (request.signal.aborted || error instanceof BrowserFinalEncodedExportDecodeAbortError)
        throw new BrowserFinalEncodedExportDecodeAbortError();
      if (error instanceof BrowserFinalEncodedExportResultError) return error.result;
      if (error instanceof UnsupportedInputFormatError) return unavailable('format-unsupported');
      // Decoder/vendor error strings can contain codec details or host state;
      // preserve no implementation text across this boundary.
      return blocked('artifact-not-readable');
    } finally {
      input?.dispose();
    }
  }
}

export function createBrowserFinalEncodedExportDecoder(
  options: BrowserFinalEncodedExportDecoderOptions = {},
): FinalEncodedExportDecoder {
  return new BrowserFinalEncodedExportDecoder(options);
}

async function decodeVideoTrack(
  track: InputVideoTrack,
  index: number,
  requestedPixelPtsUs: readonly number[],
  limits: FinalEncodedExportDecodeLimits,
  pixelAllocationBudget: DecoderAllocationBudget,
  signal: AbortSignal,
): Promise<DecodedFinalEncodedVideoStream> {
  const codec = await track.getCodec();
  throwIfAborted(signal);
  const width = await track.getDisplayWidth();
  throwIfAborted(signal);
  const height = await track.getDisplayHeight();
  throwIfAborted(signal);
  const durationSeconds = await track.computeDuration();
  throwIfAborted(signal);
  const presentationPtsUs = await readPresentationPts(track, limits.maxPresentationPts, signal);
  throwIfAborted(signal);
  if (codec === null || !isSafeToken(codec)) throw unavailableError('format-unsupported');
  if (!isPositiveSafeInteger(width) || !isPositiveSafeInteger(height)) throw policyError();

  const frames =
    requestedPixelPtsUs.length === 0
      ? []
      : await decodeRequestedVideoFrames(
          track,
          requestedPixelPtsUs,
          width,
          height,
          limits,
          pixelAllocationBudget,
          signal,
        );

  return Object.freeze({
    streamId: `video-${index}`,
    codec: codec.toLowerCase(),
    width,
    height,
    durationUs: secondsToPositiveUs(durationSeconds),
    presentationPtsUs,
    presentationPtsComplete: true as const,
    frames: Object.freeze(frames),
  });
}

async function readPresentationPts(
  track: InputVideoTrack,
  maxPresentationPts: number,
  signal: AbortSignal,
): Promise<readonly number[]> {
  const pts: number[] = [];
  const packetSink = new EncodedPacketSink(track);
  for await (const packet of packetSink.packets(undefined, undefined, { metadataOnly: true })) {
    throwIfAborted(signal);
    const timestampUs = packet.microsecondTimestamp;
    if (!isNonNegativeSafeInteger(timestampUs) || pts.length >= maxPresentationPts)
      throw policyError();
    pts.push(timestampUs);
  }
  pts.sort((left, right) => left - right);
  if (pts.length === 0) throw unavailableError('format-unsupported');
  for (let index = 1; index < pts.length; index += 1) {
    if (pts[index - 1]! >= pts[index]!) {
      // The verifier contract uses unambiguous exact PTS identities. A future
      // contract can add a presentation index; this slice refuses to collapse
      // duplicate timestamps into a misleading success.
      throw policyError();
    }
  }
  return Object.freeze(pts);
}

async function decodeRequestedVideoFrames(
  track: InputVideoTrack,
  requestedPixelPtsUs: readonly number[],
  streamWidth: number,
  streamHeight: number,
  limits: FinalEncodedExportDecodeLimits,
  pixelAllocationBudget: DecoderAllocationBudget,
  signal: AbortSignal,
): Promise<DecodedFinalEncodedVideoFrame[]> {
  if (requestedPixelPtsUs.length > limits.maxDecodedFrames) throw policyError();
  if (!(await track.canDecode())) throw unavailableError('decoder-unavailable');
  throwIfAborted(signal);

  const requested = [...new Set(requestedPixelPtsUs)].sort((left, right) => left - right);
  if (requested.length !== requestedPixelPtsUs.length) throw policyError();
  const requestedSet = new Set(requested);
  const frames: DecodedFinalEncodedVideoFrame[] = [];
  const decodedPts = new Set<number>();
  const sink = new VideoSampleSink(track);
  for await (const sample of sink.samplesAtTimestamps(
    requested.map((ptsUs) => ptsUs / MICROSECONDS_PER_SECOND),
  )) {
    if (sample === null) continue;
    try {
      throwIfAborted(signal);
      if (!requestedSet.has(sample.microsecondTimestamp)) continue;
      if (decodedPts.has(sample.microsecondTimestamp) || frames.length >= limits.maxDecodedFrames)
        throw policyError();
      frames.push(
        await copyRgbaFrame(sample, streamWidth, streamHeight, limits, pixelAllocationBudget),
      );
      decodedPts.add(sample.microsecondTimestamp);
    } finally {
      sample.close();
    }
  }
  frames.sort((left, right) => left.ptsUs - right.ptsUs);
  return frames;
}

async function copyRgbaFrame(
  sample: VideoSample,
  streamWidth: number,
  streamHeight: number,
  limits: FinalEncodedExportDecodeLimits,
  pixelAllocationBudget: DecoderAllocationBudget,
): Promise<DecodedFinalEncodedVideoFrame> {
  const width = sample.displayWidth;
  const height = sample.displayHeight;
  if (
    sample.rotation !== 0 ||
    width !== streamWidth ||
    height !== streamHeight ||
    sample.codedWidth !== width ||
    sample.codedHeight !== height
  )
    throw policyError();
  const pixelCount = safeProduct(width, height);
  const byteLength = safeProduct(pixelCount, 4);
  if (pixelCount > limits.maxFramePixels || byteLength > limits.maxDecodedPixelBytes)
    throw policyError();
  // Aggregate reservation occurs before `Uint8Array` allocation. The total
  // decoded result cannot exceed the caller ceiling via many small frames.
  pixelAllocationBudget.reserve(byteLength);
  const rgba = new Uint8Array(byteLength);
  const layout = await sample.copyTo(rgba, {
    format: 'RGBA',
    layout: [{ offset: 0, stride: width * 4 }],
  });
  if (
    layout.length !== 1 ||
    layout[0]?.offset !== 0 ||
    layout[0]?.stride !== width * 4 ||
    !isNonNegativeSafeInteger(sample.microsecondTimestamp)
  )
    throw policyError();
  return Object.freeze({
    ptsUs: sample.microsecondTimestamp,
    width,
    height,
    rgba,
  });
}

async function decodeAudioTrack(
  track: InputAudioTrack,
  index: number,
  requestedWindows: readonly { readonly startUs: number; readonly endUs: number }[],
  limits: FinalEncodedExportDecodeLimits,
  audioAllocationBudget: DecoderAllocationBudget,
  signal: AbortSignal,
): Promise<DecodedFinalEncodedAudioStream> {
  const codec = await track.getCodec();
  throwIfAborted(signal);
  const sampleRate = await track.getSampleRate();
  throwIfAborted(signal);
  const channelCount = await track.getNumberOfChannels();
  throwIfAborted(signal);
  const durationSeconds = await track.computeDuration();
  throwIfAborted(signal);
  if (
    codec === null ||
    !isSafeToken(codec) ||
    !isPositiveSafeInteger(sampleRate) ||
    !isPositiveSafeInteger(channelCount) ||
    channelCount > 32
  )
    throw unavailableError('format-unsupported');

  const windows =
    requestedWindows.length === 0
      ? []
      : await decodeRequestedAudioWindows(
          track,
          requestedWindows,
          limits,
          audioAllocationBudget,
          signal,
        );
  return Object.freeze({
    streamId: `audio-${index}`,
    codec: codec.toLowerCase(),
    durationUs: secondsToPositiveUs(durationSeconds),
    sampleRate,
    channelCount,
    windows: Object.freeze(windows),
  });
}

async function decodeRequestedAudioWindows(
  track: InputAudioTrack,
  requestedWindows: readonly { readonly startUs: number; readonly endUs: number }[],
  limits: FinalEncodedExportDecodeLimits,
  audioAllocationBudget: DecoderAllocationBudget,
  signal: AbortSignal,
): Promise<DecodedFinalEncodedAudioWindow[]> {
  const ranges = normalizeAudioWindows(requestedWindows);
  if (ranges.length === 0 || ranges.length > MAX_REQUESTED_AUDIO_WINDOWS) throw policyError();
  if (!(await track.canDecode())) throw unavailableError('decoder-unavailable');
  throwIfAborted(signal);

  const collectors = ranges.map(
    (range) => new AudioWindowCollector(range, limits.maxDecodedFrames),
  );
  const seen = new Set<string>();

  const consume = async (sample: AudioSample): Promise<void> => {
    try {
      throwIfAborted(signal);
      const key = `${sample.microsecondTimestamp}:${sample.microsecondDuration}`;
      if (seen.has(key)) return;
      seen.add(key);
      const sampleStartUs = sample.microsecondTimestamp;
      const sampleDurationUs = sample.microsecondDuration;
      if (!isNonNegativeSafeInteger(sampleStartUs) || !isNonNegativeSafeInteger(sampleDurationUs))
        throw policyError();
      const sampleEndUs = safeAdd(sampleStartUs, sampleDurationUs);

      for (const collector of collectors) {
        if (sampleEndUs <= collector.range.startUs || sampleStartUs >= collector.range.endUs)
          continue;
        const clip = copyAudioClip(sample, collector.range, audioAllocationBudget);
        if (clip === undefined) continue;
        collector.append(clip);
      }
    } finally {
      sample.close();
    }
  };

  for (const range of ranges) {
    throwIfAborted(signal);
    // A sparse pair of sync predicates must not make the browser walk the
    // unrequested span between them just because both use the same track.
    // A fresh sink keeps each decoder request scoped to one exact interval.
    const sink = new AudioSampleSink(track);
    const leading = await sink.getSample(range.startUs / MICROSECONDS_PER_SECOND);
    if (leading !== null) await consume(leading);
    for await (const sample of sink.samples(
      range.startUs / MICROSECONDS_PER_SECOND,
      range.endUs / MICROSECONDS_PER_SECOND,
    )) {
      await consume(sample);
    }
  }

  const windows = collectors.flatMap((collector) => collector.finish(audioAllocationBudget));
  if (windows.length > limits.maxDecodedFrames) throw policyError();
  return windows;
}

interface NormalizedAudioWindow {
  readonly startUs: number;
  readonly endUs: number;
}

interface AudioClip {
  readonly startUs: number;
  readonly sampleRate: number;
  readonly frameCount: number;
  readonly channels: readonly Float32Array[];
}

/**
 * Tracks actual retained typed-array allocations in the browser decoder.
 * Callers supply separate byte/value ceilings for RGBA and PCM; each is
 * reserved before a frame/sample buffer is created or retained for compaction.
 */
class DecoderAllocationBudget {
  #used = 0;

  constructor(readonly maximum: number) {}

  reserve(amount: number): void {
    if (!isPositiveSafeInteger(amount) || amount > this.maximum - this.#used) throw policyError();
    this.#used += amount;
  }
}

class AudioWindowCollector {
  readonly #segments: AudioCollectorSegment[] = [];

  constructor(
    readonly range: NormalizedAudioWindow,
    readonly maxSegments: number,
  ) {}

  append(clip: AudioClip): void {
    const current = this.#segments.at(-1);
    if (
      current === undefined ||
      current.sampleRate !== clip.sampleRate ||
      current.channels.length !== clip.channels.length ||
      Math.abs(current.endUs - clip.startUs) > 2
    ) {
      if (this.#segments.length >= this.maxSegments) throw policyError();
      this.#segments.push(new AudioCollectorSegment(clip));
      return;
    }
    current.append(clip);
  }

  finish(allocationBudget: DecoderAllocationBudget): readonly DecodedFinalEncodedAudioWindow[] {
    return Object.freeze(this.#segments.map((segment) => segment.finish(allocationBudget)));
  }
}

class AudioCollectorSegment {
  readonly #chunks: Float32Array[][];
  #frameCount: number;
  endUs: number;

  constructor(clip: AudioClip) {
    this.#chunks = clip.channels.map((channel) => [channel]);
    this.#frameCount = clip.frameCount;
    this.startUs = clip.startUs;
    this.sampleRate = clip.sampleRate;
    this.endUs = clipEndUs(clip);
  }

  readonly startUs: number;
  readonly sampleRate: number;

  get channels(): readonly Float32Array[][] {
    return this.#chunks;
  }

  append(clip: AudioClip): void {
    for (const [index, channel] of clip.channels.entries()) this.#chunks[index]!.push(channel);
    this.#frameCount += clip.frameCount;
    this.endUs = clipEndUs(clip);
  }

  finish(allocationBudget: DecoderAllocationBudget): DecodedFinalEncodedAudioWindow {
    // The compacted output coexists with all `#chunks` until this method
    // returns. Reserve its full aggregate value count before allocating any
    // output channel so compaction cannot temporarily exceed the cap.
    allocationBudget.reserve(safeProduct(this.#frameCount, this.#chunks.length));
    const channels = this.#chunks.map((chunks) => {
      const output = new Float32Array(this.#frameCount);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
      }
      return output;
    });
    return Object.freeze({
      startUs: this.startUs,
      sampleRate: this.sampleRate,
      channels: Object.freeze(channels),
    });
  }
}

function copyAudioClip(
  sample: AudioSample,
  range: NormalizedAudioWindow,
  allocationBudget: DecoderAllocationBudget,
): AudioClip | undefined {
  const sampleStartUs = sample.microsecondTimestamp;
  const sampleEndUs = safeAdd(sampleStartUs, sample.microsecondDuration);
  const overlapStartUs = Math.max(sampleStartUs, range.startUs);
  const overlapEndUs = Math.min(sampleEndUs, range.endUs);
  if (overlapEndUs <= overlapStartUs) return undefined;
  if (!isPositiveSafeInteger(sample.sampleRate) || !isPositiveSafeInteger(sample.numberOfChannels))
    throw policyError();

  const frameOffset = Math.max(
    0,
    Math.floor(((overlapStartUs - sampleStartUs) * sample.sampleRate) / MICROSECONDS_PER_SECOND),
  );
  const frameEnd = Math.min(
    sample.numberOfFrames,
    Math.ceil(((overlapEndUs - sampleStartUs) * sample.sampleRate) / MICROSECONDS_PER_SECOND),
  );
  const frameCount = frameEnd - frameOffset;
  if (!Number.isSafeInteger(frameOffset) || !Number.isSafeInteger(frameCount) || frameCount <= 0)
    return undefined;

  // Reserve all channel copies before creating the first Float32Array.
  allocationBudget.reserve(safeProduct(frameCount, sample.numberOfChannels));
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < sample.numberOfChannels; channel += 1) {
    const values = new Float32Array(frameCount);
    sample.copyTo(values, {
      format: 'f32-planar',
      planeIndex: channel,
      frameOffset,
      frameCount,
    });
    channels.push(values);
  }
  return Object.freeze({
    startUs: safeAdd(
      sampleStartUs,
      Math.round((frameOffset * MICROSECONDS_PER_SECOND) / sample.sampleRate),
    ),
    sampleRate: sample.sampleRate,
    frameCount,
    channels: Object.freeze(channels),
  });
}

function clipEndUs(clip: AudioClip): number {
  return safeAdd(
    clip.startUs,
    Math.round((clip.frameCount * MICROSECONDS_PER_SECOND) / clip.sampleRate),
  );
}

function normalizeAudioWindows(
  values: readonly { readonly startUs: number; readonly endUs: number }[],
): readonly NormalizedAudioWindow[] {
  if (values.length > MAX_REQUESTED_AUDIO_WINDOWS) throw policyError();
  const sorted = values
    .map((value) => {
      if (
        value === null ||
        typeof value !== 'object' ||
        !isNonNegativeSafeInteger(value.startUs) ||
        !isPositiveSafeInteger(value.endUs) ||
        value.endUs <= value.startUs
      )
        throw policyError();
      return { startUs: value.startUs, endUs: value.endUs };
    })
    .sort((left, right) => left.startUs - right.startUs);
  const normalized: NormalizedAudioWindow[] = [];
  for (const value of sorted) {
    const previous = normalized.at(-1);
    if (previous === undefined || value.startUs > previous.endUs) {
      normalized.push(value);
      continue;
    }
    normalized[normalized.length - 1] = {
      startUs: previous.startUs,
      endUs: Math.max(previous.endUs, value.endUs),
    };
  }
  return Object.freeze(normalized.map((value) => Object.freeze(value)));
}

function isFinalBlobRequest(
  request: FinalEncodedExportDecodeRequest,
): request is FinalEncodedExportDecodeRequest {
  return (
    request !== null &&
    typeof request === 'object' &&
    request.artifact !== null &&
    typeof request.artifact === 'object' &&
    typeof request.artifact.artifactId === 'string' &&
    OPAQUE_ID.test(request.artifact.artifactId) &&
    typeof Blob !== 'undefined' &&
    request.artifact.encoded instanceof Blob &&
    request.artifact.encoded.size > 0 &&
    isDecodeLimits(request.limits) &&
    Array.isArray(request.requestedPixelPtsUs) &&
    request.requestedPixelPtsUs.length <= request.limits.maxDecodedFrames &&
    request.requestedPixelPtsUs.every(isNonNegativeSafeInteger) &&
    new Set(request.requestedPixelPtsUs).size === request.requestedPixelPtsUs.length &&
    Array.isArray(request.requestedAudioWindows) &&
    request.requestedAudioWindows.every(
      (window) =>
        window !== null &&
        typeof window === 'object' &&
        isNonNegativeSafeInteger(window.startUs) &&
        isPositiveSafeInteger(window.endUs) &&
        window.endUs > window.startUs,
    ) &&
    request.signal !== null &&
    typeof request.signal === 'object' &&
    typeof request.signal.aborted === 'boolean'
  );
}

function isDecodeLimits(value: FinalEncodedExportDecodeLimits): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    isBoundedPositiveSafeInteger(value.maxArtifactBytes, MAX_FINAL_ENCODED_ARTIFACT_BYTES) &&
    isBoundedPositiveSafeInteger(value.maxPresentationPts, MAX_FINAL_ENCODED_PRESENTATION_PTS) &&
    isBoundedPositiveSafeInteger(value.maxDecodedFrames, MAX_FINAL_ENCODED_DECODED_FRAMES) &&
    isBoundedPositiveSafeInteger(value.maxFramePixels, MAX_FINAL_ENCODED_FRAME_PIXELS) &&
    isBoundedPositiveSafeInteger(value.maxDecodedPixelBytes, MAX_FINAL_ENCODED_PIXEL_BYTES) &&
    isBoundedPositiveSafeInteger(value.maxAudioSampleValues, MAX_FINAL_ENCODED_AUDIO_SAMPLE_VALUES)
  );
}

function normalizeContainer(formatName: string): string | undefined {
  switch (formatName) {
    case 'MP4':
      return 'mp4';
    case 'WebM':
      return 'webm';
    case 'QuickTime':
      return 'mov';
    case 'Matroska':
      return 'mkv';
    default:
      return undefined;
  }
}

function normalizeSourceCacheBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SOURCE_CACHE_BYTES;
  if (!isPositiveSafeInteger(value) || value > MAX_SOURCE_CACHE_BYTES)
    throw new TypeError('maxSourceCacheBytes must be a bounded positive safe integer');
  return value;
}

function secondsToPositiveUs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) throw policyError();
  const microseconds = Math.round(seconds * MICROSECONDS_PER_SECOND);
  if (!isPositiveSafeInteger(microseconds)) throw policyError();
  return microseconds;
}

function safeProduct(left: number, right: number): number {
  const result = left * right;
  if (!isPositiveSafeInteger(result)) throw policyError();
  return result;
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!isNonNegativeSafeInteger(result)) throw policyError();
  return result;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isBoundedPositiveSafeInteger(value: unknown, maximum: number): value is number {
  return isPositiveSafeInteger(value) && value <= maximum;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafeToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new BrowserFinalEncodedExportDecodeAbortError();
}

function unavailable(
  code: Extract<FinalEncodedExportDecoderResult, { readonly status: 'unavailable' }>['code'],
): FinalEncodedExportDecoderResult {
  return Object.freeze({ status: 'unavailable' as const, code });
}

function blocked(
  code: Extract<FinalEncodedExportDecoderResult, { readonly status: 'blocked' }>['code'],
): FinalEncodedExportDecoderResult {
  return Object.freeze({ status: 'blocked' as const, code });
}

function unavailableError(
  code: Extract<FinalEncodedExportDecoderResult, { readonly status: 'unavailable' }>['code'],
): BrowserFinalEncodedExportResultError {
  return new BrowserFinalEncodedExportResultError(unavailable(code));
}

function policyError(): BrowserFinalEncodedExportResultError {
  return new BrowserFinalEncodedExportResultError(blocked('decoder-policy'));
}

class BrowserFinalEncodedExportResultError extends Error {
  constructor(readonly result: FinalEncodedExportDecoderResult) {
    super('JOY final encoded export decoding stopped.');
    this.name = 'BrowserFinalEncodedExportResultError';
  }
}

class BrowserFinalEncodedExportDecodeAbortError extends Error {
  constructor() {
    super('JOY final encoded export decoding was cancelled.');
    this.name = 'BrowserFinalEncodedExportDecodeAbortError';
  }
}
