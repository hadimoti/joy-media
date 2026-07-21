import { computeBiquadCoeffs, processBiquad } from './effects.js';

export interface PeakMeasurement {
  readonly peak: number;
  readonly peakDb: number;
  readonly clipping: boolean;
}

export function measurePeak(samples: Float32Array): PeakMeasurement {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]!);
    if (abs > peak) {
      peak = abs;
    }
  }

  const peakDb = 20 * Math.log10(peak + 1e-10);
  const clipping = peak >= 1.0;

  return { peak, peakDb, clipping };
}

export interface ClippingDetection {
  readonly clipping: boolean;
  readonly clipCount: number;
  readonly clipPositions: readonly number[];
}

export function detectClipping(samples: Float32Array): ClippingDetection {
  const clipPositions: number[] = [];

  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]!);
    if (abs >= 1.0) {
      clipPositions.push(i);
    }
  }

  return {
    clipping: clipPositions.length > 0,
    clipCount: clipPositions.length,
    clipPositions,
  };
}

export interface LoudnessMeasurement {
  readonly integrated: number;
  readonly shortTerm: number;
  readonly range: number;
}

export function measureLoudness(samples: Float32Array, sampleRate: number): LoudnessMeasurement {
  // ITU-R BS.1770-style K-weighting pre-filter is intentionally omitted here:
  // the previous second-order high-shelf implementation produced huge resonant
  // gain and positive LUFS values for ordinary signals. A correct K-weighted
  // design can be restored later; this version returns a stable, monotonic
  // loudness estimate based on gated RMS blocks.
  void sampleRate;

  const blockSamples = Math.floor(0.4 * sampleRate);
  const hopSamples = Math.floor(0.1 * sampleRate);
  const blocks: number[] = [];

  for (let i = 0; i + blockSamples <= samples.length; i += hopSamples) {
    let sum = 0;
    for (let j = 0; j < blockSamples; j++) {
      const sample = samples[i + j]!;
      sum += sample * sample;
    }
    const meanSquare = sum / blockSamples;
    const loudness = -0.691 + 10 * Math.log10(meanSquare + 1e-10);
    blocks.push(loudness);
  }

  const absoluteThreshold = -70;
  const gatedBlocks = blocks.filter((l) => l > absoluteThreshold);
  const integrated =
    gatedBlocks.length > 0 ? gatedBlocks.reduce((sum, l) => sum + l, 0) / gatedBlocks.length : -70;

  const shortTermSamples = Math.floor(3 * sampleRate);
  const shortTermBlocks: number[] = [];

  for (let i = 0; i + shortTermSamples <= samples.length; i += hopSamples) {
    let sum = 0;
    for (let j = 0; j < shortTermSamples; j++) {
      const sample = samples[i + j]!;
      sum += sample * sample;
    }
    const meanSquare = sum / shortTermSamples;
    const loudness = -0.691 + 10 * Math.log10(meanSquare + 1e-10);
    shortTermBlocks.push(loudness);
  }

  const shortTerm =
    shortTermBlocks.length > 0
      ? shortTermBlocks.reduce((sum, l) => sum + l, 0) / shortTermBlocks.length
      : -70;

  const sorted = [...shortTermBlocks].sort((a, b) => a - b);
  const p10 = percentile(sorted, 10);
  const p95 = percentile(sorted, 95);
  const range = p95 - p10;

  return { integrated, shortTerm, range };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return -70;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export interface SilenceDetection {
  readonly silent: boolean;
  readonly silentRegions: readonly { readonly start: number; readonly end: number }[];
}

export function detectSilence(samples: Float32Array, thresholdDb: number): SilenceDetection {
  const thresholdLinear = Math.pow(10, thresholdDb / 20);
  const silentRegions: { start: number; end: number }[] = [];
  let regionStart = -1;

  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]!);
    const isSilent = abs < thresholdLinear;

    if (isSilent && regionStart === -1) {
      regionStart = i;
    } else if (!isSilent && regionStart !== -1) {
      silentRegions.push({ start: regionStart, end: i });
      regionStart = -1;
    }
  }

  if (regionStart !== -1) {
    silentRegions.push({ start: regionStart, end: samples.length });
  }

  return {
    silent:
      silentRegions.length > 0 &&
      silentRegions[0]!.start === 0 &&
      silentRegions[silentRegions.length - 1]!.end === samples.length,
    silentRegions,
  };
}
