/**
 * Browser mixer buffer helper (P14.3).
 *
 * Builds a stereo-mixed Float32Array from per-clip decoded samples and the
 * current mixer graph state. Implemented with local helpers so the editor-web
 * bundle does not pull the Node-only `@joy-media/audio-core` entrypoint.
 */

export interface MixerClipSource {
  readonly clipId: string;
  readonly samples: Float32Array;
}

function applyFade(samples: Float32Array, fadeInUs: number, fadeOutUs: number, sampleRate: number): Float32Array {
  const result = new Float32Array(samples);
  const fadeInSamples = Math.floor((fadeInUs * sampleRate) / 1_000_000);
  const fadeOutSamples = Math.floor((fadeOutUs * sampleRate) / 1_000_000);
  for (let i = 0; i < fadeInSamples && i < result.length; i++) {
    result[i] = samples[i]! * (i / fadeInSamples);
  }
  const fadeOutStart = result.length - fadeOutSamples;
  for (let i = 0; i < fadeOutSamples && fadeOutStart + i < result.length; i++) {
    const idx = fadeOutStart + i;
    if (idx >= 0) result[idx] = samples[idx]! * (1 - i / fadeOutSamples);
  }
  return result;
}

function applyGain(samples: Float32Array, gain: number): Float32Array {
  const result = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    result[i] = gain === 0 ? 0 : samples[i]! * gain;
  }
  return result;
}

function applyPan(samples: Float32Array, pan: number): { left: Float32Array; right: Float32Array } {
  const clampedPan = Math.max(-1, Math.min(1, pan));
  const leftGain = clampedPan >= 0 ? 1 - clampedPan : 1;
  const rightGain = clampedPan <= 0 ? 1 + clampedPan : 1;
  const left = new Float32Array(samples.length);
  const right = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    left[i] = samples[i]! * leftGain;
    right[i] = samples[i]! * rightGain;
  }
  return { left, right };
}

export function buildMixerBuffer(
  clipSources: readonly MixerClipSource[],
  clips: Record<
    string,
    {
      readonly gain: number;
      readonly pan: number;
      readonly mute: boolean;
      readonly solo?: boolean;
      readonly fadeInUs?: number;
      readonly fadeOutUs?: number;
    }
  >,
  buses: readonly { readonly id: string; readonly gain: number; readonly pan: number; readonly mute: boolean }[],
  durationUs: number,
  sampleRate: number,
): Float32Array {
  const totalSamples = Math.max(1, Math.floor((durationUs * sampleRate) / 1_000_000));
  const busBuffers = new Map<string, Float32Array>();
  for (const bus of buses) busBuffers.set(bus.id, new Float32Array(totalSamples));

  const anySolo = Object.values(clips).some((clip) => clip.solo === true);

  for (const source of clipSources) {
    const config = clips[source.clipId];
    if (config === undefined || config.mute) continue;
    if (anySolo && config.solo !== true) continue;
    let clipBuffer = source.samples;
    if (clipBuffer.length !== totalSamples) {
      const padded = new Float32Array(totalSamples);
      const copyLength = Math.min(clipBuffer.length, totalSamples);
      for (let i = 0; i < copyLength; i++) padded[i] = clipBuffer[i]!;
      clipBuffer = padded;
    }
    clipBuffer = applyFade(clipBuffer, config.fadeInUs ?? 0, config.fadeOutUs ?? 0, sampleRate);
    clipBuffer = applyGain(clipBuffer, config.gain);
    const target = busBuffers.get(buses[0]?.id ?? 'master');
    if (!target) continue;
    const { left, right } = applyPan(clipBuffer, config.pan);
    for (let i = 0; i < totalSamples; i++) {
      target[i] = (target[i] ?? 0) + (left[i]! + right[i]!) * 0.5;
    }
  }

  const output = new Float32Array(totalSamples);
  for (const bus of buses) {
    const buffer = busBuffers.get(bus.id);
    if (!buffer || bus.mute) continue;
    const { left, right } = applyPan(buffer, bus.pan);
    for (let i = 0; i < totalSamples; i++) {
      output[i] = (output[i] ?? 0) + (left[i]! + right[i]!) * 0.5 * bus.gain;
    }
  }
  return output;
}
