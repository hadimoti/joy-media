/**
 * Offline H.264 MP4 export.
 *
 * The realtime export (`downloadBrowserMp4` in `packages/renderer-pixi/src/browser-export.ts`)
 * records a canvas with `MediaRecorder` paced to real time, so it can never be faster than the
 * video it produces. This module encodes every frame as fast as the hardware allows with
 * WebCodecs (through mediabunny) and muxes the result into an MP4.
 *
 * The export never touches the wall clock: frame timestamps come from the frame index and the
 * manifest frame rate, so a 10 minute timeline encodes in as long as the encoder needs.
 */

import { AppendOnlyStreamTarget, CanvasSource, Mp4OutputFormat, Output } from 'mediabunny';
import type { VideoEncodingConfig } from 'mediabunny';
import type {
  BrowserExportManifest,
  BrowserExportResult,
} from '@joy-media/renderer-pixi/browser-export';
import { validateH264ExportDimensions } from '@joy-media/job-protocol';
import { avcCodecString, selectAvcLevels, type AvcProfile } from './avc-level.js';
import { OFFLINE_AAC_CODEC } from './offline-aac-track.js';

/**
 * Implemented elsewhere (offline-aac-track.ts, another worker). Your code only calls it.
 */
export interface OfflineAudioFeeder {
  /** Adds the audio track to `output`. Called once, before `output.start()`. */
  readonly attach: (output: Output) => void;
  /**
   * Encodes and adds every sample that starts before `untilSeconds` and was not added yet.
   * Resolves when the output can take more.
   */
  readonly feedUntil: (untilSeconds: number) => Promise<void>;
  /** Encodes and adds all remaining samples, then closes its source. */
  readonly finish: () => Promise<void>;
  /** Releases the encoder and source without finishing. Safe to call twice. */
  readonly abort: () => void;
}

/** The H.264 configuration the browser accepted for an export. */
export interface OfflineMp4VideoCapability {
  readonly ok: true;
  /** The full WebCodecs codec string, for example `avc1.640028`. */
  readonly codec: string;
  /** The hardware preference the export encodes with. */
  readonly hardwareAcceleration: 'prefer-hardware';
  /** The target bitrate in bits per second. */
  readonly bitrate: number;
}

/** Why the browser cannot produce an offline MP4 export. */
export interface OfflineMp4UnsupportedCapability {
  readonly ok: false;
  /** A plain-language reason the export cannot run. */
  readonly reason: string;
}

/** What the browser can do: either a usable configuration, or the reason there is none. */
export type OfflineMp4Capability = OfflineMp4VideoCapability | OfflineMp4UnsupportedCapability;

/** What the caller wants to encode. */
export interface OfflineMp4CapabilityInput {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  /** The target bitrate; derived from the format when omitted. */
  readonly bitrate?: number;
  /** Whether the export also has to carry an AAC audio track. */
  readonly needsAudio: boolean;
  /** The sample rate of the mixed audio the AAC encoder will receive; 48 kHz when omitted. */
  readonly audioSampleRate?: number;
  readonly audioChannels?: number;
  readonly audioBitrate?: number;
}

/** The WebCodecs pieces the capability probe talks to. */
export interface OfflineMp4CapabilityDeps {
  readonly videoEncoder?: Pick<typeof VideoEncoder, 'isConfigSupported'>;
  readonly audioEncoder?: Pick<typeof AudioEncoder, 'isConfigSupported'>;
}

/** The mediabunny pieces the export drives; the defaults are the real ones. */
export interface OfflineMp4ExportDeps {
  /** Defaults to mediabunny's `Output`. */
  readonly Output?: typeof Output;
  /** Defaults to mediabunny's `Mp4OutputFormat`. */
  readonly Mp4OutputFormat?: typeof Mp4OutputFormat;
  /** Defaults to mediabunny's `AppendOnlyStreamTarget`. */
  readonly AppendOnlyStreamTarget?: typeof AppendOnlyStreamTarget;
  /** Defaults to mediabunny's `CanvasSource`. */
  readonly CanvasSource?: typeof CanvasSource;
  /**
   * How long a cancelled export waits for a frame or audio chunk that is still being encoded
   * before it cancels the output. Defaults to `CANCEL_GRACE_MS`.
   */
  readonly cancelGraceMs?: number;
}

