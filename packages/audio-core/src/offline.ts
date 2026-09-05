import type { AudioClipConfig, AudioBus, AudioEffect } from './graph.js';
import { applyFade } from './processing.js';
import { applyEq, applyCompressor, applyLimiter, applyGate } from './effects.js';
import { measurePeak, measureLoudness, detectClipping } from './analysis.js';

export interface OfflineRenderConfig {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly startUs: number;
  readonly endUs: number;
  /**
   * Optional time-varying mixer resolver. Hosts provide it from their
   * project/evaluator boundary; audio-core remains independent of that model.
   */
  readonly automation?: OfflineAudioAutomation;
}

export interface OfflineAudioAutomation {
  /** Block size used for continuous gain/pan ramps (default 256 samples). */
  readonly blockSize?: number;
  readonly clipAt?: (clipId: string, timeUs: number, fallback: AudioClipConfig) => AudioClipConfig;
  readonly busAt?: (busId: string, timeUs: number, fallback: AudioBus) => AudioBus;
}

export interface AudioClipRenderSpec {
  readonly clipId: string;
  readonly samples: Float32Array;
  /** Planar source channels. Omit for mono sources. */
  readonly channelData?: readonly Float32Array[];
  readonly startUs: number;
  readonly config: AudioClipConfig;
  readonly effects: readonly AudioEffect[];
}

export interface OfflineRenderResult {
  /** Mono compatibility mix; use channelData when writing multichannel audio. */
  readonly samples: Float32Array;
  readonly channelData: readonly Float32Array[];
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly durationUs: number;
  readonly peakLevel: number;
  readonly loudness: number;
  readonly clipping: boolean;
}

export interface AudioRenderJob {
  readonly jobId: string;
  readonly projectId: string;
  readonly config: OfflineRenderConfig;
  readonly clips: readonly AudioClipRenderSpec[];
  readonly buses: readonly AudioBus[];
  status: 'pending' | 'rendering' | 'completed' | 'failed';
  result?: OfflineRenderResult;
  error?: string;
  progress: number;
}

export interface AudioRenderRequest {
  readonly requestId: string;
  readonly jobId: string;
  readonly outputFormat: 'wav' | 'pcm16' | 'pcm32f';
  readonly destination: string;
}

function applyEffect(samples: Float32Array, effect: AudioEffect, sampleRate: number): Float32Array {
  switch (effect.kind) {
    case 'eq':
      return applyEq(samples, effect.bands, sampleRate);
    case 'compressor':
      return applyCompressor(
        samples,
        {
          threshold: effect.threshold,
          ratio: effect.ratio,
          attackUs: effect.attackUs,
          releaseUs: effect.releaseUs,
          knee: effect.knee,
        },
        sampleRate,
      );
    case 'limiter':
      return applyLimiter(samples, effect.ceiling, effect.releaseUs, sampleRate);
    case 'gate':
      return applyGate(
        samples,
        {
          threshold: effect.threshold,
          attackUs: effect.attackUs,
          releaseUs: effect.releaseUs,
          holdUs: effect.holdUs,
        },
        sampleRate,
      );
  }
}

function applyClipEffects(
  samples: Float32Array,
  effects: readonly AudioEffect[],
  sampleRate: number,
): Float32Array {
  let result = samples;
  for (const effect of effects) {
    result = applyEffect(result, effect, sampleRate);
  }
  return result;
}

function applyClipConfig(
  samples: Float32Array,
  config: AudioClipConfig,
  sampleRate: number,
): Float32Array {
  let result = samples;

  if (config.fadeInUs || config.fadeOutUs) {
    result = applyFade(result, config.fadeInUs ?? 0, config.fadeOutUs ?? 0, sampleRate);
  }

  return result;
}

