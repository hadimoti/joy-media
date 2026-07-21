import type { EqBand } from './graph.js';

interface BiquadCoeffs {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a0: number;
  readonly a1: number;
  readonly a2: number;
}

function computeBiquadCoeffs(
  type: EqBand['type'],
  frequency: number,
  gainDb: number,
  q: number,
  sampleRate: number,
): BiquadCoeffs {
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * q);
  const A = Math.pow(10, gainDb / 40);

  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;

  switch (type) {
    case 'lowpass':
      b0 = (1 - cosw0) / 2;
      b1 = 1 - cosw0;
      b2 = (1 - cosw0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw0;
      a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cosw0) / 2;
      b1 = -(1 + cosw0);
      b2 = (1 + cosw0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw0;
      a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cosw0;
      a2 = 1 - alpha;
      break;
    case 'peaking':
      b0 = 1 + alpha * A;
      b1 = -2 * cosw0;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosw0;
      a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const lsBeta = Math.sqrt(A) / q;
      b0 = A * (A + 1 - (A - 1) * cosw0 + lsBeta * sinw0);
      b1 = 2 * A * (A - 1 - (A + 1) * cosw0);
      b2 = A * (A + 1 - (A - 1) * cosw0 - lsBeta * sinw0);
      a0 = A + 1 + (A - 1) * cosw0 + lsBeta * sinw0;
      a1 = -2 * (A - 1 + (A + 1) * cosw0);
      a2 = A + 1 + (A - 1) * cosw0 - lsBeta * sinw0;
      break;
    }
    case 'highshelf': {
      const hsBeta = Math.sqrt(A) / q;
      b0 = A * (A + 1 + (A - 1) * cosw0 + hsBeta * sinw0);
      b1 = -2 * A * (A - 1 + (A + 1) * cosw0);
      b2 = A * (A + 1 - (A - 1) * cosw0 - hsBeta * sinw0);
      a0 = A + 1 - (A - 1) * cosw0 + hsBeta * sinw0;
      a1 = 2 * (A - 1 - (A + 1) * cosw0);
      a2 = A + 1 - (A - 1) * cosw0 - hsBeta * sinw0;
      break;
    }
  }

  return { b0, b1, b2, a0, a1, a2 };
}

function processBiquad(samples: Float32Array, coeffs: BiquadCoeffs): Float32Array {
  const result = new Float32Array(samples.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;

  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i]!;
    const y0 =
      (coeffs.b0 * x0 + coeffs.b1 * x1 + coeffs.b2 * x2 - coeffs.a1 * y1 - coeffs.a2 * y2) /
      coeffs.a0;

    result[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }

  return result;
}

export function applyEq(
  samples: Float32Array,
  bands: readonly EqBand[],
  sampleRate: number,
): Float32Array {
  let result = new Float32Array(samples);

  for (const band of bands) {
    const coeffs = computeBiquadCoeffs(band.type, band.frequency, band.gain, band.q, sampleRate);
    result = new Float32Array(processBiquad(result, coeffs));
  }

  return result;
}

export interface CompressorConfig {
  readonly threshold: number;
  readonly ratio: number;
  readonly attackUs: number;
  readonly releaseUs: number;
  readonly knee: number;
}

export function applyCompressor(
  samples: Float32Array,
  config: CompressorConfig,
  sampleRate: number,
): Float32Array {
  const result = new Float32Array(samples.length);
  const attackCoeff = Math.exp(-1 / ((config.attackUs * sampleRate) / 1_000_000));
  const releaseCoeff = Math.exp(-1 / ((config.releaseUs * sampleRate) / 1_000_000));

  let envelope = 0;

  for (let i = 0; i < samples.length; i++) {
    const input = samples[i]!;
    const inputDb = 20 * Math.log10(Math.abs(input) + 1e-10);

    let gainReduction = 0;
    if (inputDb > config.threshold + config.knee / 2) {
      gainReduction = config.threshold + (inputDb - config.threshold) / config.ratio - inputDb;
    } else if (inputDb > config.threshold - config.knee / 2) {
      const x = inputDb - config.threshold + config.knee / 2;
      gainReduction = ((1 / config.ratio - 1) * x * x) / (2 * config.knee);
    }

    if (gainReduction < envelope) {
      envelope = attackCoeff * envelope + (1 - attackCoeff) * gainReduction;
    } else {
      envelope = releaseCoeff * envelope + (1 - releaseCoeff) * gainReduction;
    }

    const gainLinear = Math.pow(10, envelope / 20);
    result[i] = input * gainLinear;
  }

  return result;
}

export function applyLimiter(
  samples: Float32Array,
  ceiling: number,
  releaseUs: number,
  sampleRate: number,
): Float32Array {
  const result = new Float32Array(samples.length);
  const ceilingLinear = Math.pow(10, ceiling / 20);
  const releaseCoeff = Math.exp(-1 / ((releaseUs * sampleRate) / 1_000_000));

  let envelope = 0;

  for (let i = 0; i < samples.length; i++) {
    const input = samples[i]!;
    const absInput = Math.abs(input);

    if (absInput > ceilingLinear) {
      const targetGain = ceilingLinear / absInput;
      envelope = releaseCoeff * envelope + (1 - releaseCoeff) * targetGain;
    } else {
      envelope = releaseCoeff * envelope + (1 - releaseCoeff) * 1;
    }

    result[i] = input * Math.min(1, envelope);
  }

  return result;
}

export interface GateConfig {
  readonly threshold: number;
  readonly attackUs: number;
  readonly releaseUs: number;
  readonly holdUs: number;
}

export function applyGate(
  samples: Float32Array,
  config: GateConfig,
  sampleRate: number,
): Float32Array {
  const result = new Float32Array(samples.length);
  const thresholdLinear = Math.pow(10, config.threshold / 20);
  const attackCoeff = Math.exp(-1 / ((config.attackUs * sampleRate) / 1_000_000));
  const releaseCoeff = Math.exp(-1 / ((config.releaseUs * sampleRate) / 1_000_000));
  const holdSamples = Math.floor((config.holdUs * sampleRate) / 1_000_000);

  let gateGain = 0;
  let holdCounter = 0;

  for (let i = 0; i < samples.length; i++) {
    const input = samples[i]!;
    const absInput = Math.abs(input);

    if (absInput > thresholdLinear) {
      gateGain = attackCoeff * gateGain + (1 - attackCoeff) * 1;
      holdCounter = holdSamples;
    } else if (holdCounter > 0) {
      holdCounter--;
    } else {
      gateGain = releaseCoeff * gateGain + (1 - releaseCoeff) * 0;
    }

    result[i] = input * gateGain;
  }

  return result;
}

export { computeBiquadCoeffs, processBiquad };
