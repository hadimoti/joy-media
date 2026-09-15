import {
  assertAudioObservationWindow,
  mapSourceTimeToCompositionTime,
  sourceTimeAtAudioObservationSample,
  type AudioObservationWindow,
} from './observation-analysis.js';

export const BEAT_ENVELOPE_ALGORITHM_VERSION = 'joy-beat-envelope-v1' as const;
export const MAX_AUDIO_ENVELOPE_POINTS = 512;
/** Total planar PCM samples examined by one envelope pass before event detection. */
export const MAX_AUDIO_ENVELOPE_SAMPLE_VISITS = 4_000_000;

const MIN_BEAT_INTERVAL_US = 250_000;
const MAX_BEAT_INTERVAL_US = 2_000_000;
const MIN_ONSETS_FOR_BEAT_GRID = 3;

export interface AudioEnvelopePoint {
  readonly startSample: number;
  readonly endSample: number;
  readonly sourceStartUs: number;
  readonly sourceEndUs: number;
  /** Per-channel RMS is retained; the aggregate does not downmix channels. */
  readonly channelRms: readonly number[];
  /** Maximum absolute channel sample in this local frame. */
  readonly peak: number;
  readonly rms: number;
}

export interface AudioOnsetEvidence {
  readonly sourceTimeUs: number;
  readonly sourceSampleIndex: number;
  readonly compositionTimeUs?: number;
  /** Local maximum amplitude; it is not a loudness value. */
  readonly strength: number;
}

export interface BeatEnvelopeEstimate {
  readonly algorithmVersion: typeof BEAT_ENVELOPE_ALGORITHM_VERSION;
  readonly envelope: readonly AudioEnvelopePoint[];
  readonly onsets: readonly AudioOnsetEvidence[];
  readonly silent: boolean;
  readonly hasBeatGrid: boolean;
  /** Observed onset times only; this function never extrapolates missing beats. */
  readonly beatTimesUs: readonly number[];
  readonly beatIntervalUs?: number;
  /** Heuristic regularity confidence in [0, 1], never model comprehension. */
  readonly confidence: number;
}

export interface BeatEnvelopeOptions {
  readonly frameSizeSamples?: number;
  readonly hopSamples?: number;
  readonly silenceThresholdDb?: number;
  readonly onsetRiseThreshold?: number;
}

/**
 * Produces a bounded, local RMS/peak envelope and a conservative beat-grid
 * estimate. Silence and irregular/sparse onsets deliberately have no grid.
 */
export function buildBeatEnvelope(
  window: AudioObservationWindow,
  options: BeatEnvelopeOptions = {},
): BeatEnvelopeEstimate {
  assertAudioObservationWindow(window);
  if (options === null || typeof options !== 'object')
    throw new RangeError('beat envelope options must be an object');
  const frameSizeSamples =
    options.frameSizeSamples ?? Math.max(1, Math.floor(window.sampleRate / 40));
  const hopSamples = options.hopSamples ?? frameSizeSamples;
  assertPositiveSafeInteger(frameSizeSamples, 'frameSizeSamples');
  assertPositiveSafeInteger(hopSamples, 'hopSamples');
  const silenceThresholdDb = options.silenceThresholdDb ?? -60;
  if (!Number.isFinite(silenceThresholdDb) || silenceThresholdDb > 0 || silenceThresholdDb < -160)
    throw new RangeError('silenceThresholdDb must be finite and between -160 and 0');
  if (
    options.onsetRiseThreshold !== undefined &&
    (!Number.isFinite(options.onsetRiseThreshold) || options.onsetRiseThreshold < 0)
  )
    throw new RangeError('onsetRiseThreshold must be a finite non-negative number');

  const pointCount =
    window.sampleCount === 0 ? 0 : Math.floor((window.sampleCount - 1) / hopSamples) + 1;
  if (pointCount > MAX_AUDIO_ENVELOPE_POINTS)
    throw new RangeError('audio envelope exceeds the bounded point count');
  if (
    envelopeSampleVisits(window.sampleCount, frameSizeSamples, hopSamples) * window.channelCount >
    MAX_AUDIO_ENVELOPE_SAMPLE_VISITS
  )
    throw new RangeError('audio envelope exceeds the bounded PCM analysis work');

  const envelope: AudioEnvelopePoint[] = [];
  const onsetCandidates: Array<AudioOnsetEvidence & { readonly rms: number }> = [];
  let highestRms = 0;
  let highestPeak = 0;
  let previousRms = 0;
  const silenceThreshold = Math.pow(10, silenceThresholdDb / 20);

  for (let startSample = 0; startSample < window.sampleCount; startSample += hopSamples) {
    const endSample = Math.min(window.sampleCount, startSample + frameSizeSamples);
    const point = measureEnvelopePoint(window, startSample, endSample);
    envelope.push(point);
    highestRms = Math.max(highestRms, point.rms);
    highestPeak = Math.max(highestPeak, point.peak);
    previousRms = point.rms;
  }

  const silent = window.sampleCount > 0 && highestPeak < silenceThreshold;
  if (silent || envelope.length === 0) {
    return {
      algorithmVersion: BEAT_ENVELOPE_ALGORITHM_VERSION,
      envelope,
      onsets: [],
      silent,
      hasBeatGrid: false,
      beatTimesUs: [],
      confidence: 0,
    };
  }

  const onsetRiseThreshold = options.onsetRiseThreshold ?? Math.max(0.005, highestRms * 0.5);
  previousRms = 0;
  for (const point of envelope) {
    const peakSampleIndex = findPeakSampleIndex(window, point.startSample, point.endSample);
    if (
      peakSampleIndex !== undefined &&
      point.peak >= silenceThreshold &&
      point.rms - previousRms >= onsetRiseThreshold
    ) {
      const sourceTimeUs = sourceTimeAtAudioObservationSample(window, peakSampleIndex);
      const previous = onsetCandidates[onsetCandidates.length - 1];
      const minSeparationUs = Math.max(
        1,
        sourceTimeAtAudioObservationSample(window, point.endSample) - point.sourceStartUs,
      );
      if (previous === undefined || sourceTimeUs - previous.sourceTimeUs >= minSeparationUs) {
        const compositionTimeUs =
          window.mapping === undefined
            ? undefined
            : mapSourceTimeToCompositionTime(sourceTimeUs, window.mapping);
        onsetCandidates.push({
          sourceTimeUs,
          sourceSampleIndex: sourceSampleIndexForOutputSample(window, peakSampleIndex),
          ...(compositionTimeUs === undefined ? {} : { compositionTimeUs }),
          strength: point.peak,
          rms: point.rms,
        });
      }
    }
    previousRms = point.rms;
  }

  const onsets = onsetCandidates.map(({ rms: _rms, ...onset }) => onset);
  const beat = estimateBeatGrid(onsets);
  return {
    algorithmVersion: BEAT_ENVELOPE_ALGORITHM_VERSION,
    envelope,
    onsets,
    silent: false,
    hasBeatGrid: beat.hasBeatGrid,
    beatTimesUs: beat.beatTimesUs,
    ...(beat.beatIntervalUs === undefined ? {} : { beatIntervalUs: beat.beatIntervalUs }),
    confidence: beat.confidence,
  };
}

