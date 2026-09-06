import { detectSilence, measurePeak } from './analysis.js';
import { sampleStartUs } from './audio.js';

const US_PER_SECOND = 1_000_000n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** Bounded local observation pages avoid retaining an entire feature film in PCM. */
export const MAX_AUDIO_OBSERVATION_SAMPLES_PER_CHANNEL = 1_000_000;
export const MAX_AUDIO_OBSERVATION_CHANNELS = 32;
export const DEFAULT_AUDIO_SILENCE_THRESHOLD_DB = -60;

export interface AudioRateRatio {
  /** Source microseconds advanced per composition microsecond. */
  readonly numerator: number;
  readonly denominator: number;
}

/** Maps source media time to a composition clip without using wall-clock time. */
export interface AudioCompositionTimeMapping {
  readonly compositionStartUs: number;
  /** End-exclusive clip duration; source observations outside it are unavailable. */
  readonly compositionDurationUs: number;
  /** Source time visible at the composition clip's start. */
  readonly sourceAnchorUs: number;
  readonly direction: 'forward' | 'reverse';
  readonly sourcePerComposition: AudioRateRatio;
}

/** Planar local PCM. `sourceOffsetUs` is the source time of sample index zero. */
export interface AudioObservationSource {
  readonly sampleRate: number;
  readonly channelData: readonly Float32Array[];
  readonly sourceOffsetUs: number;
}

export interface AudioObservationWindowRequest {
  readonly sourceStartUs: number;
  readonly durationUs: number;
  /** Requested output sample rate; linear resampling is declared in the result. */
  readonly resampleRate?: number;
  /**
   * Optional aggregate PCM visit limit for one locally materialized page.
   * The selected source samples and the resampled output samples must both
   * fit before this function validates or copies planar PCM. This is not a
   * streaming decode contract.
   */
  readonly maxSampleVisits?: number;
  readonly mapping?: AudioCompositionTimeMapping;
}

export interface AudioResamplingDeclaration {
  readonly algorithmVersion: 'identity-v1' | 'linear-v1';
  readonly sourceSampleRate: number;
  readonly outputSampleRate: number;
}

export interface AudioObservationWindow {
  readonly algorithmVersion: 'joy-audio-observation-window-v1';
  readonly sourceSampleRate: number;
  readonly sampleRate: number;
  readonly sourceTimebase: { readonly numerator: 1; readonly denominator: number };
  readonly sourceOffsetUs: number;
  readonly sourceStartUs: number;
  readonly sourceEndUs: number;
  readonly sourceStartSample: number;
  readonly sourceEndSample: number;
  readonly sourceSampleCount: number;
  readonly sampleCount: number;
  /** True when the request reached outside available source PCM. No silence is padded. */
  readonly truncated: boolean;
  readonly channelCount: number;
  readonly channelData: readonly Float32Array[];
  readonly resampling: AudioResamplingDeclaration;
  readonly mapping?: AudioCompositionTimeMapping;
}

export interface AudioPeakEvidence {
  readonly channelIndex: number;
  /** Index in the declared output sample rate. */
  readonly sampleIndex: number;
  /** Nearest source sample used for the evidence timestamp. */
  readonly sourceSampleIndex: number;
  readonly sourceTimeUs: number;
  readonly compositionTimeUs?: number;
  readonly amplitude: number;
}

export interface AudioChannelObservation {
  readonly channelIndex: number;
  readonly peak: number;
  readonly peakDb: number;
  readonly rms: number;
  readonly rmsDb: number;
  readonly silent: boolean;
  readonly peakEvidence?: AudioPeakEvidence;
}

export interface AudioObservationAnalysis {
  readonly algorithmVersion: 'joy-audio-observation-analysis-v1';
  readonly sampleCount: number;
  readonly channelCount: number;
  readonly peak: number;
  readonly rms: number;
  readonly silent: boolean;
  readonly channels: readonly AudioChannelObservation[];
}

export interface AudioObservationAnalysisOptions {
  /** RMS/peak silence threshold, not a loudness or LUFS measurement. */
  readonly silenceThresholdDb?: number;
}

export class AudioObservationError extends Error {
  constructor(
    readonly code:
      | 'AUDIO_OBSERVATION_INVALID_SOURCE'
      | 'AUDIO_OBSERVATION_INVALID_REQUEST'
      | 'AUDIO_OBSERVATION_INVALID_MAPPING'
      | 'AUDIO_OBSERVATION_BOUNDS',
    message: string,
  ) {
    super(message);
    this.name = 'AudioObservationError';
  }
}

