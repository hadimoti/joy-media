/**
 * Export/preview audio buffer allocation.
 *
 * Web Audio's `createBuffer(numberOfChannels, length, sampleRate)` takes
 * (channels, length, rate). JOY-001 was a regression where the *sample length*
 * was passed into the *channels* slot — a ~1.44M sample count became
 * "1.44M channels", which threw a Web Audio range error and failed every MP4
 * export. This helper pins the correct argument order and is unit-tested so the
 * mistake cannot be reintroduced.
 */

export interface MonoBufferAudioContext {
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer;
}

/** Allocate a mono AudioBuffer in the correct `(1, length, sampleRate)` order. */
export function createMonoAudioBuffer(
  audioContext: MonoBufferAudioContext,
  samples: ArrayLike<number>,
  sampleRate: number,
): AudioBuffer {
  if (samples.length <= 0) throw new Error('cannot allocate a buffer for empty audio');
  if (!(sampleRate > 0)) throw new Error('sample rate must be positive');
  return audioContext.createBuffer(1, samples.length, sampleRate);
}