function measureEnvelopePoint(
  window: AudioObservationWindow,
  startSample: number,
  endSample: number,
): AudioEnvelopePoint {
  const channelRms: number[] = [];
  let totalSquareSum = 0;
  let totalSampleCount = 0;
  let peak = 0;
  for (const channel of window.channelData) {
    let channelSquareSum = 0;
    for (let sampleIndex = startSample; sampleIndex < endSample; sampleIndex += 1) {
      const sample = channel[sampleIndex]!;
      if (!Number.isFinite(sample)) throw new RangeError('audio envelope samples must be finite');
      const absolute = Math.abs(sample);
      peak = Math.max(peak, absolute);
      channelSquareSum += sample * sample;
    }
    const sampleCount = endSample - startSample;
    channelRms.push(sampleCount === 0 ? 0 : Math.sqrt(channelSquareSum / sampleCount));
    totalSquareSum += channelSquareSum;
    totalSampleCount += sampleCount;
  }
  return {
    startSample,
    endSample,
    sourceStartUs: sourceTimeAtAudioObservationSample(window, startSample),
    sourceEndUs: sourceTimeAtAudioObservationSample(window, endSample),
    channelRms,
    peak,
    rms: totalSampleCount === 0 ? 0 : Math.sqrt(totalSquareSum / totalSampleCount),
  };
}

function findPeakSampleIndex(
  window: AudioObservationWindow,
  startSample: number,
  endSample: number,
): number | undefined {
  let peak = 0;
  let peakSampleIndex: number | undefined;
  for (const channel of window.channelData) {
    for (let sampleIndex = startSample; sampleIndex < endSample; sampleIndex += 1) {
      const absolute = Math.abs(channel[sampleIndex]!);
      if (absolute > peak) {
        peak = absolute;
        peakSampleIndex = sampleIndex;
      }
    }
  }
  return peakSampleIndex;
}

function sourceSampleIndexForOutputSample(
  window: AudioObservationWindow,
  sampleIndex: number,
): number {
  const relativeSourceSample = Number(
    (BigInt(sampleIndex) * BigInt(window.sourceSampleRate)) / BigInt(window.sampleRate),
  );
  return Math.min(window.sourceEndSample - 1, window.sourceStartSample + relativeSourceSample);
}

function estimateBeatGrid(onsets: readonly AudioOnsetEvidence[]): {
  readonly hasBeatGrid: boolean;
  readonly beatTimesUs: readonly number[];
  readonly beatIntervalUs?: number;
  readonly confidence: number;
} {
  if (onsets.length < MIN_ONSETS_FOR_BEAT_GRID)
    return { hasBeatGrid: false, beatTimesUs: [], confidence: 0 };
  const intervals = onsets
    .slice(1)
    .map((onset, index) => onset.sourceTimeUs - onsets[index]!.sourceTimeUs);
  const medianIntervalUs = median(intervals);
  if (medianIntervalUs < MIN_BEAT_INTERVAL_US || medianIntervalUs > MAX_BEAT_INTERVAL_US)
    return { hasBeatGrid: false, beatTimesUs: [], confidence: 0 };
  const meanAbsoluteDeviation =
    intervals.reduce((sum, interval) => sum + Math.abs(interval - medianIntervalUs), 0) /
    intervals.length;
  const confidence = clamp(1 - meanAbsoluteDeviation / (medianIntervalUs * 0.15), 0, 1);
  if (confidence < 0.7) return { hasBeatGrid: false, beatTimesUs: [], confidence: 0 };
  return {
    hasBeatGrid: true,
    beatTimesUs: onsets.map((onset) => onset.sourceTimeUs),
    beatIntervalUs: Math.round(medianIntervalUs),
    confidence,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function envelopeSampleVisits(
  sampleCount: number,
  frameSizeSamples: number,
  hopSamples: number,
): number {
  let visits = 0;
  for (let startSample = 0; startSample < sampleCount; startSample += hopSamples)
    visits += Math.min(sampleCount, startSample + frameSizeSamples) - startSample;
  return visits;
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${label} must be a positive safe integer`);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}