/**
 * Extracts a bounded, channel-preserving PCM window. Every time is represented
 * by integer source sample counts and the declared source/output sample rates.
 */
export function extractAudioObservationWindow(
  source: AudioObservationSource,
  request: AudioObservationWindowRequest,
): AudioObservationWindow {
  assertSource(source);
  assertWindowRequest(request);

  const sourceSampleCount = source.channelData[0]!.length;
  const sourceEndUs = addUs(
    source.sourceOffsetUs,
    sampleStartUs(sourceSampleCount, source.sampleRate),
    'source end',
  );
  const requestedEndUs = addUs(request.sourceStartUs, request.durationUs, 'requested source end');
  const effectiveStartUs = clamp(request.sourceStartUs, source.sourceOffsetUs, sourceEndUs);
  const effectiveEndUs = clamp(requestedEndUs, source.sourceOffsetUs, sourceEndUs);
  const sourceStartSample = sampleIndexForOffsetUs(
    effectiveStartUs - source.sourceOffsetUs,
    source.sampleRate,
  );
  const sourceEndSample = Math.max(
    sourceStartSample,
    sampleIndexForOffsetUs(effectiveEndUs - source.sourceOffsetUs, source.sampleRate),
  );
  const boundedStartSample = Math.min(sourceSampleCount, sourceStartSample);
  const boundedEndSample = Math.min(sourceSampleCount, sourceEndSample);
  const sourceSampleLength = boundedEndSample - boundedStartSample;
  const outputSampleRate = request.resampleRate ?? source.sampleRate;
  assertSampleRate(outputSampleRate, 'resampleRate', 'AUDIO_OBSERVATION_INVALID_REQUEST');
  const outputSampleCount = resampledSampleCount(
    sourceSampleLength,
    source.sampleRate,
    outputSampleRate,
  );
  if (outputSampleCount > MAX_AUDIO_OBSERVATION_SAMPLES_PER_CHANNEL)
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_BOUNDS',
      'resampled audio window exceeds the bounded sample count',
    );
  const maxSampleVisits = request.maxSampleVisits;
  if (maxSampleVisits !== undefined) {
    const sourceSampleVisits = safeProduct(
      sourceSampleLength,
      source.channelData.length,
      'source audio observation sample visits',
    );
    const outputSampleVisits = safeProduct(
      outputSampleCount,
      source.channelData.length,
      'output audio observation sample visits',
    );
    if (sourceSampleVisits > maxSampleVisits || outputSampleVisits > maxSampleVisits)
      throw new AudioObservationError(
        'AUDIO_OBSERVATION_BOUNDS',
        'audio observation exceeds the bounded aggregate sample visit count',
      );
  }

  const channelData = source.channelData.map((channel) => {
    const selected = channel.subarray(boundedStartSample, boundedEndSample);
    assertFiniteSamples(selected);
    return resampleChannel(selected, source.sampleRate, outputSampleRate, outputSampleCount);
  });
  const mapping = canonicalMapping(request.mapping);

  return {
    algorithmVersion: 'joy-audio-observation-window-v1',
    sourceSampleRate: source.sampleRate,
    sampleRate: outputSampleRate,
    sourceTimebase: { numerator: 1, denominator: source.sampleRate },
    sourceOffsetUs: source.sourceOffsetUs,
    sourceStartUs: addUs(
      source.sourceOffsetUs,
      sampleStartUs(boundedStartSample, source.sampleRate),
      'source start',
    ),
    sourceEndUs: addUs(
      source.sourceOffsetUs,
      sampleStartUs(boundedEndSample, source.sampleRate),
      'source end',
    ),
    sourceStartSample: boundedStartSample,
    sourceEndSample: boundedEndSample,
    sourceSampleCount: sourceSampleLength,
    sampleCount: outputSampleCount,
    truncated: effectiveStartUs !== request.sourceStartUs || effectiveEndUs !== requestedEndUs,
    channelCount: channelData.length,
    channelData,
    resampling: {
      algorithmVersion: outputSampleRate === source.sampleRate ? 'identity-v1' : 'linear-v1',
      sourceSampleRate: source.sampleRate,
      outputSampleRate,
    },
    ...(mapping === undefined ? {} : { mapping }),
  };
}

