/**
 * Final-export verification deliberately sits after composition capture.
 *
 * A canvas readback, MediaRecorder `stop`, or a structurally valid project is
 * not evidence that the encoded file is correct. This boundary accepts only a
 * decoder explicitly labelled as an actual encoded-export decoder, asks it for
 * bounded final-artifact facts/pixels/audio samples, and exposes only safe
 * aggregate verification facts to callers.
 */

export const FINAL_ENCODED_EXPORT_VERIFIER_VERSION =
  'joy-final-encoded-export-verifier-v1' as const;

export const DEFAULT_MAX_FINAL_ENCODED_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_FINAL_ENCODED_PRESENTATION_PTS = 24_000;
export const DEFAULT_MAX_FINAL_ENCODED_DECODED_FRAMES = 64;
export const DEFAULT_MAX_FINAL_ENCODED_FRAME_PIXELS = 1_920 * 1_080;
export const DEFAULT_MAX_FINAL_ENCODED_PIXEL_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_FINAL_ENCODED_AUDIO_SAMPLE_VALUES = 4_000_000;

/** Absolute ceilings shared by the verifier and its browser decoder adapter. */
export const MAX_FINAL_ENCODED_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_FINAL_ENCODED_PRESENTATION_PTS = 100_000;
export const MAX_FINAL_ENCODED_DECODED_FRAMES = 256;
export const MAX_FINAL_ENCODED_FRAME_PIXELS = 3_840 * 2_160;
export const MAX_FINAL_ENCODED_PIXEL_BYTES = 256 * 1024 * 1024;
export const MAX_FINAL_ENCODED_AUDIO_SAMPLE_VALUES = 16_000_000;
export const MAX_FINAL_ENCODED_REQUESTED_AUDIO_WINDOWS = 64;
const MAX_STREAMS = 8;
const MAX_PREDICATES = 256;

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._=-]{0,127}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export interface FinalEncodedExportArtifact {
  /** Opaque host identifier only; never a filesystem path, URL, or provider handle. */
  readonly artifactId: string;
  /** The final encoded artifact, never a source canvas/readback. */
  readonly encoded: Blob;
}

export interface PixelVerificationPredicate {
  readonly kind: 'pixel';
  readonly id: string;
  /** Makes title/effect verification explicit in the accepted plan. */
  readonly target: 'title' | 'effect';
  readonly ptsUs: number;
  readonly x: number;
  readonly y: number;
  readonly expectedRgba: readonly [number, number, number, number];
  readonly tolerance: number;
}

export interface BlackFrameVerificationPredicate {
  readonly kind: 'black-frame';
  readonly id: string;
  readonly ptsUs: number;
  readonly expected: 'black' | 'non-black';
  readonly blackThreshold: number;
  /** Required fraction of pixels matching the requested black/non-black state. */
  readonly minimumFraction: number;
}

export type EncodedVisualVerificationPredicate =
  PixelVerificationPredicate | BlackFrameVerificationPredicate;

/**
 * Checks a decoded audio peak against the decoded video PTS. It is intentionally
 * fixture-oriented: a generic spoken-word "sync" claim cannot be inferred from
 * metadata alone.
 */
export interface AudioPeakSyncVerificationPredicate {
  readonly kind: 'audio-peak-sync';
  readonly id: string;
  readonly videoPtsUs: number;
  readonly expectedAudioPeakUs: number;
  readonly maxDriftUs: number;
  readonly minimumPeakAmplitude: number;
}

export interface FinalEncodedExportExpectation {
  readonly container: string;
  readonly width: number;
  readonly height: number;
  readonly durationUs: number;
  /** Complete expected presentation-order sequence, including VFR timestamps. */
  readonly expectedVideoPtsUs: readonly number[];
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly videoStreamCount?: number;
  readonly audioStreamCount?: number;
  readonly durationToleranceUs?: number;
  readonly videoPtsToleranceUs?: number;
  readonly visualPredicates: readonly EncodedVisualVerificationPredicate[];
  readonly audioSyncPredicates: readonly AudioPeakSyncVerificationPredicate[];
}

export interface FinalEncodedExportVerificationRequest {
  readonly artifact: FinalEncodedExportArtifact;
  readonly expected: FinalEncodedExportExpectation;
  readonly signal?: AbortSignal;
}

/** Limits are supplied to the decoder and rechecked against its response. */
export interface FinalEncodedExportDecodeLimits {
  readonly maxArtifactBytes: number;
  readonly maxPresentationPts: number;
  readonly maxDecodedFrames: number;
  readonly maxFramePixels: number;
  readonly maxDecodedPixelBytes: number;
  readonly maxAudioSampleValues: number;
}

/**
 * Exact half-open audio intervals required for an audio-sync predicate. The
 * decoder receives no broad source-audio request: it may decode only these
 * bounded windows when a verification actually needs PCM samples.
 */
export interface FinalEncodedExportAudioDecodeWindow {
  readonly startUs: number;
  readonly endUs: number;
}

export interface FinalEncodedExportDecodeRequest {
  readonly artifact: FinalEncodedExportArtifact;
  /** Only exact PTSs used for a pixel/black-frame predicate may be read back. */
  readonly requestedPixelPtsUs: readonly number[];
  /** Only audio windows required by an audio-sync predicate may be read back. */
  readonly requestedAudioWindows: readonly FinalEncodedExportAudioDecodeWindow[];
  readonly limits: FinalEncodedExportDecodeLimits;
  readonly signal: AbortSignal;
}

export interface DecodedFinalEncodedVideoFrame {
  readonly ptsUs: number;
  readonly width: number;
  readonly height: number;
  /** Decoder-internal pixels. They never appear in a verification result. */
  readonly rgba: Uint8Array | Uint8ClampedArray;
}

export interface DecodedFinalEncodedVideoStream {
  readonly streamId: string;
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  readonly durationUs: number;
  /** Complete presentation-order PTS list, not an encoder frame counter. */
  readonly presentationPtsUs: readonly number[];
  readonly presentationPtsComplete: true;
  /** Only the requested bounded pixel frames. */
  readonly frames: readonly DecodedFinalEncodedVideoFrame[];
}

export interface DecodedFinalEncodedAudioWindow {
  readonly startUs: number;
  readonly sampleRate: number;
  /** Decoded PCM by channel; never returned from verification. */
  readonly channels: readonly Float32Array[];
}

export interface DecodedFinalEncodedAudioStream {
  readonly streamId: string;
  readonly codec: string;
  readonly durationUs: number;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly windows: readonly DecodedFinalEncodedAudioWindow[];
}

