import { describe, expect, it } from 'vitest';
import { resolveEdgeVoice, runEdgeSpeechSynthesis } from './speech-synthesize.js';

describe('resolveEdgeVoice', () => {
  it('maps FA/EN languages to neural voices', () => {
    expect(resolveEdgeVoice('fa-IR', undefined)).toBe('fa-IR-DilaraNeural');
    expect(resolveEdgeVoice('en-US', undefined)).toBe('en-US-EmmaMultilingualNeural');
  });

  it('prefers an explicit non-stock voice id', () => {
    expect(resolveEdgeVoice('en', 'fa-IR-FaridNeural')).toBe('fa-IR-FaridNeural');
  });
});

describe('runEdgeSpeechSynthesis', () => {
  it('produces MP3 bytes via edge-tts', () => {
    const result = runEdgeSpeechSynthesis({ text: 'JOY Media TTS check', language: 'en-US' });
    expect(result.engine).toBe('edge-tts');
    expect(result.dataLeavesDevice).toBe(true);
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.bytesBase64.length).toBeGreaterThan(100);
    expect(Buffer.from(result.bytesBase64, 'base64').byteLength).toBeGreaterThan(500);
  }, 60_000);
});
