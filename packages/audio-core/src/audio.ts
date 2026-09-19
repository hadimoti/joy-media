/** P00.7 deterministic PCM waveform, audio-clock, and local Worker-export proof. */

import { sha256Bytes } from './sha256.js';

const US_PER_SECOND = 1_000_000n;

export interface WaveformBucket {
  readonly min: number;
  readonly max: number;
}

export interface PcmWavExport {
  readonly mimeType: 'audio/wav';
  readonly sampleRate: number;
  readonly sampleCount: number;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface DriftMeasurement {
  readonly checkpoints: readonly { readonly timeUs: number; readonly driftUs: number }[];
  readonly maxAbsoluteDriftUs: number;
}

export class AudioSpikeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AudioSpikeError';
    this.code = code;
  }
}

/** Exact floor mapping from timeline microseconds to a PCM sample index. */
export function sampleIndexAtUs(timeUs: number, sampleRate: number): number {
  assertTimeAndRate(timeUs, sampleRate);
  return safeNumber((BigInt(timeUs) * BigInt(sampleRate)) / US_PER_SECOND, 'sample index');
}

/** Start time of a PCM sample, in integer microseconds (floor projection). */
export function sampleStartUs(sampleIndex: number, sampleRate: number): number {
  if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 0) {
    throw new AudioSpikeError(
      'AUDIO_TIME_INVALID',
      'sampleIndex must be a non-negative safe integer',
    );
  }
  assertRate(sampleRate);
  return safeNumber((BigInt(sampleIndex) * US_PER_SECOND) / BigInt(sampleRate), 'sample time');
}

/** Min/max waveform peaks in deterministic contiguous sample buckets. */
export function buildWaveform(
  samples: Float32Array,
  bucketCount: number,
): readonly WaveformBucket[] {
  if (!Number.isSafeInteger(bucketCount) || bucketCount < 1) {
    throw new AudioSpikeError('AUDIO_WAVEFORM_INVALID', 'bucketCount must be a positive integer');
  }
  if (samples.length === 0) return [];
  const buckets: WaveformBucket[] = [];
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = Math.floor((bucket * samples.length) / bucketCount);
    const end = Math.floor(((bucket + 1) * samples.length) / bucketCount);
    if (start === end) continue;
    let min = samples[start]!;
    let max = min;
    for (let index = start + 1; index < end; index++) {
      const sample = samples[index]!;
      min = Math.min(min, sample);
      max = Math.max(max, sample);
    }
    buckets.push({ min, max });
  }
  return buckets;
}

/**
 * Zero-allocation quantised int16 peak generation. Writes directly into a
 * caller-provided (or newly allocated) `Int16Array` using the layout
 * `[min0, max0, min1, max1, ...]` — i.e. one min/max int16 pair per bucket.
 *
 * Negative values use the asymmetric `-32768` floor; positive values use the
 * `+32767` ceiling, matching the existing PCM16 / waveform-peak encoders.
 *
 * When `samples.length` is shorter than `bucketCount * 2`, the trailing slots
 * are zero-filled; this keeps the output length deterministic.
 */
export function buildWaveformDirect(
  samples: Float32Array,
  bucketCount: number,
  outBuffer?: Int16Array,
): Int16Array {
  if (!Number.isSafeInteger(bucketCount) || bucketCount < 1) {
    throw new AudioSpikeError('AUDIO_WAVEFORM_INVALID', 'bucketCount must be a positive integer');
  }
  const length = bucketCount * 2;
  const out =
    outBuffer !== undefined && outBuffer.length >= length ? outBuffer : new Int16Array(length);
  if (samples.length === 0) {
    out.fill(0);
    return out;
  }
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = Math.floor((bucket * samples.length) / bucketCount);
    const end = Math.floor(((bucket + 1) * samples.length) / bucketCount);
    const base = bucket * 2;
    if (start === end) {
      out[base] = 0;
      out[base + 1] = 0;
      continue;
    }
    let min = samples[start]!;
    let max = min;
    for (let index = start + 1; index < end; index++) {
      const sample = samples[index]!;
      if (sample < min) min = sample;
      else if (sample > max) max = sample;
    }
    out[base] = toPcm16(min);
    out[base + 1] = toPcm16(max);
  }
  return out;
}

/**
 * Zero-allocation in-place audio mixer. Each source is scaled by its gain and
 * summed into the destination buffer; the output is clamped to `[-1, 1]`.
 *
 * The destination length must be `>=` every source length; sources shorter
 * than the destination contribute silence past their own end. Excess samples
 * at the tail of `destination` are zeroed so callers can reuse a scratch
 * buffer without leftover state.
 */