export interface DecodedFinalEncodedExport {
  readonly container: string;
  readonly durationUs: number;
  readonly videoStreams: readonly DecodedFinalEncodedVideoStream[];
  readonly audioStreams: readonly DecodedFinalEncodedAudioStream[];
}

export type FinalEncodedExportDecoderResult =
  | { readonly status: 'decoded'; readonly decoded: DecodedFinalEncodedExport }
  | {
      readonly status: 'unavailable';
      readonly code: 'decoder-unavailable' | 'format-unsupported';
    }
  | {
      readonly status: 'blocked';
      readonly code: 'artifact-not-readable' | 'decoder-policy';
    };

/**
 * The marker is deliberately mandatory. A source decoder, a canvas readback,
 * or a recorder-complete callback cannot satisfy this contract.
 */
export interface FinalEncodedExportDecoder {
  readonly kind: 'actual-encoded-export-decoder';
  readonly version: string;
  decode(request: FinalEncodedExportDecodeRequest): Promise<FinalEncodedExportDecoderResult>;
}

export interface FinalEncodedExportVerifierOptions {
  readonly decoder?: FinalEncodedExportDecoder;
  readonly maxArtifactBytes?: number;
  readonly maxPresentationPts?: number;
  readonly maxDecodedFrames?: number;
  readonly maxFramePixels?: number;
  readonly maxDecodedPixelBytes?: number;
  readonly maxAudioSampleValues?: number;
}

export interface FinalEncodedExportVerificationFacts {
  readonly container: string;
  readonly width: number;
  readonly height: number;
  readonly durationUs: number;
  readonly videoStreamCount: number;
  readonly audioStreamCount: number;
  readonly presentationFrameCount: number;
}

export type FinalEncodedExportCheckKind =
  | 'container'
  | 'dimensions'
  | 'duration'
  | 'video-streams'
  | 'audio-streams'
  | 'video-pts'
  /** A bounded RGBA sample was copied from the final encoded video stream. */
  | 'video-decode'
  /** A bounded PCM sample was copied from the final encoded audio stream. */
  | 'audio-decode'
  | 'pixel'
  | 'black-frame'
  | 'audio-sync';

export interface FinalEncodedExportVerificationCheck {
  readonly id: string;
  readonly kind: FinalEncodedExportCheckKind;
}

export interface FinalEncodedExportVerificationSuccess {
  readonly status: 'verified';
  readonly scope: 'decoded-final-encoded-export';
  readonly facts: FinalEncodedExportVerificationFacts;
  readonly checks: readonly FinalEncodedExportVerificationCheck[];
}

export type FinalEncodedExportVerificationFailureCode =
  | 'artifact-too-large'
  | 'decoder-failed'
  | 'invalid-decoder-output'
  | 'decoded-pixel-budget-exceeded'
  | 'decoded-audio-budget-exceeded'
  | 'container-mismatch'
  | 'dimensions-mismatch'
  | 'duration-mismatch'
  | 'video-streams-mismatch'
  | 'audio-streams-mismatch'
  | 'video-codec-mismatch'
  | 'audio-codec-mismatch'
  | 'video-pts-incomplete'
  | 'video-pts-mismatch'
  | 'missing-decoded-frame'
  | 'missing-decoded-audio'
  | 'pixel-predicate-failed'
  | 'black-frame-predicate-failed'
  | 'audio-sync-predicate-failed';

export interface FinalEncodedExportVerificationFailure {
  readonly status: 'failed';
  readonly code: FinalEncodedExportVerificationFailureCode;
  readonly checkId?: string;
}

export interface FinalEncodedExportVerificationUnavailable {
  readonly status: 'unavailable';
  readonly code: 'decoder-unavailable' | 'decoder-not-actual' | 'format-unsupported';
}

export interface FinalEncodedExportVerificationBlocked {
  readonly status: 'blocked';
  readonly code: 'artifact-not-readable' | 'decoder-policy';
}

export interface FinalEncodedExportVerificationCancelled {
  readonly status: 'cancelled';
}

export type FinalEncodedExportVerificationResult =
  | FinalEncodedExportVerificationSuccess
  | FinalEncodedExportVerificationFailure
  | FinalEncodedExportVerificationUnavailable
  | FinalEncodedExportVerificationBlocked
  | FinalEncodedExportVerificationCancelled;

export interface FinalEncodedExportVerifier {
  verify(
    request: FinalEncodedExportVerificationRequest,
  ): Promise<FinalEncodedExportVerificationResult>;
}

export type FinalEncodedExportVerificationErrorCode = 'invalid-options' | 'invalid-request';

/** Intentionally generic: decoder exceptions are never surfaced to callers. */
export class FinalEncodedExportVerificationError extends Error {
  constructor(readonly code: FinalEncodedExportVerificationErrorCode) {
    super('JOY final export verification request is invalid.');
    this.name = 'FinalEncodedExportVerificationError';
  }
}

interface NormalizedExpectation {
  readonly container: string;
  readonly width: number;
  readonly height: number;
  readonly durationUs: number;
  readonly expectedVideoPtsUs: readonly number[];
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly videoStreamCount: number;
  readonly audioStreamCount: number;
  readonly durationToleranceUs: number;
  readonly videoPtsToleranceUs: number;
  readonly visualPredicates: readonly NormalizedVisualPredicate[];
  readonly audioSyncPredicates: readonly NormalizedAudioPeakSyncPredicate[];
  /**
   * Every successful receipt must include real bounded media samples, even
   * when the authored plan has no subjective visual/audio predicates.
   */
  readonly requiredVideoDecodePtsUs: readonly number[];
  readonly requiredAudioDecodeWindows: readonly FinalEncodedExportAudioDecodeWindow[];
  readonly requestedPixelPtsUs: readonly number[];
  readonly requestedAudioWindows: readonly FinalEncodedExportAudioDecodeWindow[];
}

type NormalizedVisualPredicate =
  | (Omit<PixelVerificationPredicate, 'expectedRgba'> & {
      readonly expectedRgba: readonly [number, number, number, number];
    })
  | BlackFrameVerificationPredicate;

type NormalizedAudioPeakSyncPredicate = AudioPeakSyncVerificationPredicate;

interface NormalizedVerificationRequest {
  readonly artifact: FinalEncodedExportArtifact;
  readonly expected: NormalizedExpectation;
  readonly signal?: AbortSignal;
}

interface NormalizedDecodedFinalEncodedExport {
  readonly container: string;
  readonly durationUs: number;
  readonly videoStreams: readonly NormalizedDecodedVideoStream[];
  readonly audioStreams: readonly NormalizedDecodedAudioStream[];
}