/** Returns a source timestamp derived from the output sample count/rate mapping. */
export function sourceTimeAtAudioObservationSample(
  window: AudioObservationWindow,
  sampleIndex: number,
): number {
  assertAudioObservationWindow(window);
  if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 0 || sampleIndex > window.sampleCount)
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_REQUEST',
      'sampleIndex must be within the audio observation window',
    );
  const relativeSourceSample = safeNumber(
    (BigInt(sampleIndex) * BigInt(window.sourceSampleRate)) / BigInt(window.sampleRate),
    'source sample index',
  );
  const sourceSampleIndex = Math.min(
    window.sourceEndSample,
    window.sourceStartSample + relativeSourceSample,
  );
  return addUs(
    window.sourceOffsetUs,
    sampleStartUs(sourceSampleIndex, window.sourceSampleRate),
    'source sample time',
  );
}

/**
 * Maps a source timestamp through an explicit trim/direction/speed mapping.
 * It returns undefined for a source timestamp that is outside the clip's
 * playable direction instead of inventing a composition time.
 */
export function mapSourceTimeToCompositionTime(
  sourceTimeUs: number,
  mapping: AudioCompositionTimeMapping,
): number | undefined {
  assertTimeUs(sourceTimeUs, 'sourceTimeUs', 'AUDIO_OBSERVATION_INVALID_MAPPING');
  assertMapping(mapping);
  const deltaUs =
    mapping.direction === 'forward'
      ? sourceTimeUs - mapping.sourceAnchorUs
      : mapping.sourceAnchorUs - sourceTimeUs;
  if (deltaUs < 0) return undefined;
  const compositionOffsetUs = safeNumber(
    (BigInt(deltaUs) * BigInt(mapping.sourcePerComposition.denominator)) /
      BigInt(mapping.sourcePerComposition.numerator),
    'composition offset',
  );
  if (compositionOffsetUs >= mapping.compositionDurationUs) return undefined;
  return addUs(mapping.compositionStartUs, compositionOffsetUs, 'composition source mapping');
}

/** Computes local peak/RMS/silence measurements without claiming LUFS. */
export function analyzeAudioObservationWindow(
  window: AudioObservationWindow,
  options: AudioObservationAnalysisOptions = {},
): AudioObservationAnalysis {
  assertAudioObservationWindow(window);
  if (options === null || typeof options !== 'object')
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_REQUEST',
      'audio observation analysis options must be an object',
    );
  const silenceThresholdDb = options.silenceThresholdDb ?? DEFAULT_AUDIO_SILENCE_THRESHOLD_DB;
  if (!Number.isFinite(silenceThresholdDb) || silenceThresholdDb > 0 || silenceThresholdDb < -160)
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_REQUEST',
      'silenceThresholdDb must be finite and between -160 and 0',
    );

  let aggregateSquareSum = 0;
  let aggregateSampleCount = 0;
  let aggregatePeak = 0;
  const channels = window.channelData.map((samples, channelIndex) => {
    let squareSum = 0;
    let peakValue = 0;
    let peakSampleIndex = -1;
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
      const sample = samples[sampleIndex]!;
      if (!Number.isFinite(sample))
        throw new AudioObservationError(
          'AUDIO_OBSERVATION_INVALID_SOURCE',
          'audio samples must be finite',
        );
      const absolute = Math.abs(sample);
      if (absolute > Math.abs(peakValue)) {
        peakValue = sample;
        peakSampleIndex = sampleIndex;
      }
      squareSum += sample * sample;
    }
    const measurement = measurePeak(samples);
    const rms = samples.length === 0 ? 0 : Math.sqrt(squareSum / samples.length);
    aggregateSquareSum += squareSum;
    aggregateSampleCount += samples.length;
    aggregatePeak = Math.max(aggregatePeak, measurement.peak);
    const sourceSampleIndex =
      peakSampleIndex < 0
        ? undefined
        : Math.min(
            window.sourceEndSample - 1,
            window.sourceStartSample +
              safeNumber(
                (BigInt(peakSampleIndex) * BigInt(window.sourceSampleRate)) /
                  BigInt(window.sampleRate),
                'peak source sample index',
              ),
          );
    const sourceTimeUs =
      sourceSampleIndex === undefined
        ? undefined
        : addUs(
            window.sourceOffsetUs,
            sampleStartUs(sourceSampleIndex, window.sourceSampleRate),
            'peak source time',
          );
    const compositionTimeUs =
      sourceTimeUs === undefined || window.mapping === undefined
        ? undefined
        : mapSourceTimeToCompositionTime(sourceTimeUs, window.mapping);
    const peakEvidence =
      peakSampleIndex < 0 || sourceSampleIndex === undefined || sourceTimeUs === undefined
        ? undefined
        : {
            channelIndex,
            sampleIndex: peakSampleIndex,
            sourceSampleIndex,
            sourceTimeUs,
            ...(compositionTimeUs === undefined ? {} : { compositionTimeUs }),
            amplitude: peakValue,
          };
    return {
      channelIndex,
      peak: measurement.peak,
      peakDb: measurement.peakDb,
      rms,
      rmsDb: amplitudeDb(rms),
      silent: samples.length > 0 && detectSilence(samples, silenceThresholdDb).silent,
      ...(peakEvidence === undefined ? {} : { peakEvidence }),
    };
  });

  return {
    algorithmVersion: 'joy-audio-observation-analysis-v1',
    sampleCount: window.sampleCount,
    channelCount: window.channelCount,
    peak: aggregatePeak,
    rms: aggregateSampleCount === 0 ? 0 : Math.sqrt(aggregateSquareSum / aggregateSampleCount),
    silent: channels.length > 0 && channels.every((channel) => channel.silent),
    channels,
  };
}