export function mixAudioTracks(
  sources: readonly Float32Array[],
  destination: Float32Array,
  gains?: readonly number[],
): Float32Array {
  if (sources.length === 0) {
    destination.fill(0);
    return destination;
  }
  if (gains !== undefined && gains.length !== sources.length) {
    throw new AudioSpikeError('AUDIO_MIX_INVALID', 'gains length must match sources length');
  }
  const length = destination.length;
  destination.fill(0);
  for (let s = 0; s < sources.length; s++) {
    const source = sources[s]!;
    const gain = gains !== undefined ? gains[s]! : 1;
    const span = Math.min(source.length, length);
    for (let index = 0; index < span; index++) {
      const mixed = destination[index]! + source[index]! * gain;
      destination[index] = mixed > 1 ? 1 : mixed < -1 ? -1 : mixed;
    }
  }
  return destination;
}

/**
 * Preview clock driven by the timeline/audio clock. Seek and every tick map
 * from absolute microsecond time, avoiding accumulated-duration rounding drift.
 */
export class AudioPreviewClock {
  #timeUs = 0;

  constructor(readonly sampleRate: number) {
    assertRate(sampleRate);
  }

  get timeUs(): number {
    return this.#timeUs;
  }

  get sampleIndex(): number {
    return sampleIndexAtUs(this.#timeUs, this.sampleRate);
  }

  seek(timeUs: number): number {
    assertTimeAndRate(timeUs, this.sampleRate);
    this.#timeUs = timeUs;
    return this.sampleIndex;
  }

  /** Advances by an exact timeline duration; no WebAudio wall clock is consulted. */
  advanceBy(elapsedUs: number): number {
    if (
      !Number.isSafeInteger(elapsedUs) ||
      elapsedUs < 0 ||
      this.#timeUs + elapsedUs > Number.MAX_SAFE_INTEGER
    ) {
      throw new AudioSpikeError(
        'AUDIO_TIME_INVALID',
        'elapsedUs must be a safe non-negative duration',
      );
    }
    return this.seek(this.#timeUs + elapsedUs);
  }
}

/**
 * Deterministic simple Worker export. It creates a mono PCM16 WAV entirely
 * from supplied samples; filesystem/FFmpeg integration is intentionally later.
 */
export function exportPcm16Wav(samples: Float32Array, sampleRate: number): PcmWavExport {
  assertRate(sampleRate);
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index++) {
    view.setInt16(44 + index * 2, toPcm16(samples[index]!), true);
  }
  return {
    mimeType: 'audio/wav',
    sampleRate,
    sampleCount: samples.length,
    bytes,
    sha256: sha256Bytes(bytes),
  };
}

/** Measures timeline-to-audio-clock quantization drift at every supplied checkpoint. */
export function measureAudioClockDrift(
  referenceDurationUs: number,
  sampleRate: number,
  checkpointsUs: readonly number[],
): DriftMeasurement {
  assertTimeAndRate(referenceDurationUs, sampleRate);
  const checkpoints = checkpointsUs.map((timeUs) => {
    if (!Number.isSafeInteger(timeUs) || timeUs < 0 || timeUs > referenceDurationUs) {
      throw new AudioSpikeError(
        'AUDIO_TIME_INVALID',
        'checkpoint falls outside reference duration',
      );
    }
    const sample = sampleIndexAtUs(timeUs, sampleRate);
    return { timeUs, driftUs: Math.abs(timeUs - sampleStartUs(sample, sampleRate)) };
  });
  return {
    checkpoints,
    maxAbsoluteDriftUs: Math.max(...checkpoints.map((checkpoint) => checkpoint.driftUs), 0),
  };
}

function assertTimeAndRate(timeUs: number, sampleRate: number): void {
  if (!Number.isSafeInteger(timeUs) || timeUs < 0) {
    throw new AudioSpikeError('AUDIO_TIME_INVALID', 'timeUs must be a non-negative safe integer');
  }
  assertRate(sampleRate);
}

function assertRate(sampleRate: number): void {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 1) {
    throw new AudioSpikeError('AUDIO_RATE_INVALID', 'sampleRate must be a positive integer');
  }
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AudioSpikeError('AUDIO_TIME_INVALID', `${label} exceeds safe integer range`);
  }
  return Number(value);
}

function toPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
  return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++)
    bytes[offset + index] = value.charCodeAt(index);
}