interface NormalizedDecodedVideoStream {
  readonly streamId: string;
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  readonly durationUs: number;
  readonly presentationPtsUs: readonly number[];
  readonly presentationPtsComplete: true;
  readonly frames: readonly NormalizedDecodedVideoFrame[];
}

interface NormalizedDecodedVideoFrame {
  readonly ptsUs: number;
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

interface NormalizedDecodedAudioStream {
  readonly streamId: string;
  readonly codec: string;
  readonly durationUs: number;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly windows: readonly NormalizedDecodedAudioWindow[];
}

interface NormalizedDecodedAudioWindow {
  readonly startUs: number;
  readonly sampleRate: number;
  readonly channels: readonly Float32Array[];
}

class DecodedPixelBudgetError extends Error {}
class DecodedAudioBudgetError extends Error {}

/**
 * Reserve retained output before copying it. This protects the verifier from
 * a decoder reply whose individual frames/windows are under the cap but whose
 * aggregate would otherwise allocate beyond the contract.
 */
class RetainedDecodeBudget {
  #used = 0;

  constructor(
    readonly maximum: number,
    readonly error: DecodedPixelBudgetError | DecodedAudioBudgetError,
  ) {}

  reserve(amount: number): void {
    if (!isPositiveSafeInteger(amount) || amount > this.maximum - this.#used) throw this.error;
    this.#used += amount;
  }
}

/**
 * Creates a fail-closed final-export verifier. In production the caller must
 * inject a browser/headless decoder that actually decodes the completed Blob;
 * this module deliberately has no canvas, ffprobe, object URL, or fallback
 * implementation to accidentally certify a non-final artifact.
 */
export function createFinalEncodedExportVerifier(
  input: FinalEncodedExportVerifierOptions = {},
): FinalEncodedExportVerifier {
  const options = normalizeOptions(input);

  return {
    async verify(input) {
      const request = normalizeRequest(input, options);
      if (request.signal?.aborted === true) return cancelled();
      if (options.decoder === undefined) return unavailable('decoder-unavailable');
      if (!isActualDecoder(options.decoder)) return unavailable('decoder-not-actual');
      if (request.artifact.encoded.size > options.limits.maxArtifactBytes)
        return failed('artifact-too-large');

      const controller = new AbortController();
      const abortFromCaller = (): void => controller.abort();
      request.signal?.addEventListener('abort', abortFromCaller, { once: true });
      if (isAborted(request.signal)) controller.abort();

      try {
        if (controller.signal.aborted) return cancelled();
        let result: FinalEncodedExportDecoderResult;
        try {
          result = await options.decoder.decode(
            Object.freeze({
              artifact: request.artifact,
              requestedPixelPtsUs: request.expected.requestedPixelPtsUs,
              requestedAudioWindows: request.expected.requestedAudioWindows,
              limits: options.limits,
              signal: controller.signal,
            }),
          );
        } catch {
          return controller.signal.aborted ? cancelled() : failed('decoder-failed');
        }
        if (controller.signal.aborted) return cancelled();

        let decoderResult: FinalEncodedExportDecoderResult;
        try {
          decoderResult = normalizeDecoderResult(result);
        } catch {
          return failed('invalid-decoder-output');
        }
        if (decoderResult.status === 'unavailable') return unavailable(decoderResult.code);
        if (decoderResult.status === 'blocked') return blocked(decoderResult.code);

        let decoded: NormalizedDecodedFinalEncodedExport;
        try {
          decoded = normalizeDecodedExport(
            decoderResult.decoded,
            options.limits,
            request.expected.requestedPixelPtsUs,
            request.expected.requestedAudioWindows,
          );
        } catch (error) {
          if (error instanceof DecodedPixelBudgetError)
            return failed('decoded-pixel-budget-exceeded');
          if (error instanceof DecodedAudioBudgetError)
            return failed('decoded-audio-budget-exceeded');
          return failed('invalid-decoder-output');
        }
        if (controller.signal.aborted) return cancelled();
        return verifyDecodedFinalExport(decoded, request.expected);
      } finally {
        request.signal?.removeEventListener('abort', abortFromCaller);
      }
    },
  };
}

function normalizeOptions(input: FinalEncodedExportVerifierOptions): {
  readonly decoder?: FinalEncodedExportDecoder;
  readonly limits: FinalEncodedExportDecodeLimits;
} {
  try {
    if (
      !isPlainRecord(input) ||
      !hasOnlyKeys(
        input,
        [
          'decoder',
          'maxArtifactBytes',
          'maxPresentationPts',
          'maxDecodedFrames',
          'maxFramePixels',
          'maxDecodedPixelBytes',
          'maxAudioSampleValues',
        ],
        [],
      )
    )
      throw new Error();
    if (
      input.decoder !== undefined &&
      (input.decoder === null || typeof input.decoder !== 'object')
    )
      throw new Error();
    return Object.freeze({
      ...(input.decoder === undefined
        ? {}
        : { decoder: input.decoder as FinalEncodedExportDecoder }),
      limits: Object.freeze({
        maxArtifactBytes: boundedPositiveSafeInteger(
          input.maxArtifactBytes ?? DEFAULT_MAX_FINAL_ENCODED_ARTIFACT_BYTES,
          MAX_FINAL_ENCODED_ARTIFACT_BYTES,
        ),
        maxPresentationPts: boundedPositiveSafeInteger(
          input.maxPresentationPts ?? DEFAULT_MAX_FINAL_ENCODED_PRESENTATION_PTS,
          MAX_FINAL_ENCODED_PRESENTATION_PTS,
        ),
        maxDecodedFrames: boundedPositiveSafeInteger(
          input.maxDecodedFrames ?? DEFAULT_MAX_FINAL_ENCODED_DECODED_FRAMES,
          MAX_FINAL_ENCODED_DECODED_FRAMES,
        ),
        maxFramePixels: boundedPositiveSafeInteger(
          input.maxFramePixels ?? DEFAULT_MAX_FINAL_ENCODED_FRAME_PIXELS,
          MAX_FINAL_ENCODED_FRAME_PIXELS,
        ),
        maxDecodedPixelBytes: boundedPositiveSafeInteger(
          input.maxDecodedPixelBytes ?? DEFAULT_MAX_FINAL_ENCODED_PIXEL_BYTES,
          MAX_FINAL_ENCODED_PIXEL_BYTES,
        ),
        maxAudioSampleValues: boundedPositiveSafeInteger(
          input.maxAudioSampleValues ?? DEFAULT_MAX_FINAL_ENCODED_AUDIO_SAMPLE_VALUES,
          MAX_FINAL_ENCODED_AUDIO_SAMPLE_VALUES,
        ),
      }),
    });
  } catch {
    throw new FinalEncodedExportVerificationError('invalid-options');
  }
}

function normalizeRequest(
  input: FinalEncodedExportVerificationRequest,
  options: { readonly limits: FinalEncodedExportDecodeLimits },
): NormalizedVerificationRequest {
  try {
    if (
      !isPlainRecord(input) ||
      !hasOnlyKeys(input, ['artifact', 'expected', 'signal'], ['artifact', 'expected']) ||
      !isAbortSignal(input.signal)
    )
      throw new Error();
    const artifact = normalizeArtifact(input.artifact);
    const expected = normalizeExpectation(input.expected, options.limits);
    return Object.freeze({
      artifact,
      expected,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    if (error instanceof FinalEncodedExportVerificationError) throw error;
    throw new FinalEncodedExportVerificationError('invalid-request');
  }
}

function normalizeArtifact(input: unknown): FinalEncodedExportArtifact {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, ['artifactId', 'encoded']) ||
    !isOpaqueId(input.artifactId) ||
    !isBlobLike(input.encoded)
  )
    throw new Error();
  return Object.freeze({ artifactId: input.artifactId, encoded: input.encoded });
}

function normalizeExpectation(
  input: unknown,
  limits: FinalEncodedExportDecodeLimits,
): NormalizedExpectation {
  if (
    !isPlainRecord(input) ||
    !hasOnlyKeys(
      input,
      [
        'container',
        'width',
        'height',
        'durationUs',
        'expectedVideoPtsUs',
        'videoCodec',
        'audioCodec',
        'videoStreamCount',
        'audioStreamCount',
        'durationToleranceUs',
        'videoPtsToleranceUs',
        'visualPredicates',
        'audioSyncPredicates',
      ],
      [
        'container',
        'width',
        'height',
        'durationUs',
        'expectedVideoPtsUs',
        'visualPredicates',
        'audioSyncPredicates',
      ],
    ) ||
    !isSafeToken(input.container) ||
    !isPositiveSafeInteger(input.width) ||
    !isPositiveSafeInteger(input.height) ||
    !isPositiveSafeInteger(input.durationUs) ||
    !Array.isArray(input.expectedVideoPtsUs) ||
    input.expectedVideoPtsUs.length < 1 ||
    input.expectedVideoPtsUs.length > limits.maxPresentationPts ||
    (input.videoCodec !== undefined && !isSafeToken(input.videoCodec)) ||
    (input.audioCodec !== undefined && !isSafeToken(input.audioCodec)) ||
    (input.videoStreamCount !== undefined && !isBoundedStreamCount(input.videoStreamCount)) ||
    (input.audioStreamCount !== undefined && !isBoundedStreamCount(input.audioStreamCount)) ||
    (input.durationToleranceUs !== undefined &&
      !isNonNegativeSafeInteger(input.durationToleranceUs)) ||
    (input.videoPtsToleranceUs !== undefined &&
      !isNonNegativeSafeInteger(input.videoPtsToleranceUs)) ||
    !Array.isArray(input.visualPredicates) ||
    input.visualPredicates.length > MAX_PREDICATES ||
    !Array.isArray(input.audioSyncPredicates) ||
    input.audioSyncPredicates.length > MAX_PREDICATES
  )
    throw new Error();

  const durationUs = input.durationUs;
  const expectedVideoPtsUs = normalizeStrictlyIncreasingTimes(input.expectedVideoPtsUs);
  if (
    expectedVideoPtsUs.some((ptsUs) => ptsUs > durationUs) ||
    (input.durationToleranceUs !== undefined && input.durationToleranceUs > durationUs) ||
    (input.videoPtsToleranceUs !== undefined && input.videoPtsToleranceUs > durationUs)
  )
    throw new Error();
  const visualPredicates = normalizeVisualPredicates(
    input.visualPredicates,
    expectedVideoPtsUs,
    limits.maxDecodedFrames,
  );
  const audioSyncPredicates = normalizeAudioSyncPredicates(
    input.audioSyncPredicates,
    expectedVideoPtsUs,
  );
  const predicateIds = new Set<string>();
  for (const predicate of [...visualPredicates, ...audioSyncPredicates]) {
    if (predicateIds.has(predicate.id)) throw new Error();
    predicateIds.add(predicate.id);
  }
  // Metadata/packet enumeration is not decoded final-output evidence. Always
  // request one actual RGBA frame and one bounded PCM window from the final
  // Blob, then retain only aggregate facts in the receipt. These probes make
  // a damaged `mdat` or unavailable WebCodecs path fail closed without
  // pretending to make a subjective creative claim.
  const requiredVideoDecodePtsUs = Object.freeze([expectedVideoPtsUs[0]!]);
  const requiredAudioDecodeWindows = Object.freeze([createRequiredAudioDecodeWindow(durationUs)]);
  const requestedPixelPtsUs = Object.freeze(
    [
      ...new Set([
        ...requiredVideoDecodePtsUs,
        ...visualPredicates.map((predicate) => predicate.ptsUs),
      ]),
    ].sort((left, right) => left - right),
  );
  const requestedAudioWindows = createRequestedAudioWindows(
    requiredAudioDecodeWindows,
    audioSyncPredicates,
  );
  if (requestedAudioWindows.length > MAX_FINAL_ENCODED_REQUESTED_AUDIO_WINDOWS) throw new Error();
  return Object.freeze({
    container: input.container.toLowerCase(),
    width: input.width,
    height: input.height,
    durationUs,
    expectedVideoPtsUs,
    ...(input.videoCodec === undefined ? {} : { videoCodec: input.videoCodec.toLowerCase() }),
    ...(input.audioCodec === undefined ? {} : { audioCodec: input.audioCodec.toLowerCase() }),
    videoStreamCount: input.videoStreamCount ?? 1,
    audioStreamCount: input.audioStreamCount ?? 1,
    durationToleranceUs: input.durationToleranceUs ?? 0,
    videoPtsToleranceUs: input.videoPtsToleranceUs ?? 0,
    visualPredicates,
    audioSyncPredicates,
    requiredVideoDecodePtsUs,
    requiredAudioDecodeWindows,
    requestedPixelPtsUs,
    requestedAudioWindows,
  });
}

function createRequestedAudioWindows(
  requiredWindows: readonly FinalEncodedExportAudioDecodeWindow[],
  predicates: readonly NormalizedAudioPeakSyncPredicate[],
): readonly FinalEncodedExportAudioDecodeWindow[] {
  const sorted = [
    ...requiredWindows,
    ...predicates.map((predicate) => {
      const startUs = Math.max(0, predicate.expectedAudioPeakUs - predicate.maxDriftUs);
      // A zero-drift predicate still needs a non-empty interval. The browser
      // decoder expands that exact microsecond only to locate the overlapping
      // decoded audio sample; it does not request the entire audio track.
      const endUs = Math.max(startUs + 1, predicate.expectedAudioPeakUs + predicate.maxDriftUs + 1);
      if (!isPositiveSafeInteger(endUs)) throw new Error();
      return { startUs, endUs };
    }),
  ].sort((left, right) => left.startUs - right.startUs);
  const merged: FinalEncodedExportAudioDecodeWindow[] = [];
  for (const candidate of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || candidate.startUs > previous.endUs) {
      merged.push(Object.freeze(candidate));
      continue;
    }
    merged[merged.length - 1] = Object.freeze({
      startUs: previous.startUs,
      endUs: Math.max(previous.endUs, candidate.endUs),
    });
  }
  return Object.freeze(merged);
}

const REQUIRED_AUDIO_DECODE_WINDOW_US = 100_000;

function createRequiredAudioDecodeWindow(durationUs: number): FinalEncodedExportAudioDecodeWindow {
  const endUs = Math.min(durationUs, REQUIRED_AUDIO_DECODE_WINDOW_US);
  // `durationUs` has already passed positive-integer validation. A tiny
  // single-frame export therefore still gets a non-empty exact window.
  return Object.freeze({ startUs: 0, endUs });
}

function normalizeVisualPredicates(
  values: readonly unknown[],
  expectedPtsUs: readonly number[],
  maxDecodedFrames: number,
): readonly NormalizedVisualPredicate[] {
  const normalized: NormalizedVisualPredicate[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    if (!isPlainRecord(value) || typeof value.kind !== 'string') throw new Error();
    if (value.kind === 'pixel') {
      if (
        !hasExactKeys(value, [
          'kind',
          'id',
          'target',
          'ptsUs',
          'x',
          'y',
          'expectedRgba',
          'tolerance',
        ]) ||
        !isOpaqueId(value.id) ||
        (value.target !== 'title' && value.target !== 'effect') ||
        !isExpectedPts(value.ptsUs, expectedPtsUs) ||
        !isNonNegativeSafeInteger(value.x) ||
        !isNonNegativeSafeInteger(value.y) ||
        !isRgba(value.expectedRgba) ||
        !isByte(value.tolerance)
      )
        throw new Error();
      if (ids.has(value.id)) throw new Error();
      ids.add(value.id);
      normalized.push(
        Object.freeze({
          kind: 'pixel',
          id: value.id,
          target: value.target,
          ptsUs: value.ptsUs,
          x: value.x,
          y: value.y,
          expectedRgba: Object.freeze([...value.expectedRgba]) as readonly [
            number,
            number,
            number,
            number,
          ],
          tolerance: value.tolerance,
        }),
      );
      continue;
    }
    if (
      value.kind !== 'black-frame' ||
      !hasExactKeys(value, [
        'kind',
        'id',
        'ptsUs',
        'expected',
        'blackThreshold',
        'minimumFraction',
      ]) ||
      !isOpaqueId(value.id) ||
      !isExpectedPts(value.ptsUs, expectedPtsUs) ||
      (value.expected !== 'black' && value.expected !== 'non-black') ||
      !isByte(value.blackThreshold) ||
      !isPositiveUnitFraction(value.minimumFraction)
    )
      throw new Error();
    if (ids.has(value.id)) throw new Error();
    ids.add(value.id);
    normalized.push(
      Object.freeze({
        kind: 'black-frame',
        id: value.id,
        ptsUs: value.ptsUs,
        expected: value.expected,
        blackThreshold: value.blackThreshold,
        minimumFraction: value.minimumFraction,
      }),
    );
  }
  const distinctTimes = new Set(normalized.map((predicate) => predicate.ptsUs));
  if (distinctTimes.size > maxDecodedFrames) throw new Error();
  return Object.freeze(normalized);
}

function normalizeAudioSyncPredicates(
  values: readonly unknown[],
  expectedPtsUs: readonly number[],
): readonly NormalizedAudioPeakSyncPredicate[] {
  const normalized: NormalizedAudioPeakSyncPredicate[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, [
        'kind',
        'id',
        'videoPtsUs',
        'expectedAudioPeakUs',
        'maxDriftUs',
        'minimumPeakAmplitude',
      ]) ||
      value.kind !== 'audio-peak-sync' ||
      !isOpaqueId(value.id) ||
      !isExpectedPts(value.videoPtsUs, expectedPtsUs) ||
      !isNonNegativeSafeInteger(value.expectedAudioPeakUs) ||
      !isNonNegativeSafeInteger(value.maxDriftUs) ||
      !isPositiveUnitFraction(value.minimumPeakAmplitude)
    )
      throw new Error();
    if (ids.has(value.id)) throw new Error();
    ids.add(value.id);
    normalized.push(
      Object.freeze({
        kind: 'audio-peak-sync',
        id: value.id,
        videoPtsUs: value.videoPtsUs,
        expectedAudioPeakUs: value.expectedAudioPeakUs,
        maxDriftUs: value.maxDriftUs,
        minimumPeakAmplitude: value.minimumPeakAmplitude,
      }),
    );
  }
  return Object.freeze(normalized);
}