export function renderOfflineAudio(
  clips: readonly AudioClipRenderSpec[],
  buses: readonly AudioBus[],
  config: OfflineRenderConfig,
): OfflineRenderResult {
  if (config.channels === 2) return renderStereoAudio(clips, buses, config);
  const durationUs = config.endUs - config.startUs;
  const totalSamples = Math.floor((durationUs * config.sampleRate) / 1_000_000);
  const output = new Float32Array(totalSamples);

  const busBuffers = new Map<string, Float32Array>();
  for (const bus of buses) {
    busBuffers.set(bus.id, new Float32Array(totalSamples));
  }
  const anySolo = clips.some((clip) => clip.config.solo);
  const blockSize = config.automation?.blockSize ?? 256;
  if (!Number.isSafeInteger(blockSize) || blockSize < 1)
    throw new RangeError('automation blockSize must be a positive safe integer');

  for (const clip of clips) {
    if (config.automation?.clipAt === undefined && clip.config.mute) continue;
    if (anySolo && !clip.config.solo) continue;

    const clipOffsetUs = clip.startUs - config.startUs;
    if (clipOffsetUs < 0 || clipOffsetUs >= durationUs) continue;

    const sampleOffset = Math.floor((clipOffsetUs * config.sampleRate) / 1_000_000);

    let processed = applyClipEffects(clip.samples, clip.effects, config.sampleRate);
    processed = applyClipConfig(processed, clip.config, config.sampleRate);

    const targetBuffer = buses.length > 0 ? busBuffers.get(buses[0]!.id) : output;
    if (!targetBuffer) continue;

    const mixLength = Math.min(processed.length, totalSamples - sampleOffset);
    let blockIndex = -1;
    let startConfig = clip.config;
    let endConfig = clip.config;
    for (let i = 0; i < mixLength; i++) {
      const outputSample = sampleOffset + i;
      const nextBlockIndex = Math.floor(outputSample / blockSize);
      if (nextBlockIndex !== blockIndex) {
        blockIndex = nextBlockIndex;
        const startUs = config.startUs + Math.floor((outputSample * 1_000_000) / config.sampleRate);
        const endSample = Math.min(totalSamples, (blockIndex + 1) * blockSize);
        const endUs = config.startUs + Math.floor((endSample * 1_000_000) / config.sampleRate);
        startConfig = config.automation?.clipAt?.(clip.clipId, startUs, clip.config) ?? clip.config;
        endConfig = config.automation?.clipAt?.(clip.clipId, endUs, clip.config) ?? clip.config;
      }
      const blockStart = blockIndex * blockSize;
      const blockEnd = Math.min(totalSamples, blockStart + blockSize);
      const fraction =
        blockEnd === blockStart ? 0 : (outputSample - blockStart) / (blockEnd - blockStart);
      if (startConfig.mute) continue;
      const gain = interpolate(startConfig.gain, endConfig.gain, fraction);
      const pan = interpolate(startConfig.pan, endConfig.pan, fraction);
      targetBuffer[outputSample]! += processed[i]! * gain * monoPanGain(pan);
    }
  }

  for (const bus of buses) {
    const buffer = busBuffers.get(bus.id);
    if (!buffer || (config.automation?.busAt === undefined && bus.mute)) continue;

    let blockIndex = -1;
    let startBus = bus;
    let endBus = bus;
    for (let i = 0; i < buffer.length; i++) {
      const nextBlockIndex = Math.floor(i / blockSize);
      if (nextBlockIndex !== blockIndex) {
        blockIndex = nextBlockIndex;
        const startUs = config.startUs + Math.floor((i * 1_000_000) / config.sampleRate);
        const endSample = Math.min(totalSamples, (blockIndex + 1) * blockSize);
        const endUs = config.startUs + Math.floor((endSample * 1_000_000) / config.sampleRate);
        startBus = config.automation?.busAt?.(bus.id, startUs, bus) ?? bus;
        endBus = config.automation?.busAt?.(bus.id, endUs, bus) ?? bus;
      }
      if (startBus.mute) continue;
      const blockStart = blockIndex * blockSize;
      const blockEnd = Math.min(totalSamples, blockStart + blockSize);
      const fraction = blockEnd === blockStart ? 0 : (i - blockStart) / (blockEnd - blockStart);
      output[i]! +=
        buffer[i]! *
        interpolate(startBus.gain, endBus.gain, fraction) *
        monoPanGain(interpolate(startBus.pan, endBus.pan, fraction));
    }
  }

  const peakMeasurement = measurePeak(output);
  const loudnessMeasurement = measureLoudness(output, config.sampleRate);
  const clippingDetection = detectClipping(output);

  return {
    samples: output,
    channelData: [output],
    sampleRate: config.sampleRate,
    channels: config.channels,
    durationUs,
    peakLevel: peakMeasurement.peakDb,
    loudness: loudnessMeasurement.integrated,
    clipping: clippingDetection.clipping,
  };
}