/** Shared validation for envelope analysis and other local consumers. */
export function assertAudioObservationWindow(window: AudioObservationWindow): void {
  if (window === null || typeof window !== 'object')
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_SOURCE',
      'audio observation window must be an object',
    );
  if (window.algorithmVersion !== 'joy-audio-observation-window-v1')
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_SOURCE',
      'audio observation algorithm version is unsupported',
    );
  assertSampleRate(window.sourceSampleRate, 'sourceSampleRate', 'AUDIO_OBSERVATION_INVALID_SOURCE');
  assertSampleRate(window.sampleRate, 'sampleRate', 'AUDIO_OBSERVATION_INVALID_SOURCE');
  assertTimeUs(window.sourceOffsetUs, 'sourceOffsetUs', 'AUDIO_OBSERVATION_INVALID_SOURCE');
  assertTimeUs(window.sourceStartUs, 'sourceStartUs', 'AUDIO_OBSERVATION_INVALID_SOURCE');
  assertTimeUs(window.sourceEndUs, 'sourceEndUs', 'AUDIO_OBSERVATION_INVALID_SOURCE');
  assertNonNegativeSafeInteger(window.sourceStartSample, 'sourceStartSample');
  assertNonNegativeSafeInteger(window.sourceEndSample, 'sourceEndSample');
  assertNonNegativeSafeInteger(window.sourceSampleCount, 'sourceSampleCount');
  assertNonNegativeSafeInteger(window.sampleCount, 'sampleCount');
  assertNonNegativeSafeInteger(window.channelCount, 'channelCount');
  if (typeof window.truncated !== 'boolean')
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_SOURCE',
      'audio observation truncation state must be explicit',
    );
  if (
    window.sourceEndUs < window.sourceStartUs ||
    window.sourceEndSample < window.sourceStartSample ||
    window.sourceEndSample - window.sourceStartSample !== window.sourceSampleCount ||
    window.sourceSampleCount > MAX_AUDIO_OBSERVATION_SAMPLES_PER_CHANNEL ||
    window.sampleCount > MAX_AUDIO_OBSERVATION_SAMPLES_PER_CHANNEL ||
    window.sampleCount !==
      resampledSampleCount(window.sourceSampleCount, window.sourceSampleRate, window.sampleRate)
  )
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_BOUNDS',
      'audio observation sample bounds are inconsistent',
    );
  const expectedSourceStartUs = addUs(
    window.sourceOffsetUs,
    sampleStartUs(window.sourceStartSample, window.sourceSampleRate),
    'source start',
  );
  const expectedSourceEndUs = addUs(
    window.sourceOffsetUs,
    sampleStartUs(window.sourceEndSample, window.sourceSampleRate),
    'source end',
  );
  if (
    window.sourceStartUs !== expectedSourceStartUs ||
    window.sourceEndUs !== expectedSourceEndUs ||
    window.sourceTimebase === null ||
    typeof window.sourceTimebase !== 'object' ||
    window.sourceTimebase.numerator !== 1 ||
    window.sourceTimebase.denominator !== window.sourceSampleRate
  )
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_SOURCE',
      'audio observation source timebase is inconsistent with sample evidence',
    );
  if (
    !Array.isArray(window.channelData) ||
    window.channelData.length < 1 ||
    window.channelData.length > MAX_AUDIO_OBSERVATION_CHANNELS ||
    window.channelCount !== window.channelData.length ||
    window.channelData.some(
      (channel) => !(channel instanceof Float32Array) || channel.length !== window.sampleCount,
    )
  )
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_SOURCE',
      'audio observation must preserve bounded planar channels',
    );
  if (
    window.resampling === null ||
    typeof window.resampling !== 'object' ||
    window.resampling.sourceSampleRate !== window.sourceSampleRate ||
    window.resampling.outputSampleRate !== window.sampleRate ||
    window.resampling.algorithmVersion !==
      (window.sampleRate === window.sourceSampleRate ? 'identity-v1' : 'linear-v1')
  )
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_SOURCE',
      'audio observation resampling declaration is inconsistent',
    );
  if (window.mapping !== undefined) assertMapping(window.mapping);
}