function normalizeDecoderResult(value: unknown): FinalEncodedExportDecoderResult {
  if (!isPlainRecord(value) || typeof value.status !== 'string')
    throw new Error('invalid decoder result');
  if (
    value.status === 'decoded' &&
    hasExactKeys(value, ['status', 'decoded']) &&
    value.decoded !== undefined
  )
    return value as unknown as FinalEncodedExportDecoderResult;
  if (
    value.status === 'unavailable' &&
    hasExactKeys(value, ['status', 'code']) &&
    (value.code === 'decoder-unavailable' || value.code === 'format-unsupported')
  )
    return value as unknown as FinalEncodedExportDecoderResult;
  if (
    value.status === 'blocked' &&
    hasExactKeys(value, ['status', 'code']) &&
    (value.code === 'artifact-not-readable' || value.code === 'decoder-policy')
  )
    return value as unknown as FinalEncodedExportDecoderResult;
  throw new Error('invalid decoder result');
}

function normalizeDecodedExport(
  input: unknown,
  limits: FinalEncodedExportDecodeLimits,
  requestedPixelPtsUs: readonly number[],
  requestedAudioWindows: readonly FinalEncodedExportAudioDecodeWindow[],
): NormalizedDecodedFinalEncodedExport {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, ['container', 'durationUs', 'videoStreams', 'audioStreams']) ||
    !isSafeToken(input.container) ||
    !isPositiveSafeInteger(input.durationUs) ||
    !Array.isArray(input.videoStreams) ||
    !Array.isArray(input.audioStreams) ||
    input.videoStreams.length > MAX_STREAMS ||
    input.audioStreams.length > MAX_STREAMS
  )
    throw new Error();
  const retainedPixelBudget = new RetainedDecodeBudget(
    limits.maxDecodedPixelBytes,
    new DecodedPixelBudgetError(),
  );
  const retainedAudioBudget = new RetainedDecodeBudget(
    limits.maxAudioSampleValues,
    new DecodedAudioBudgetError(),
  );
  const videoStreams = input.videoStreams.map((stream) => {
    return normalizeDecodedVideoStream(stream, limits, requestedPixelPtsUs, retainedPixelBudget);
  });
  const audioStreams = input.audioStreams.map((stream) => {
    return normalizeDecodedAudioStream(stream, limits, requestedAudioWindows, retainedAudioBudget);
  });
  return Object.freeze({
    container: input.container.toLowerCase(),
    durationUs: input.durationUs,
    videoStreams: Object.freeze(videoStreams),
    audioStreams: Object.freeze(audioStreams),
  });
}