/** Everything the export needs to produce an MP4. */
export interface OfflineMp4ExportSource {
  readonly manifest: BrowserExportManifest;
  readonly frameCount: number;
  /** The 2D canvas that `paintFrame` paints into. */
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly paintFrame: (index: number) => void | Promise<void>;
  /** The configuration `detectOfflineMp4Capability` picked for this browser. */
  readonly capability: Extract<OfflineMp4Capability, { ok: true }>;
  readonly audio?: OfflineAudioFeeder;
  readonly filename?: string;
  readonly onProgress?: (completedFrames: number, totalFrames: number) => void;
  readonly signal?: AbortSignal;
}

/** How long a single WebCodecs support query may take before the export gives up on it. */
const CAPABILITY_QUERY_TIMEOUT_MS = 8_000;

/**
 * A frame or audio chunk that is still being encoded when the export is cancelled may be creating
 * its encoder at that moment (mediabunny builds the encoder on the first `add()`, after an
 * asynchronous support query). An encoder created after the output was cancelled is never closed,
 * so a cancelled export gives that work this long to settle before it cancels the output.
 *
 * The wait is bounded on purpose: an encoder whose start-up stalls (for example a dead GPU process)
 * must not leave Cancel hanging. Known limit: if the very first encoder takes longer than this to
 * start, it can still be created after the cancel and stay open until the page is released. Closing
 * that gap needs a change inside mediabunny.
 */
const CANCEL_GRACE_MS = 3_000;

/** The AAC profile the export muxes audio as. */
const AUDIO_CODEC = OFFLINE_AAC_CODEC;
const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_CHANNEL_COUNT = 2;
const AUDIO_BITRATE = 128_000;

/**
 * The bitrate bounds of the derived default. The floor and the formula match the real-time recorder
 * (`max(2 Mbps, width x height x frameRate)`), so an offline export encodes at the recorder's bit
 * rate. The recorder has no ceiling; the offline export stops at the H.264 High profile limit of
 * level 5.2 (300 Mbps).
 */
const MIN_BITRATE = 2_000_000;
const MAX_BITRATE = 300_000_000;

/** The profiles are tried in this order, best compression first. */
const AVC_PROFILE_ORDER: readonly AvcProfile[] = ['high', 'main', 'constrainedBaseline'];

/**
 * Asks the browser whether it can encode the requested format as H.264 (and AAC, when the export
 * needs audio).
 *
 * `prefer-hardware` is a preference, not a guarantee: a supported answer does not prove that the
 * NVIDIA encoder is the one that will run. Only a real encode measured with `nvidia-smi` shows
 * that. The probe therefore never throws - a missing API, a rejected query or a query that hangs
 * all come back as a plain-language reason.
 */
export async function detectOfflineMp4Capability(
  input: OfflineMp4CapabilityInput,
  deps: OfflineMp4CapabilityDeps = {},
): Promise<OfflineMp4Capability> {
  const { width, height, frameRate } = input;
  const bitrate = input.bitrate ?? defaultOfflineMp4Bitrate(width, height, frameRate);
  const dimensions = validateH264ExportDimensions(width, height);
  if (!dimensions.ok) return dimensions;
  const videoEncoder =
    deps.videoEncoder ?? (typeof VideoEncoder === 'undefined' ? undefined : VideoEncoder);
  if (videoEncoder === undefined)
    return {
      ok: false,
      reason:
        'This browser has no WebCodecs video encoder, so it cannot export MP4 offline. Update to the latest Chrome.',
    };
  for (const profile of AVC_PROFILE_ORDER) {
    // The level has to cover the bit rate too, so a high bit rate moves the choice up a level.
    const levels = selectAvcLevels(width, height, frameRate, bitrate, profile);
    for (const level of levels) {
      const codec = avcCodecString(profile, level);
      const outcome = await querySupport(() =>
        videoEncoder.isConfigSupported({
          codec,
          width,
          height,
          framerate: frameRate,
          bitrate,
          hardwareAcceleration: 'prefer-hardware',
          latencyMode: 'quality',
        }),
      );
      if (outcome.kind === 'timeout')
        return {
          ok: false,
          reason: `The browser did not answer whether it can encode ${codec} within ${CAPABILITY_QUERY_TIMEOUT_MS / 1000} seconds.`,
        };
      if (outcome.kind === 'error')
        return {
          ok: false,
          reason: `The browser failed to report whether it can encode ${codec}: ${describeError(outcome.error)}`,
        };
      if (outcome.value.supported !== true) continue;
      const audioFailure = await checkAudioSupport(
        input.needsAudio,
        input.audioSampleRate ?? AUDIO_SAMPLE_RATE,
        input.audioChannels ?? AUDIO_CHANNEL_COUNT,
        input.audioBitrate ?? AUDIO_BITRATE,
        deps,
      );
      if (audioFailure !== undefined) return { ok: false, reason: audioFailure };
      return { ok: true, codec, hardwareAcceleration: 'prefer-hardware', bitrate };
    }
  }
  return {
    ok: false,
    reason: `This browser cannot encode H.264 at ${width}x${height} at ${frameRate} fps.`,
  };
}

