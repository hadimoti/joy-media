import type { AudioClipConfig, AudioBus, AudioEffect } from './graph.js';
import { applyGain, applyPan, applyFade } from './processing.js';
import { applyEq, applyCompressor, applyLimiter, applyGate } from './effects.js';
import { measurePeak, measureLoudness, detectClipping } from './analysis.js';

export interface OfflineRenderConfig {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly startUs: number;
  readonly endUs: number;
}

export interface AudioClipRenderSpec {
  readonly clipId: string;
  readonly samples: Float32Array;
  readonly startUs: number;
  readonly config: AudioClipConfig;
  readonly effects: readonly AudioEffect[];
}

export interface OfflineRenderResult {
  readonly samples: Float32Array;
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

  if (config.gain !== 1.0) {
    result = applyGain(result, config.gain);
  }

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
  const durationUs = config.endUs - config.startUs;
  const totalSamples = Math.floor((durationUs * config.sampleRate) / 1_000_000);
  const output = new Float32Array(totalSamples);

  const busBuffers = new Map<string, Float32Array>();
  for (const bus of buses) {
    busBuffers.set(bus.id, new Float32Array(totalSamples));
  }
  const anySolo = clips.some((clip) => clip.config.solo);

  for (const clip of clips) {
    if (clip.config.mute) continue;
    if (anySolo && !clip.config.solo) continue;

    const clipOffsetUs = clip.startUs - config.startUs;
    if (clipOffsetUs < 0 || clipOffsetUs >= durationUs) continue;

    const sampleOffset = Math.floor((clipOffsetUs * config.sampleRate) / 1_000_000);

    let processed = applyClipEffects(clip.samples, clip.effects, config.sampleRate);
    processed = applyClipConfig(processed, clip.config, config.sampleRate);

    const { left, right } = applyPan(processed, clip.config.pan);

    const targetBuffer = buses.length > 0 ? busBuffers.get(buses[0]!.id) : output;
    if (!targetBuffer) continue;

    const mixLength = Math.min(left.length, totalSamples - sampleOffset);
    for (let i = 0; i < mixLength; i++) {
      targetBuffer[sampleOffset + i]! += (left[i]! + right[i]!) * 0.5;
    }
  }

  for (const bus of buses) {
    const buffer = busBuffers.get(bus.id);
    if (!buffer || bus.mute) continue;

    const { left, right } = applyPan(buffer, bus.pan);

    for (let i = 0; i < buffer.length; i++) {
      output[i]! += (left[i]! + right[i]!) * 0.5 * bus.gain;
    }
  }

  const peakMeasurement = measurePeak(output);
  const loudnessMeasurement = measureLoudness(output, config.sampleRate);
  const clippingDetection = detectClipping(output);

  return {
    samples: output,
    sampleRate: config.sampleRate,
    channels: config.channels,
    durationUs,
    peakLevel: peakMeasurement.peakDb,
    loudness: loudnessMeasurement.integrated,
    clipping: clippingDetection.clipping,
  };
}