/** Web Audio StereoPanner law, including stereo crossfeed at the extremes. */
function stereoPan(left: number, right: number, pan: number, mono: boolean): [number, number] {
  const p = Math.max(-1, Math.min(1, pan));
  if (mono) {
    const angle = ((p + 1) * Math.PI) / 4;
    return [left * Math.cos(angle), left * Math.sin(angle)];
  }
  const angle = ((p <= 0 ? p + 1 : p) * Math.PI) / 2;
  return p <= 0
    ? [left + right * Math.cos(angle), right * Math.sin(angle)]
    : [left * Math.cos(angle), right + left * Math.sin(angle)];
}

function renderStereoAudio(
  clips: readonly AudioClipRenderSpec[],
  buses: readonly AudioBus[],
  config: OfflineRenderConfig,
): OfflineRenderResult {
  const durationUs = config.endUs - config.startUs;
  const length = Math.floor((durationUs * config.sampleRate) / 1_000_000);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const blockSize = config.automation?.blockSize ?? 256;
  if (!Number.isSafeInteger(blockSize) || blockSize < 1)
    throw new RangeError('automation blockSize must be a positive safe integer');
  const anySolo = clips.some((clip) => clip.config.solo);
  const anyBusSolo = buses.some((bus) => bus.solo);
  const master = buses.find((bus) => bus.id === 'master') ?? buses[0];
  for (const clip of clips) {
    if (anySolo && !clip.config.solo) continue;
    const bus = buses.find((candidate) => candidate.inputs.includes(clip.clipId)) ?? master;
    if (anyBusSolo && !bus?.solo) continue;
    const channels = clip.channelData ?? [clip.samples];
    if (channels.length < 1 || channels.length > 2)
      throw new RangeError('offline audio supports mono or stereo sources');
    const processed = channels.map((samples) =>
      applyClipConfig(
        applyClipEffects(samples, clip.effects, config.sampleRate),
        clip.config,
        config.sampleRate,
      ),
    );
    const offset = Math.floor(((clip.startUs - config.startUs) * config.sampleRate) / 1_000_000);
    const first = Math.max(0, offset);
    const end = Math.min(length, offset + processed[0]!.length);
    for (let block = Math.floor(first / blockSize) * blockSize; block < end; block += blockSize) {
      const blockEnd = Math.min(length, block + blockSize);
      const startUs = config.startUs + Math.floor((block * 1_000_000) / config.sampleRate);
      const endUs = config.startUs + Math.floor((blockEnd * 1_000_000) / config.sampleRate);
      const from = config.automation?.clipAt?.(clip.clipId, startUs, clip.config) ?? clip.config;
      const to = config.automation?.clipAt?.(clip.clipId, endUs, clip.config) ?? clip.config;
      const busFrom = bus && (config.automation?.busAt?.(bus.id, startUs, bus) ?? bus);
      const busTo = bus && (config.automation?.busAt?.(bus.id, endUs, bus) ?? bus);
      if (from.mute || busFrom?.mute) continue;
      for (let i = Math.max(first, block); i < Math.min(end, blockEnd); i++) {
        const fraction = (i - block) / (blockEnd - block);
        const gain =
          interpolate(from.gain, to.gain, fraction) *
          interpolate(busFrom?.gain ?? 1, busTo?.gain ?? 1, fraction);
        // Preview combines clip and master pan before the StereoPannerNode.
        const pan =
          interpolate(from.pan, to.pan, fraction) +
          interpolate(busFrom?.pan ?? 0, busTo?.pan ?? 0, fraction);
        const sourceIndex = i - offset;
        const [l, r] = stereoPan(
          processed[0]![sourceIndex] ?? 0,
          processed[1]?.[sourceIndex] ?? 0,
          pan,
          channels.length === 1,
        );
        left[i]! += l * gain;
        right[i]! += r * gain;
      }
    }
  }
  const samples = Float32Array.from(left, (sample, i) => (sample + right[i]!) / 2);
  return {
    samples,
    channelData: [left, right],
    sampleRate: config.sampleRate,
    channels: 2,
    durationUs,
    peakLevel: Math.max(measurePeak(left).peakDb, measurePeak(right).peakDb),
    loudness: measureLoudness(samples, config.sampleRate).integrated,
    clipping: detectClipping(left).clipping || detectClipping(right).clipping,
  };
}

function interpolate(start: number, end: number, fraction: number): number {
  return start + (end - start) * fraction;
}

/** Equivalent mono contribution of the existing linear stereo pan law. */
function monoPanGain(pan: number): number {
  const clamped = Math.max(-1, Math.min(1, pan));
  const left = clamped >= 0 ? 1 - clamped : 1;
  const right = clamped <= 0 ? 1 + clamped : 1;
  return (left + right) * 0.5;
}