/**
 * Checks the AAC encoder when the export needs audio. Returns the reason the export cannot run,
 * or `undefined` when the audio side is fine.
 */
async function checkAudioSupport(
  needsAudio: boolean,
  sampleRate: number,
  channels: number,
  bitrate: number,
  deps: OfflineMp4CapabilityDeps,
): Promise<string | undefined> {
  if (!needsAudio) return undefined;
  const audioEncoder =
    deps.audioEncoder ?? (typeof AudioEncoder === 'undefined' ? undefined : AudioEncoder);
  if (audioEncoder === undefined)
    return 'This browser has no WebCodecs audio encoder, so it cannot export MP4 with audio.';
  const outcome = await querySupport(() =>
    audioEncoder.isConfigSupported({
      codec: AUDIO_CODEC,
      sampleRate,
      numberOfChannels: channels,
      bitrate,
    }),
  );
  if (outcome.kind === 'timeout')
    return `The browser did not answer whether it can encode AAC within ${CAPABILITY_QUERY_TIMEOUT_MS / 1000} seconds.`;
  if (outcome.kind === 'error')
    return `The browser failed to report whether it can encode AAC: ${describeError(outcome.error)}`;
  if (outcome.value.supported !== true)
    return 'This browser cannot encode AAC audio, so it cannot export MP4 with audio.';
  return undefined;
}

/** The outcome of a single WebCodecs support query. */
type SupportOutcome =
  | { readonly kind: 'ok'; readonly value: { readonly supported?: boolean } }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'error'; readonly error: unknown };

/**
 * Runs one support query with a timeout. A query that never answers must not hold the export
 * hostage, and a query that fails must not throw out of the probe.
 */
async function querySupport(
  query: () => Promise<{ readonly supported?: boolean }>,
): Promise<SupportOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = query().then(
      (value) => ({ kind: 'ok', value }) as const,
      (error: unknown) => ({ kind: 'error', error }) as const,
    );
    const timeout = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), CAPABILITY_QUERY_TIMEOUT_MS);
    });
    return await Promise.race([settled, timeout]);
  } catch (error) {
    return { kind: 'error', error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The bitrate used when the caller does not ask for one: the recorder's, within bounds. */
function defaultOfflineMp4Bitrate(width: number, height: number, frameRate: number): number {
  const raw = width * height * frameRate;
  return Math.round(Math.min(Math.max(raw, MIN_BITRATE), MAX_BITRATE));
}

/** Renders an unknown error as a short, readable sentence. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Collects the bytes the muxer writes as Blob parts. */
export interface BlobSink {
  /** The stream the muxer's target writes to. Every chunk becomes one Blob part. */
  readonly writable: WritableStream<Uint8Array>;
  /** The number of bytes written so far. */
  readonly size: () => number;
  /** One Blob made of every part, in the order they were written. */
  readonly toBlob: (type: string) => Blob;
  /** Drops every part and ignores anything written afterwards. */
  readonly discard: () => void;
}

/**
 * Collects what the muxer writes as Blob parts. Wrapping each fragment in a Blob as it arrives
 * moves its bytes out of the script heap into the browser's blob storage, which can page out to
 * disk. The final Blob only references those parts, so the file is never copied again. The
 * previous in-memory target held the whole file in several script buffers at once, up to about
 * four times its size at the end of a long export.
 */
export function createBlobSink(): BlobSink {
  let parts: Blob[] = [];
  let size = 0;
  let discarded = false;
  return {
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        if (discarded) return;
        parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>]));
        size += chunk.byteLength;
      },
    }),
    size: () => size,
    toBlob: (type) => new Blob(parts, { type }),
    discard: () => {
      discarded = true;
      parts = [];
      size = 0;
    },
  };
}