function assertSource(source: AudioObservationSource): void {
  if (source === null || typeof source !== 'object')
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_SOURCE',
      'audio source must be an object',
    );
  assertSampleRate(source.sampleRate, 'sampleRate', 'AUDIO_OBSERVATION_INVALID_SOURCE');
  assertTimeUs(source.sourceOffsetUs, 'sourceOffsetUs', 'AUDIO_OBSERVATION_INVALID_SOURCE');
  if (
    !Array.isArray(source.channelData) ||
    source.channelData.length < 1 ||
    source.channelData.length > MAX_AUDIO_OBSERVATION_CHANNELS
  )
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_SOURCE',
      'audio source must have between one and 32 planar channels',
    );
  const sampleCount = source.channelData[0]?.length;
  if (
    sampleCount === undefined ||
    sampleCount < 1 ||
    sampleCount > MAX_AUDIO_OBSERVATION_SAMPLES_PER_CHANNEL ||
    source.channelData.some(
      (channel) => !(channel instanceof Float32Array) || channel.length !== sampleCount,
    )
  )
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_SOURCE',
      'audio source channels must have the same sample count within the bounded limit',
    );
}

function assertWindowRequest(request: AudioObservationWindowRequest): void {
  if (request === null || typeof request !== 'object')
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_REQUEST',
      'audio window request must be an object',
    );
  assertTimeUs(request.sourceStartUs, 'sourceStartUs', 'AUDIO_OBSERVATION_INVALID_REQUEST');
  assertTimeUs(request.durationUs, 'durationUs', 'AUDIO_OBSERVATION_INVALID_REQUEST');
  addUs(request.sourceStartUs, request.durationUs, 'requested source end');
  if (request.resampleRate !== undefined)
    assertSampleRate(request.resampleRate, 'resampleRate', 'AUDIO_OBSERVATION_INVALID_REQUEST');
  if (request.maxSampleVisits !== undefined)
    assertPositiveSafeInteger(
      request.maxSampleVisits,
      'maxSampleVisits',
      'AUDIO_OBSERVATION_INVALID_REQUEST',
    );
  if (request.mapping !== undefined) assertMapping(request.mapping);
}

function assertMapping(mapping: AudioCompositionTimeMapping): void {
  if (mapping === null || typeof mapping !== 'object')
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_MAPPING',
      'audio mapping must be an object',
    );
  assertTimeUs(
    mapping.compositionStartUs,
    'compositionStartUs',
    'AUDIO_OBSERVATION_INVALID_MAPPING',
  );
  assertPositiveSafeInteger(mapping.compositionDurationUs, 'compositionDurationUs');
  addUs(mapping.compositionStartUs, mapping.compositionDurationUs, 'composition end');
  assertTimeUs(mapping.sourceAnchorUs, 'sourceAnchorUs', 'AUDIO_OBSERVATION_INVALID_MAPPING');
  if (mapping.direction !== 'forward' && mapping.direction !== 'reverse')
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_MAPPING',
      'direction must be forward or reverse',
    );
  if (mapping.sourcePerComposition === null || typeof mapping.sourcePerComposition !== 'object')
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_MAPPING',
      'sourcePerComposition must be an object',
    );
  assertPositiveSafeInteger(
    mapping.sourcePerComposition.numerator,
    'sourcePerComposition.numerator',
  );
  assertPositiveSafeInteger(
    mapping.sourcePerComposition.denominator,
    'sourcePerComposition.denominator',
  );
}

