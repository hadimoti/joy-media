import type { AudioBus } from './graph.js';

export function applyGain(samples: Float32Array, gain: number): Float32Array {
  const result = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    result[i] = samples[i]! * gain;
  }
  return result;
}

export function applyPan(
  samples: Float32Array,
  pan: number,
): { left: Float32Array; right: Float32Array } {
  const clampedPan = Math.max(-1, Math.min(1, pan));
  const angle = (clampedPan + 1) * (Math.PI / 4);
  const leftGain = Math.cos(angle);
  const rightGain = Math.sin(angle);

  const left = new Float32Array(samples.length);
  const right = new Float32Array(samples.length);

  for (let i = 0; i < samples.length; i++) {
    left[i] = samples[i]! * leftGain;
    right[i] = samples[i]! * rightGain;
  }

  return { left, right };
}

export function applyFade(
  samples: Float32Array,
  fadeInUs: number,
  fadeOutUs: number,
  sampleRate: number,
): Float32Array {
  const result = new Float32Array(samples);
  const fadeInSamples = Math.floor((fadeInUs * sampleRate) / 1_000_000);
  const fadeOutSamples = Math.floor((fadeOutUs * sampleRate) / 1_000_000);

  for (let i = 0; i < fadeInSamples && i < result.length; i++) {
    result[i] = result[i]! * (i / fadeInSamples);
  }

  const fadeOutStart = result.length - fadeOutSamples;
  for (let i = 0; i < fadeOutSamples && fadeOutStart + i < result.length; i++) {
    const idx = fadeOutStart + i;
    if (idx >= 0) {
      result[idx] = result[idx]! * (1 - i / fadeOutSamples);
    }
  }

  return result;
}

export function applyCrossfade(
  outgoing: Float32Array,
  incoming: Float32Array,
  overlapUs: number,
  sampleRate: number,
): Float32Array {
  const overlapSamples = Math.floor((overlapUs * sampleRate) / 1_000_000);
  const result = new Float32Array(overlapSamples);

  for (let i = 0; i < overlapSamples; i++) {
    const t = i / overlapSamples;
    const outgoingGain = Math.cos(t * Math.PI * 0.5);
    const incomingGain = Math.sin(t * Math.PI * 0.5);

    const outSample = i < outgoing.length ? outgoing[i]! : 0;
    const inSample = i < incoming.length ? incoming[i]! : 0;

    result[i] = outSample * outgoingGain + inSample * incomingGain;
  }

  return result;
}

export function mixBuses(
  buffers: Map<string, Float32Array>,
  routing: readonly AudioBus[],
): { left: Float32Array; right: Float32Array } {
  let maxLength = 0;
  for (const bus of routing) {
    const buffer = buffers.get(bus.id);
    if (buffer && buffer.length > maxLength) {
      maxLength = buffer.length;
    }
  }

  const left = new Float32Array(maxLength);
  const right = new Float32Array(maxLength);

  for (const bus of routing) {
    if (bus.mute) continue;

    const buffer = buffers.get(bus.id);
    if (!buffer) continue;

    const { left: busLeft, right: busRight } = applyPan(buffer, bus.pan);

    for (let i = 0; i < buffer.length; i++) {
      left[i] = (left[i] ?? 0) + busLeft[i]! * bus.gain;
      right[i] = (right[i] ?? 0) + busRight[i]! * bus.gain;
    }
  }

  return { left, right };
}
