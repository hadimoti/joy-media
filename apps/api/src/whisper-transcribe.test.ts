import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runWhisperTranscription } from './whisper-transcribe.js';

let whisperAvailable = false;
try {
  execSync('which faster-whisper', { stdio: 'ignore' });
  whisperAvailable = true;
} catch {
  /* faster-whisper not installed */
}

/** Minimal silent WAV (16 kHz mono PCM16, 0.4s) for helper smoke tests. */
function silentWav(durationSec = 0.4, sampleRate = 16_000): Uint8Array {
  const samples = Math.floor(sampleRate * durationSec);
  const dataSize = samples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  return new Uint8Array(buffer);
}

describe.skipIf(!whisperAvailable)('runWhisperTranscription', () => {
  it('returns a faster-whisper payload for silent WAV (may be empty words)', () => {
    const transcript = runWhisperTranscription(silentWav(), 'en', {
      mediaExtension: 'wav',
      timeoutMs: 120_000,
    });
    expect(transcript.modelId.startsWith('faster-whisper-')).toBe(true);
    expect(transcript.language).toBe('en-US');
    expect(Array.isArray(transcript.words)).toBe(true);
  }, 180_000);
});
