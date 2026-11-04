import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { prepareExportAudioChannels } from './export-audio.js';
import { decodeExportAudioWindow } from './export-audio-window.js';

// Real decoding, no mocks: mediabunny decodes this PCM file in plain JavaScript, so it runs in Node.

const RATE = 48_000;
const FRAMES = RATE * 60;

/** A 60 s stereo 16-bit WAV: 440 Hz on the left and 880 Hz on the right, so every window is distinct. */
function toneWav(): Blob {
  const dataBytes = FRAMES * 4;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let frame = 0; frame < FRAMES; frame++) {
    view.setInt16(offset, Math.round(Math.sin((2 * Math.PI * 440 * frame) / RATE) * 16_000), true);
    view.setInt16(
      offset + 2,
      Math.round(Math.sin((2 * Math.PI * 880 * frame) / RATE) * 16_000),
      true,
    );
    offset += 4;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** The whole file, decoded in one pass: the reference that a window has to match. */
async function decodeWhole(blob: Blob): Promise<Float32Array[]> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (track === null) throw new Error('the test file has no audio track');
    const channels = [new Float32Array(FRAMES), new Float32Array(FRAMES)];
    for await (const sample of new AudioSampleSink(track).samples()) {
      const start = Math.round(sample.timestamp * RATE);
      const count = Math.min(sample.numberOfFrames, FRAMES - start);
      for (let channel = 0; channel < 2; channel++) {
        const plane = new Float32Array(sample.numberOfFrames);
        sample.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
        channels[channel]!.set(plane.subarray(0, count), start);
      }
      sample.close();
    }
    return channels;
  } finally {
    input.dispose();
  }
}

function maxDifference(left: Float32Array, right: Float32Array): number {
  let max = 0;
  for (let index = 0; index < left.length; index++)
    max = Math.max(max, Math.abs(left[index]! - right[index]!));
  return max;
}

describe('decodeExportAudioWindow on a real PCM file', () => {
  it('decodes a window to the same samples as a whole-file decode', async () => {
    const blob = toneWav();
    const reference = await decodeWhole(blob);
    const decoded = await decodeExportAudioWindow({
      blob,
      clip: { sourceInUs: 10_000_000, durationUs: 5_000_000 },
      outputSampleRate: RATE,
      label: 'tone.wav',
      signal: new AbortController().signal,
    });
    expect(decoded).toBeDefined();
    expect(decoded!.sampleRate).toBe(RATE);
    expect(decoded!.channels[0]!.length).toBeLessThan(FRAMES / 10);
    decoded!.channels.forEach((channel, index) => {
      const expected = reference[index]!.subarray(
        decoded!.firstSample,
        decoded!.firstSample + channel.length,
      );
      expect(maxDifference(channel, expected)).toBeLessThanOrEqual(1e-6);
    });
  });

  it('prepares the same mix from the window as from the whole file, for a reversed, retimed clip', async () => {
    const blob = toneWav();
    const reference = await decodeWhole(blob);
    const clip = {
      sourceInUs: 20_000_000,
      durationUs: 3_000_000,
      playbackRate: 1.5,
      reversed: true,
    };
    const decoded = await decodeExportAudioWindow({
      blob,
      clip,
      outputSampleRate: RATE,
      label: 'tone.wav',
      signal: new AbortController().signal,
    });
    const windowed = prepareExportAudioChannels(
      decoded!.channels,
      decoded!.sampleRate,
      RATE,
      clip,
      decoded!.firstSample,
    );
    const whole = prepareExportAudioChannels(reference, RATE, RATE, clip);
    windowed.forEach((channel, index) =>
      expect(maxDifference(channel, whole[index]!)).toBeLessThanOrEqual(1e-6),
    );
  });
});