function normalizeDecodedVideoStream(
  input: unknown,
  limits: FinalEncodedExportDecodeLimits,
  requestedPixelPtsUs: readonly number[],
  retainedPixelBudget: RetainedDecodeBudget,
): NormalizedDecodedVideoStream {
  const candidate = isPlainRecord(input) ? input : undefined;
  const width = candidate?.width;
  const height = candidate?.height;
  if (
    candidate === undefined ||
    !hasExactKeys(candidate, [
      'streamId',
      'codec',
      'width',
      'height',
      'durationUs',
      'presentationPtsUs',
      'presentationPtsComplete',
      'frames',
    ]) ||
    !isOpaqueId(candidate.streamId) ||
    !isSafeToken(candidate.codec) ||
    !isPositiveSafeInteger(width) ||
    !isPositiveSafeInteger(height) ||
    !isPositiveSafeInteger(candidate.durationUs) ||
    !Array.isArray(candidate.presentationPtsUs) ||
    candidate.presentationPtsUs.length > limits.maxPresentationPts ||
    candidate.presentationPtsComplete !== true ||
    !Array.isArray(candidate.frames) ||
    candidate.frames.length > limits.maxDecodedFrames
  )
    throw new Error();
  const presentationPtsUs = normalizeStrictlyIncreasingTimes(candidate.presentationPtsUs);
  const frames = candidate.frames.map((frame) =>
    normalizeDecodedVideoFrame(
      frame,
      width,
      height,
      limits,
      requestedPixelPtsUs,
      retainedPixelBudget,
    ),
  );
  const frameIds = new Set<number>();
  for (const frame of frames) {
    if (frameIds.has(frame.ptsUs)) throw new Error();
    frameIds.add(frame.ptsUs);
  }
  return Object.freeze({
    streamId: candidate.streamId,
    codec: candidate.codec.toLowerCase(),
    width,
    height,
    durationUs: candidate.durationUs,
    presentationPtsUs,
    presentationPtsComplete: true as const,
    frames: Object.freeze(frames),
  });
}

