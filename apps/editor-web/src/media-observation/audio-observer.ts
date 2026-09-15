import {
  AudioObservationError,
  MAX_AUDIO_ENVELOPE_SAMPLE_VISITS,
  MAX_AUDIO_ENVELOPE_POINTS,
  MAX_AUDIO_OBSERVATION_CHANNELS,
  analyzeAudioObservationWindow,
  buildBeatEnvelope,
  extractAudioObservationWindow,
  type AudioCompositionTimeMapping,
  type AudioObservationAnalysis,
  type AudioObservationWindow,
  type BeatEnvelopeEstimate,
} from '@joy-media/audio-core';

/** Avoid accepting compressed inputs that could expand into unbounded PCM. */
export const DEFAULT_MAX_AUDIO_OBSERVATION_INPUT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_AUDIO_OBSERVATION_DECODED_BYTES = 64 * 1024 * 1024;
/** Matches the local envelope core's declared maximum sample visit budget. */
export const DEFAULT_MAX_AUDIO_OBSERVATION_ANALYSIS_SAMPLE_VISITS =
  MAX_AUDIO_ENVELOPE_SAMPLE_VISITS;

export type BrowserAudioObservationErrorCode =
  | 'cancelled'
  | 'invalid-request'
  | 'input-too-large'
  | 'input-read-failed'
  | 'decode-failed'
  | 'unsupported-audio'
  | 'decoded-audio-too-large'
  | 'analysis-too-large'
  | 'analysis-failed';

/**
 * Safe error vocabulary for the host/UI. Browser decoder messages can include
 * file names or URLs, so they never cross this boundary.
 */
export class BrowserAudioObservationError extends Error {
  constructor(
    readonly code: BrowserAudioObservationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserAudioObservationError';
  }
}

