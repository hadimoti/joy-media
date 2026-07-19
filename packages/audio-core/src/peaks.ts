import type { WaveformBucket } from './audio.js';
export function encodeWaveformPeaks(peaks: readonly WaveformBucket[]): Uint8Array {
  const bytes = new Uint8Array(peaks.length * 4);
  const view = new DataView(bytes.buffer);
  peaks.forEach((peak, index) => {
    view.setInt16(index * 4, quantize(peak.min), true);
    view.setInt16(index * 4 + 2, quantize(peak.max), true);
  });
  return bytes;
}
export function decodeWaveformPeaks(bytes: Uint8Array): readonly WaveformBucket[] {
  if (bytes.length % 4 !== 0)
    throw new RangeError('waveform peak bytes must be int16 min/max pairs');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const peaks: WaveformBucket[] = [];
  for (let offset = 0; offset < bytes.length; offset += 4)
    peaks.push({
      min: view.getInt16(offset, true) / 32768,
      max: view.getInt16(offset + 2, true) / 32767,
    });
  return peaks;
}
function quantize(value: number): number {
  return Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767));
}