function normalizeDecodedVideoFrame(
  input: unknown,
  streamWidth: number,
  streamHeight: number,
  limits: FinalEncodedExportDecodeLimits,
  requestedPixelPtsUs: readonly number[],
  retainedPixelBudget: RetainedDecodeBudget,
): NormalizedDecodedVideoFrame {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, ['ptsUs', 'width', 'height', 'rgba']) ||
    !isNonNegativeSafeInteger(input.ptsUs) ||
    !requestedPixelPtsUs.includes(input.ptsUs) ||
    input.width !== streamWidth ||
    input.height !== streamHeight ||
    !(input.rgba instanceof Uint8Array || input.rgba instanceof Uint8ClampedArray)
  )
    throw new Error();
  const pixels = input.width * input.height;
  const expectedBytes = pixels * 4;
  if (
    !Number.isSafeInteger(pixels) ||
    !Number.isSafeInteger(expectedBytes) ||
    pixels > limits.maxFramePixels ||
    expectedBytes > limits.maxDecodedPixelBytes
  )
    throw new DecodedPixelBudgetError();
  if (input.rgba.byteLength !== expectedBytes) throw new Error();
  // Reserve before `Uint8Array.from` allocates the verifier-owned copy.
  retainedPixelBudget.reserve(expectedBytes);
  return Object.freeze({
    ptsUs: input.ptsUs,
    width: input.width,
    height: input.height,
    rgba: Uint8Array.from(input.rgba),
  });
}

function normalizeDecodedAudioStream(
  input: unknown,
  limits: FinalEncodedExportDecodeLimits,
  requestedAudioWindows: readonly FinalEncodedExportAudioDecodeWindow[],
  retainedAudioBudget: RetainedDecodeBudget,
): NormalizedDecodedAudioStream {
  const candidate = isPlainRecord(input) ? input : undefined;
  const channelCount = candidate?.channelCount;
  if (
    candidate === undefined ||
    !hasExactKeys(candidate, [
      'streamId',
      'codec',
      'durationUs',
      'sampleRate',
      'channelCount',
      'windows',
    ]) ||
    !isOpaqueId(candidate.streamId) ||
    !isSafeToken(candidate.codec) ||
    !isPositiveSafeInteger(candidate.durationUs) ||
    !isPositiveSafeInteger(candidate.sampleRate) ||
    !isPositiveSafeInteger(channelCount) ||
    channelCount > 32 ||
    !Array.isArray(candidate.windows) ||
    candidate.windows.length > limits.maxDecodedFrames
  )
    throw new Error();
  const windows = candidate.windows.map((window) =>
    normalizeDecodedAudioWindow(
      window,
      channelCount,
      limits,
      requestedAudioWindows,
      retainedAudioBudget,
    ),
  );
  return Object.freeze({
    streamId: candidate.streamId,
    codec: candidate.codec.toLowerCase(),
    durationUs: candidate.durationUs,
    sampleRate: candidate.sampleRate,
    channelCount,
    windows: Object.freeze(windows),
  });
}