function canonicalMapping(
  mapping: AudioCompositionTimeMapping | undefined,
): AudioCompositionTimeMapping | undefined {
  if (mapping === undefined) return undefined;
  assertMapping(mapping);
  return {
    compositionStartUs: mapping.compositionStartUs,
    compositionDurationUs: mapping.compositionDurationUs,
    sourceAnchorUs: mapping.sourceAnchorUs,
    direction: mapping.direction,
    sourcePerComposition: {
      numerator: mapping.sourcePerComposition.numerator,
      denominator: mapping.sourcePerComposition.denominator,
    },
  };
}

function resampledSampleCount(
  sourceSampleCount: number,
  sourceSampleRate: number,
  outputSampleRate: number,
): number {
  if (sourceSampleCount === 0) return 0;
  return safeNumber(
    ceilDiv(BigInt(sourceSampleCount) * BigInt(outputSampleRate), BigInt(sourceSampleRate)),
    'resampled sample count',
  );
}

function resampleChannel(
  source: Float32Array,
  sourceSampleRate: number,
  outputSampleRate: number,
  outputSampleCount: number,
): Float32Array {
  if (outputSampleCount === 0) return new Float32Array();
  if (sourceSampleRate === outputSampleRate) return source.slice();
  const output = new Float32Array(outputSampleCount);
  const outputRate = BigInt(outputSampleRate);
  for (let sampleIndex = 0; sampleIndex < output.length; sampleIndex += 1) {
    const position = BigInt(sampleIndex) * BigInt(sourceSampleRate);
    const lower = Math.min(source.length - 1, safeNumber(position / outputRate, 'resample index'));
    const upper = Math.min(source.length - 1, lower + 1);
    const fraction = Number(position % outputRate) / outputSampleRate;
    output[sampleIndex] = source[lower]! + (source[upper]! - source[lower]!) * fraction;
  }
  return output;
}

function sampleIndexForOffsetUs(offsetUs: number, sampleRate: number): number {
  return safeNumber(
    ceilDiv(BigInt(offsetUs) * BigInt(sampleRate), US_PER_SECOND),
    'source sample index',
  );
}

function assertFiniteSamples(samples: Float32Array): void {
  for (let index = 0; index < samples.length; index += 1)
    if (!Number.isFinite(samples[index]!))
      throw new AudioObservationError(
        'AUDIO_OBSERVATION_INVALID_SOURCE',
        'audio samples must be finite',
      );
}

function amplitudeDb(amplitude: number): number {
  return 20 * Math.log10(amplitude + 1e-10);
}

function assertSampleRate(
  value: unknown,
  label: string,
  code: AudioObservationError['code'],
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 384_000)
    throw new AudioObservationError(code, `${label} must be a positive bounded sample rate`);
}

function assertTimeUs(
  value: unknown,
  label: string,
  code: AudioObservationError['code'],
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new AudioObservationError(code, `${label} must be a non-negative safe integer`);
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_INVALID_SOURCE',
      `${label} must be a non-negative safe integer`,
    );
}

function assertPositiveSafeInteger(
  value: unknown,
  label: string,
  code: AudioObservationError['code'] = 'AUDIO_OBSERVATION_INVALID_MAPPING',
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new AudioObservationError(code, `${label} must be a positive safe integer`);
}

function safeProduct(left: number, right: number, label: string): number {
  return safeNumber(BigInt(left) * BigInt(right), label);
}

function addUs(left: number, right: number, label: string): number {
  if (left > Number.MAX_SAFE_INTEGER - right)
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_BOUNDS',
      `${label} exceeds the safe integer range`,
    );
  return left + right;
}

function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > MAX_SAFE_BIGINT)
    throw new AudioObservationError(
      'AUDIO_OBSERVATION_BOUNDS',
      `${label} exceeds the safe integer range`,
    );
  return Number(value);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}