/** BT.709 color space tags enforced on all MP4 exports so first and later exports remain identical. */
export const EXPORT_BT709_COLOR_SPACE = Object.freeze({
  primaries: 'bt709' as const,
  transfer: 'bt709' as const,
  matrix: 'bt709' as const,
  fullRange: false,
});

/**
 * Encodes every painted frame into an MP4, as fast as the encoder allows.
 *
 * The caller owns the download: this returns the blob, it never triggers one. An aborted export
 * rejects with an `AbortError` `DOMException`, exactly like the realtime export does.
 */
export async function exportOfflineMp4(
  source: OfflineMp4ExportSource,
  deps: OfflineMp4ExportDeps = {},
): Promise<BrowserExportResult> {
  const { manifest, frameCount } = source;
  const { width, height, frameRate } = manifest;
  if (!Number.isSafeInteger(frameCount) || frameCount < 1)
    throw new RangeError('frameCount must be a positive integer');
  if (!Number.isSafeInteger(width) || width < 1)
    throw new RangeError('manifest.width must be a positive integer');
  if (!Number.isSafeInteger(height) || height < 1)
    throw new RangeError('manifest.height must be a positive integer');
  if (!Number.isFinite(frameRate) || frameRate <= 0)
    throw new RangeError('manifest.frameRate must be a positive finite number');
  if (source.signal?.aborted) throw createAbortError();

  const OutputCtor = deps.Output ?? Output;
  const Mp4OutputFormatCtor = deps.Mp4OutputFormat ?? Mp4OutputFormat;
  const AppendOnlyStreamTargetCtor = deps.AppendOnlyStreamTarget ?? AppendOnlyStreamTarget;
  const CanvasSourceCtor = deps.CanvasSource ?? CanvasSource;

  const signal = source.signal;
  // Frame and audio-chunk encoding the export may have stopped waiting for because of an abort
  // while it is still running.
  const inFlight = new Set<Promise<unknown>>();
  let rejectAbort: ((reason: DOMException) => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  // The abort promise is only ever observed through a race; this keeps a late abort from
  // surfacing as an unhandled rejection.
  void abortPromise.catch(() => undefined);
  const onAbort = (): void => {
    rejectAbort?.(createAbortError());
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  // A fragmented MP4 is written strictly front to back, one fragment at a time, so each fragment
  // can go straight into blob storage and the muxer never holds more than the current fragment.
  // It is the same container layout the real-time recorder produces (moov, moof fragments, mfra).
  const sink = createBlobSink();
  const target = new AppendOnlyStreamTargetCtor(sink.writable);
  let output: Output | undefined;
  let videoSource: CanvasSource | undefined;
  try {
    output = new OutputCtor({
      format: new Mp4OutputFormatCtor({ fastStart: 'fragmented' }),
      target,
    });
    videoSource = new CanvasSourceCtor(source.canvas, {
      codec: 'avc',
      bitrate: source.capability.bitrate,
      fullCodecString: source.capability.codec,
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'quality',
      bitrateMode: 'variable',
      keyFrameInterval: 2,
      onEncoderConfig: (config) => {
        (config as VideoEncoderConfig & { colorSpace?: unknown }).colorSpace = {
          ...EXPORT_BT709_COLOR_SPACE,
        };
      },
    } satisfies VideoEncodingConfig);
    output.addVideoTrack(videoSource, {
      frameRate,
      decoderConfig: {
        codec: source.capability.codec,
        colorSpace: { ...EXPORT_BT709_COLOR_SPACE },
      },
    });
    source.audio?.attach(output);
    await output.start();

    const frameDuration = 1 / frameRate;
    for (let index = 0; index < frameCount; index += 1) {
      throwIfAborted(signal);
      await source.paintFrame(index);
      throwIfAborted(signal);
      await raceAbort(videoSource.add(index / frameRate, frameDuration), abortPromise, inFlight);
      throwIfAborted(signal);
      source.onProgress?.(index + 1, frameCount);
      if (source.audio !== undefined)
        await raceAbort(source.audio.feedUntil((index + 1) / frameRate), abortPromise, inFlight);
      throwIfAborted(signal);
    }

    // Finishing the audio and writing the file can take a moment on a long export. A cancel during
    // either one must still end the export with an AbortError, and no file may be handed out.
    // Neither is tracked in `inFlight`: by now every encoder exists, and mediabunny cannot cancel
    // a file that is already being finalized, so waiting for them would only delay the cancel.
    if (source.audio !== undefined) await raceAbort(source.audio.finish(), abortPromise);
    throwIfAborted(signal);
    // Closed last, just before the file is written: closing it earlier would start a polite flush
    // of the video source that a cancel during the audio finish could no longer turn into a
    // forced close.
    videoSource.close();
    await raceAbort(output.finalize(), abortPromise);
    throwIfAborted(signal);
  } catch (error) {
    await releaseAfterFailure(
      source.audio,
      output,
      inFlight,
      deps.cancelGraceMs ?? CANCEL_GRACE_MS,
    );
    // Drop what was written so far; anything the muxer still writes after this is ignored.
    sink.discard();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  const blob = sink.toBlob('video/mp4');
  if (blob.size === 0) throw new Error('the offline MP4 export produced an empty file');
  return {
    frameCount,
    totalBytes: blob.size,
    mimeType: 'video/mp4',
    filename: source.filename ?? `joy-media-export-${Date.now()}.mp4`,
    blob,
    encoded: true,
  };
}

/**
 * Releases the muxer and the audio feeder after a failed export. The muxer cancels the encoders
 * and closes the sources, so no encoder queue is left running.
 *
 * The order matters. Work that is still being encoded gets a moment to settle first (see
 * `CANCEL_GRACE_MS`). The output is cancelled before the feeder is aborted, because aborting the
 * feeder first would start a polite flush of its audio source that `cancel()` can no longer turn
 * into a forced close.
 */
async function releaseAfterFailure(
  audio: OfflineAudioFeeder | undefined,
  output: Output | undefined,
  inFlight: ReadonlySet<Promise<unknown>>,
  graceMs: number,
): Promise<void> {
  await settleWithin(inFlight, graceMs);
  try {
    await output?.cancel();
  } catch {
    // Cancelling is best effort: the original failure is the one worth reporting.
  }
  try {
    audio?.abort();
  } catch {
    // The feeder releases what it can.
  }
}

/** Waits until every promise in `inFlight` has settled, but never longer than `ms`. */
async function settleWithin(inFlight: ReadonlySet<Promise<unknown>>, ms: number): Promise<void> {
  if (inFlight.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([...inFlight]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Waits for `work` while watching for an abort. A pending `work` cannot be cancelled, so the
 * race only stops the export from waiting for it - the late result is swallowed. While it is
 * pending it stays in `inFlight`, so a cancel can give it a moment to settle.
 */
async function raceAbort<T>(
  work: Promise<T>,
  abortPromise: Promise<never>,
  inFlight?: Set<Promise<unknown>>,
): Promise<T> {
  const settled = work.then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  if (inFlight !== undefined) {
    inFlight.add(settled);
    void settled.then(() => inFlight.delete(settled));
  }
  const outcome = await Promise.race([settled, abortPromise]);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** Stops the export when the caller already aborted it. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw createAbortError();
}

/** The abort error the realtime export uses, so both exports fail the same way. */
function createAbortError(): DOMException {
  return new DOMException('Export cancelled', 'AbortError');
}