function normalizeDecodedAudioWindow(
  input: unknown,
  channelCount: number,
  limits: FinalEncodedExportDecodeLimits,
  requestedAudioWindows: readonly FinalEncodedExportAudioDecodeWindow[],
  retainedAudioBudget: RetainedDecodeBudget,
): NormalizedDecodedAudioWindow {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, ['startUs', 'sampleRate', 'channels']) ||
    !isNonNegativeSafeInteger(input.startUs) ||
    !isPositiveSafeInteger(input.sampleRate) ||
    !Array.isArray(input.channels) ||
    input.channels.length !== channelCount ||
    input.channels.some((channel) => !(channel instanceof Float32Array))
  )
    throw new Error();
  // The guards above establish these numbers; bind them before the callback
  // below so TypeScript cannot lose the narrowing across the closure.
  const startUs = input.startUs as number;
  const sampleRate = input.sampleRate as number;
  const length = input.channels[0]?.length ?? 0;
  if (length > limits.maxAudioSampleValues) throw new DecodedAudioBudgetError();
  const endUs = safeAudioWindowEndUs(startUs, length, sampleRate);
  if (
    !requestedAudioWindows.some(
      (requested) => startUs < requested.endUs && endUs > requested.startUs,
    )
  )
    throw new Error();
  for (const channel of input.channels) {
    if (channel.length !== length) throw new Error();
    for (const sample of channel) {
      if (!Number.isFinite(sample)) throw new Error();
    }
  }
  if (length > 0) {
    const values = safeRetainedAudioValueCount(length, channelCount);
    // Reserve the aggregate window before any verifier-owned PCM copy.
    retainedAudioBudget.reserve(values);
  }
  const channels = input.channels.map((channel) => Float32Array.from(channel));
  return Object.freeze({
    startUs,
    sampleRate,
    channels: Object.freeze(channels),
  });
}

function safeAudioWindowEndUs(startUs: number, length: number, sampleRate: number): number {
  const durationUs = Math.round((length * 1_000_000) / sampleRate);
  const endUs = startUs + durationUs;
  if (!isNonNegativeSafeInteger(durationUs) || !isNonNegativeSafeInteger(endUs)) throw new Error();
  return endUs;
}

function safeRetainedAudioValueCount(length: number, channelCount: number): number {
  const values = length * channelCount;
  if (!isPositiveSafeInteger(values)) throw new DecodedAudioBudgetError();
  return values;
}

function verifyDecodedFinalExport(
  decoded: NormalizedDecodedFinalEncodedExport,
  expected: NormalizedExpectation,
): FinalEncodedExportVerificationResult {
  const checks: FinalEncodedExportVerificationCheck[] = [];
  if (decoded.container !== expected.container) return failed('container-mismatch');
  checks.push(check('container', 'container'));

  if (decoded.videoStreams.length !== expected.videoStreamCount || decoded.videoStreams.length < 1)
    return failed('video-streams-mismatch');
  checks.push(check('video-streams', 'video-streams'));
  if (decoded.audioStreams.length !== expected.audioStreamCount || decoded.audioStreams.length < 1)
    return failed('audio-streams-mismatch');
  checks.push(check('audio-streams', 'audio-streams'));

  const video = decoded.videoStreams[0]!;
  const audio = decoded.audioStreams[0]!;
  if (video.width !== expected.width || video.height !== expected.height)
    return failed('dimensions-mismatch');
  checks.push(check('dimensions', 'dimensions'));
  if (
    !withinTolerance(decoded.durationUs, expected.durationUs, expected.durationToleranceUs) ||
    !withinTolerance(video.durationUs, expected.durationUs, expected.durationToleranceUs) ||
    !withinTolerance(audio.durationUs, expected.durationUs, expected.durationToleranceUs)
  )
    return failed('duration-mismatch');
  checks.push(check('duration', 'duration'));
  if (expected.videoCodec !== undefined && video.codec !== expected.videoCodec)
    return failed('video-codec-mismatch');
  if (expected.audioCodec !== undefined && audio.codec !== expected.audioCodec)
    return failed('audio-codec-mismatch');

  if (video.presentationPtsComplete !== true) return failed('video-pts-incomplete');
  if (!samePts(video.presentationPtsUs, expected.expectedVideoPtsUs, expected.videoPtsToleranceUs))
    return failed('video-pts-mismatch');
  checks.push(check('video-pts', 'video-pts'));

  // A packet timeline alone is not proof that the final artifact decodes. The
  // required probes are non-subjective: they only prove that bounded RGBA and
  // PCM values were actually materialized from the encoded Blob.
  for (const ptsUs of expected.requiredVideoDecodePtsUs) {
    if (findFrameForPts(video.frames, ptsUs, expected.videoPtsToleranceUs) === undefined)
      return failed('missing-decoded-frame', 'decoded-video-sample');
  }
  checks.push(check('decoded-video-sample', 'video-decode'));

  for (const window of expected.requiredAudioDecodeWindows) {
    if (!hasDecodedAudioEvidence(audio, window))
      return failed('missing-decoded-audio', 'decoded-audio-sample');
  }
  checks.push(check('decoded-audio-sample', 'audio-decode'));

  for (const predicate of expected.visualPredicates) {
    const frame = findFrameForPts(video.frames, predicate.ptsUs, expected.videoPtsToleranceUs);
    if (frame === undefined) return failed('missing-decoded-frame', predicate.id);
    if (predicate.kind === 'pixel') {
      if (!matchesExpectedPixel(frame, predicate))
        return failed('pixel-predicate-failed', predicate.id);
      checks.push(check(predicate.id, 'pixel'));
      continue;
    }
    if (!matchesBlackFramePredicate(frame, predicate))
      return failed('black-frame-predicate-failed', predicate.id);
    checks.push(check(predicate.id, 'black-frame'));
  }

  for (const predicate of expected.audioSyncPredicates) {
    if (!matchesAudioPeakSync(audio, predicate))
      return failed('audio-sync-predicate-failed', predicate.id);
    checks.push(check(predicate.id, 'audio-sync'));
  }

  return Object.freeze({
    status: 'verified' as const,
    scope: 'decoded-final-encoded-export' as const,
    facts: Object.freeze({
      container: decoded.container,
      width: video.width,
      height: video.height,
      durationUs: decoded.durationUs,
      videoStreamCount: decoded.videoStreams.length,
      audioStreamCount: decoded.audioStreams.length,
      presentationFrameCount: video.presentationPtsUs.length,
    }),
    checks: Object.freeze(checks),
  });
}

function matchesExpectedPixel(
  frame: NormalizedDecodedVideoFrame,
  predicate: Extract<NormalizedVisualPredicate, { readonly kind: 'pixel' }>,
): boolean {
  if (predicate.x >= frame.width || predicate.y >= frame.height) return false;
  const offset = (predicate.y * frame.width + predicate.x) * 4;
  return predicate.expectedRgba.every(
    (expected, index) => Math.abs(frame.rgba[offset + index]! - expected) <= predicate.tolerance,
  );
}