export interface BrowserAudioBufferLike {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

export interface BrowserAudioContextLike {
  decodeAudioData(data: ArrayBuffer): Promise<BrowserAudioBufferLike>;
  close(): Promise<void>;
}

export interface BrowserAudioObservationRequest {
  /** Host-owned bytes; a provider never receives this Blob through this API. */
  readonly source: Blob;
  readonly sourceOffsetUs: number;
  /** End-exclusive source timeline interval. */
  readonly range: { readonly startUs: number; readonly endUs: number };
  readonly mapping?: AudioCompositionTimeMapping;
  readonly resampleRate?: number;
  readonly signal?: AbortSignal;
}

export interface BrowserAudioObservationResult {
  readonly algorithmVersion: 'joy-browser-audio-observer-v1';
  /** Decode facts only; no original blob/URL/path crosses the result boundary. */
  readonly decoded: {
    readonly sourceSampleRate: number;
    readonly channelCount: number;
    readonly sourceSampleCount: number;
    readonly decodedBytes: number;
  };
  readonly window: AudioObservationWindow;
  readonly analysis: AudioObservationAnalysis;
  readonly beat: BeatEnvelopeEstimate;
}

export interface BrowserAudioObserverOptions {
  /** Full Blob bytes read before Web Audio is asked to decode. */
  readonly maxInputBytes?: number;
  /**
   * Rejects an oversized decoded AudioBuffer immediately after Web Audio
   * returns it. `decodeAudioData` has no bounded/windowed browser API, so
   * this cannot prevent a compressed input from allocating during decoding.
   */
  readonly maxDecodedBytes?: number;
  /**
   * Maximum aggregate selected-source or output PCM samples in one analysis pass.
   * The observer enforces it before validating/copying/resampling its window.
   */
  readonly maxAnalysisSampleVisits?: number;
  readonly audioContextFactory?: () => BrowserAudioContextLike;
}

export interface BrowserAudioObserver {
  observe(request: BrowserAudioObservationRequest): Promise<BrowserAudioObservationResult>;
}

/**
 * Browser audio observation is intentionally a bounded local adapter. It
 * reads one owner-provided Blob, returns a copied analysis window, and closes
 * the decoding context before resolving. Web Audio only exposes a full-source
 * decode, not a streaming or temporal-range decoder: this adapter therefore
 * fails closed on enforceable Blob/window budgets and rejects decoded buffers
 * immediately after decoding. A long/large source must be narrowed by the
 * caller rather than silently being described as window-streamed analysis.
 */
export function createBrowserAudioObserver(
  options: BrowserAudioObserverOptions = {},
): BrowserAudioObserver {
  const maxInputBytes = positiveSafeInteger(
    options.maxInputBytes ?? DEFAULT_MAX_AUDIO_OBSERVATION_INPUT_BYTES,
    'maxInputBytes',
  );
  const maxDecodedBytes = positiveSafeInteger(
    options.maxDecodedBytes ?? DEFAULT_MAX_AUDIO_OBSERVATION_DECODED_BYTES,
    'maxDecodedBytes',
  );
  const maxAnalysisSampleVisits = positiveSafeIntegerAtMost(
    options.maxAnalysisSampleVisits ?? DEFAULT_MAX_AUDIO_OBSERVATION_ANALYSIS_SAMPLE_VISITS,
    'maxAnalysisSampleVisits',
    MAX_AUDIO_ENVELOPE_SAMPLE_VISITS,
  );
  const createContext = options.audioContextFactory ?? defaultAudioContextFactory;

  return {
    async observe(request) {
      assertRequest(request);
      throwIfAborted(request.signal);
      if (request.source.size > maxInputBytes)
        throw new BrowserAudioObservationError(
          'input-too-large',
          'The selected audio is too large for local observation. Narrow the source or range.',
        );

      let encoded: ArrayBuffer;
      try {
        encoded = await request.source.arrayBuffer();
      } catch {
        throw new BrowserAudioObservationError(
          'input-read-failed',
          'JOY could not read the selected audio for local observation.',
        );
      }
      throwIfAborted(request.signal);
      if (encoded.byteLength > maxInputBytes)
        throw new BrowserAudioObservationError(
          'input-too-large',
          'The selected audio is too large for local observation. Narrow the source or range.',
        );

      const context = createContext();
      try {
        let decoded: BrowserAudioBufferLike;
        try {
          decoded = await context.decodeAudioData(encoded);
        } catch {
          if (request.signal?.aborted === true) throw cancelledError();
          throw new BrowserAudioObservationError(
            'decode-failed',
            'JOY could not decode the selected audio for local observation.',
          );
        }
        throwIfAborted(request.signal);

        const decodedFacts = validateDecodedBuffer(decoded, maxDecodedBytes);
        const channelData = readDecodedChannels(decoded, decodedFacts.channelCount);
        const window = extractBoundedAudioWindow({
          sampleRate: decodedFacts.sourceSampleRate,
          channelData,
          sourceOffsetUs: request.sourceOffsetUs,
          range: request.range,
          maxAnalysisSampleVisits,
          ...(request.resampleRate === undefined ? {} : { resampleRate: request.resampleRate }),
          ...(request.mapping === undefined ? {} : { mapping: request.mapping }),
        });
        throwIfAborted(request.signal);

        try {
          const samplesPerEnvelopePoint = Math.max(
            1,
            Math.ceil(window.sampleCount / MAX_AUDIO_ENVELOPE_POINTS),
          );
          return Object.freeze({
            algorithmVersion: 'joy-browser-audio-observer-v1' as const,
            decoded: Object.freeze(decodedFacts),
            window,
            analysis: analyzeAudioObservationWindow(window),
            beat: buildBeatEnvelope(window, {
              frameSizeSamples: samplesPerEnvelopePoint,
              hopSamples: samplesPerEnvelopePoint,
            }),
          });
        } catch (error) {
          if (error instanceof BrowserAudioObservationError) throw error;
          throw new BrowserAudioObservationError(
            'analysis-failed',
            'JOY could not complete bounded local audio analysis for this range.',
          );
        }
      } finally {
        await context.close().catch(() => undefined);
      }
    },
  };
}

function extractBoundedAudioWindow(input: {
  readonly sampleRate: number;
  readonly channelData: readonly Float32Array[];
  readonly sourceOffsetUs: number;
  readonly range: BrowserAudioObservationRequest['range'];
  readonly maxAnalysisSampleVisits: number;
  readonly mapping?: AudioCompositionTimeMapping;
  readonly resampleRate?: number;
}): AudioObservationWindow {
  try {
    return extractAudioObservationWindow(
      {
        sampleRate: input.sampleRate,
        channelData: input.channelData,
        sourceOffsetUs: input.sourceOffsetUs,
      },
      {
        sourceStartUs: input.range.startUs,
        durationUs: input.range.endUs - input.range.startUs,
        maxSampleVisits: input.maxAnalysisSampleVisits,
        ...(input.resampleRate === undefined ? {} : { resampleRate: input.resampleRate }),
        ...(input.mapping === undefined ? {} : { mapping: input.mapping }),
      },
    );
  } catch (error) {
    if (!(error instanceof AudioObservationError))
      throw new BrowserAudioObservationError(
        'analysis-failed',
        'JOY could not prepare bounded local audio analysis for this range.',
      );
    if (error.code === 'AUDIO_OBSERVATION_BOUNDS')
      throw new BrowserAudioObservationError(
        'analysis-too-large',
        'The selected audio range is too large for bounded local analysis. Narrow the range.',
      );
    if (
      error.code === 'AUDIO_OBSERVATION_INVALID_REQUEST' ||
      error.code === 'AUDIO_OBSERVATION_INVALID_MAPPING'
    )
      throw new BrowserAudioObservationError(
        'invalid-request',
        'Audio observation request is invalid.',
      );
    throw new BrowserAudioObservationError(
      'unsupported-audio',
      'The selected audio has an unsupported local decode format.',
    );
  }
}

function defaultAudioContextFactory(): BrowserAudioContextLike {
  if (typeof AudioContext === 'undefined')
    throw new BrowserAudioObservationError(
      'unsupported-audio',
      'This browser cannot decode audio for local observation.',
    );
  return new AudioContext();
}

function assertRequest(request: BrowserAudioObservationRequest): void {
  if (request === null || typeof request !== 'object')
    throw new BrowserAudioObservationError(
      'invalid-request',
      'Audio observation request is invalid.',
    );
  if (
    request.source === null ||
    typeof request.source !== 'object' ||
    !Number.isSafeInteger(request.source.size) ||
    request.source.size < 0 ||
    typeof request.source.arrayBuffer !== 'function' ||
    !isNonNegativeSafeInteger(request.sourceOffsetUs) ||
    request.range === null ||
    typeof request.range !== 'object' ||
    !isNonNegativeSafeInteger(request.range.startUs) ||
    !isNonNegativeSafeInteger(request.range.endUs) ||
    request.range.endUs <= request.range.startUs
  ) {
    throw new BrowserAudioObservationError(
      'invalid-request',
      'Audio observation request is invalid.',
    );
  }
  if (
    request.resampleRate !== undefined &&
    (!Number.isSafeInteger(request.resampleRate) || request.resampleRate <= 0)
  ) {
    throw new BrowserAudioObservationError(
      'invalid-request',
      'Audio observation request is invalid.',
    );
  }
}

function validateDecodedBuffer(
  decoded: BrowserAudioBufferLike,
  maxDecodedBytes: number,
): BrowserAudioObservationResult['decoded'] {
  if (
    decoded === null ||
    typeof decoded !== 'object' ||
    !Number.isSafeInteger(decoded.sampleRate) ||
    decoded.sampleRate <= 0 ||
    !Number.isSafeInteger(decoded.numberOfChannels) ||
    decoded.numberOfChannels < 1 ||
    decoded.numberOfChannels > MAX_AUDIO_OBSERVATION_CHANNELS ||
    !Number.isSafeInteger(decoded.length) ||
    decoded.length < 1
  ) {
    throw new BrowserAudioObservationError(
      'unsupported-audio',
      'The selected audio has an unsupported local decode format.',
    );
  }
  const decodedBytes = safeProduct(safeProduct(decoded.numberOfChannels, decoded.length), 4);
  if (decodedBytes > maxDecodedBytes)
    throw new BrowserAudioObservationError(
      'decoded-audio-too-large',
      'The selected audio expands beyond JOY’s local observation limit. Narrow the range.',
    );
  return {
    sourceSampleRate: decoded.sampleRate,
    channelCount: decoded.numberOfChannels,
    sourceSampleCount: decoded.length,
    decodedBytes,
  };
}

function readDecodedChannels(
  decoded: BrowserAudioBufferLike,
  channelCount: number,
): readonly Float32Array[] {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    let samples: Float32Array;
    try {
      samples = decoded.getChannelData(channel);
    } catch {
      throw new BrowserAudioObservationError(
        'unsupported-audio',
        'The selected audio has an unsupported local decode format.',
      );
    }
    if (!(samples instanceof Float32Array) || samples.length !== decoded.length)
      throw new BrowserAudioObservationError(
        'unsupported-audio',
        'The selected audio has an unsupported local decode format.',
      );
    channels.push(samples);
  }
  return channels;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelledError();
}

function cancelledError(): BrowserAudioObservationError {
  return new BrowserAudioObservationError('cancelled', 'Audio observation was cancelled.');
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${label} must be a positive safe integer`);
  return value;
}

function positiveSafeIntegerAtMost(value: number, label: string, maximum: number): number {
  const normalized = positiveSafeInteger(value, label);
  if (normalized > maximum) throw new RangeError(`${label} must not exceed ${maximum}`);
  return normalized;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function safeProduct(left: number, right: number): number {
  const value = left * right;
  if (!Number.isSafeInteger(value))
    throw new BrowserAudioObservationError(
      'unsupported-audio',
      'The selected audio exceeds JOY’s safe local observation limits.',
    );
  return value;
}