function matchesBlackFramePredicate(
  frame: NormalizedDecodedVideoFrame,
  predicate: Extract<NormalizedVisualPredicate, { readonly kind: 'black-frame' }>,
): boolean {
  const pixelCount = frame.width * frame.height;
  let blackCount = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    if (
      frame.rgba[offset]! <= predicate.blackThreshold &&
      frame.rgba[offset + 1]! <= predicate.blackThreshold &&
      frame.rgba[offset + 2]! <= predicate.blackThreshold
    )
      blackCount += 1;
  }
  const fraction =
    predicate.expected === 'black' ? blackCount / pixelCount : 1 - blackCount / pixelCount;
  return fraction >= predicate.minimumFraction;
}

function matchesAudioPeakSync(
  audio: NormalizedDecodedAudioStream,
  predicate: NormalizedAudioPeakSyncPredicate,
): boolean {
  let peakAmplitude = -1;
  let peakTimeUs: number | undefined;
  const startUs = Math.max(0, predicate.expectedAudioPeakUs - predicate.maxDriftUs);
  const endUs = predicate.expectedAudioPeakUs + predicate.maxDriftUs;
  for (const window of audio.windows) {
    for (const channel of window.channels) {
      for (let index = 0; index < channel.length; index += 1) {
        const timeUs = window.startUs + Math.round((index * 1_000_000) / window.sampleRate);
        if (timeUs < startUs || timeUs > endUs) continue;
        const amplitude = Math.abs(channel[index]!);
        if (amplitude > peakAmplitude) {
          peakAmplitude = amplitude;
          peakTimeUs = timeUs;
        }
      }
    }
  }
  return (
    peakTimeUs !== undefined &&
    peakAmplitude >= predicate.minimumPeakAmplitude &&
    Math.abs(peakTimeUs - predicate.expectedAudioPeakUs) <= predicate.maxDriftUs &&
    Math.abs(peakTimeUs - predicate.videoPtsUs) <= predicate.maxDriftUs
  );
}

function hasDecodedAudioEvidence(
  audio: NormalizedDecodedAudioStream,
  required: FinalEncodedExportAudioDecodeWindow,
): boolean {
  return audio.windows.some((window) => {
    const sampleCount = window.channels[0]?.length ?? 0;
    if (sampleCount < 1 || window.channels.some((channel) => channel.length !== sampleCount))
      return false;
    const endUs = safeAudioWindowEndUs(window.startUs, sampleCount, window.sampleRate);
    return window.startUs < required.endUs && endUs > required.startUs;
  });
}

function samePts(
  actual: readonly number[],
  expected: readonly number[],
  toleranceUs: number,
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((ptsUs, index) => Math.abs(ptsUs - expected[index]!) <= toleranceUs)
  );
}

function findFrameForPts(
  frames: readonly NormalizedDecodedVideoFrame[],
  ptsUs: number,
  toleranceUs: number,
): NormalizedDecodedVideoFrame | undefined {
  return frames.find((frame) => Math.abs(frame.ptsUs - ptsUs) <= toleranceUs);
}

function withinTolerance(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function check(id: string, kind: FinalEncodedExportCheckKind): FinalEncodedExportVerificationCheck {
  return Object.freeze({ id, kind });
}

function failed(
  code: FinalEncodedExportVerificationFailureCode,
  checkId?: string,
): FinalEncodedExportVerificationFailure {
  return Object.freeze({
    status: 'failed' as const,
    code,
    ...(checkId === undefined ? {} : { checkId }),
  });
}

function unavailable(
  code: FinalEncodedExportVerificationUnavailable['code'],
): FinalEncodedExportVerificationUnavailable {
  return Object.freeze({ status: 'unavailable' as const, code });
}

function blocked(
  code: FinalEncodedExportVerificationBlocked['code'],
): FinalEncodedExportVerificationBlocked {
  return Object.freeze({ status: 'blocked' as const, code });
}

function cancelled(): FinalEncodedExportVerificationCancelled {
  return Object.freeze({ status: 'cancelled' as const });
}

function isActualDecoder(value: unknown): value is FinalEncodedExportDecoder {
  try {
    return (
      value !== null &&
      typeof value === 'object' &&
      (value as FinalEncodedExportDecoder).kind === 'actual-encoded-export-decoder' &&
      isSafeToken((value as FinalEncodedExportDecoder).version) &&
      typeof (value as FinalEncodedExportDecoder).decode === 'function'
    );
  } catch {
    return false;
  }
}

function isBlobLike(value: unknown): value is Blob {
  return (
    value !== null &&
    typeof value === 'object' &&
    Number.isSafeInteger((value as Blob).size) &&
    (value as Blob).size >= 0 &&
    typeof (value as Blob).arrayBuffer === 'function'
  );
}

function isExpectedPts(value: unknown, expectedPtsUs: readonly number[]): value is number {
  return isNonNegativeSafeInteger(value) && expectedPtsUs.includes(value);
}

function normalizeStrictlyIncreasingTimes(values: readonly unknown[]): readonly number[] {
  const normalized: number[] = [];
  let previous = -1;
  for (const value of values) {
    if (!isNonNegativeSafeInteger(value) || value <= previous) throw new Error();
    normalized.push(value);
    previous = value;
  }
  return Object.freeze(normalized);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function isSafeToken(value: unknown): value is string {
  return typeof value === 'string' && SAFE_TOKEN.test(value);
}

function isRgba(value: unknown): value is readonly [number, number, number, number] {
  return Array.isArray(value) && value.length === 4 && value.every(isByte);
}

function isByte(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
}

function isUnitFraction(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isPositiveUnitFraction(value: unknown): value is number {
  return isUnitFraction(value) && value > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedStreamCount(value: unknown): value is number {
  return isPositiveSafeInteger(value) && value <= MAX_STREAMS;
}

function boundedPositiveSafeInteger(value: unknown, maximum: number): number {
  if (!isPositiveSafeInteger(value) || value > maximum) throw new Error();
  return value;
}

function isAbortSignal(value: unknown): value is AbortSignal | undefined {
  return (
    value === undefined ||
    (value !== null &&
      typeof value === 'object' &&
      typeof (value as AbortSignal).aborted === 'boolean' &&
      typeof (value as AbortSignal).addEventListener === 'function' &&
      typeof (value as AbortSignal).removeEventListener === 'function')
  );
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)];
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const actual = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)];
  return (
    actual.every((key) => typeof key === 'string' && allowed.includes(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
