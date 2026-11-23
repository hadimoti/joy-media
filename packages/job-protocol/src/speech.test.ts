import { describe, expect, it } from 'vitest';
import {
  parseSpeechSynthesisTiming,
  parseSpeechSynthesizeV1,
  parseSpeechTranscript,
  parseSpeechTranscribeV1,
} from './speech.js';

describe('speech job contracts', () => {
  it('parses valid transcription requests and rejects malformed fields', () => {
    expect(
      parseSpeechTranscribeV1({
        schemaVersion: 1,
        language: 'fa-IR',
        modelId: 'faster-whisper-large-v3-turbo',
        range: { startUs: 0, endUs: 1_000_000 },
      }),
    ).toEqual({
      schemaVersion: 1,
      language: 'fa-IR',
      modelId: 'faster-whisper-large-v3-turbo',
      range: { startUs: 0, endUs: 1_000_000 },
    });
    for (const value of [
      null,
      [],
      'request',
      {},
      { schemaVersion: 2 },
      { schemaVersion: 1, language: 'fr-FR', modelId: 'faster-whisper-large-v3-turbo' },
      { schemaVersion: 1, language: 'en-US', modelId: 'kokoro-82m' },
      {
        schemaVersion: 1,
        language: 'en-US',
        modelId: 'faster-whisper-large-v3-turbo',
        range: { startUs: 1.5, endUs: 5 },
      },
    ]) {
      expect(parseSpeechTranscribeV1(value)).toBeUndefined();
    }
  });

  it('parses compatible built-in synthesis models and purposes', () => {
    expect(
      parseSpeechSynthesizeV1({
        schemaVersion: 1,
        language: 'en-US',
        modelId: 'kokoro-82m',
        text: 'Hello',
      }),
    ).toEqual({ schemaVersion: 1, language: 'en-US', modelId: 'kokoro-82m', text: 'Hello' });
    expect(
      parseSpeechSynthesizeV1({
        schemaVersion: 1,
        language: 'en-US',
        modelId: 'chatterbox-en',
        text: 'Hello',
        purpose: 'general',
      }),
    ).toBeDefined();
    expect(
      parseSpeechSynthesizeV1({
        schemaVersion: 1,
        language: 'fa-IR',
        modelId: 'chatterbox-fa',
        text: 'سلام',
        purpose: 'personal-noncommercial',
      }),
    ).toBeDefined();
    expect(
      parseSpeechSynthesizeV1({
        schemaVersion: 1,
        language: 'fa-IR',
        modelId: 'chatterbox-fa',
        text: 'سلام',
        purpose: 'general',
      }),
    ).toBeUndefined();
    expect(
      parseSpeechSynthesizeV1({
        schemaVersion: 1,
        language: 'fa-IR',
        modelId: 'kokoro-82m',
        text: 'سلام',
      }),
    ).toBeUndefined();
    expect(
      parseSpeechSynthesizeV1({
        schemaVersion: 1,
        language: 'en-US',
        modelId: 'kokoro-82m',
        text: 'Hello',
        voiceId: 'kokoro-voice',
      }),
    ).toBeUndefined();
  });

  it('enforces the synthesis text budget in graphemes and UTF-8 bytes', () => {
    const request = (text: string) =>
      parseSpeechSynthesizeV1({
        schemaVersion: 1,
        language: 'fa-IR',
        modelId: 'chatterbox-fa',
        text,
        purpose: 'personal-noncommercial',
      });
    expect(request('ا'.repeat(1000))).toBeDefined();
    expect(request('ا'.repeat(1001))).toBeUndefined();
    expect(request(('a' + '\u0301'.repeat(7)).repeat(1000))).toBeDefined();
    expect(request(('a' + '\u0301'.repeat(8)).repeat(1000))).toBeUndefined();
  });

  it('preserves RTL text and ZWNJ in transcript words', () => {
    const word = 'می\u200cروم';
    const transcript = parseSpeechTranscript({
      language: 'fa-IR',
      words: [{ text: word, startUs: 0, endUs: 400_000, confidence: 0.9 }],
      speakers: [],
      provenance: {
        providerId: 'local',
        modelId: 'faster-whisper-large-v3-turbo',
        createdAt: '2026-11-22T10:00:00.000Z',
      },
    });
    expect(transcript?.words[0]?.text).toBe(word);
    expect(
      parseSpeechTranscript({
        ...transcript,
        provenance: { ...transcript?.provenance, providerId: 'remote' },
      }),
    ).toBeUndefined();
  });

  it('rejects unordered, overlapping, zero-length and out-of-range timings', () => {
    const word = (startUs: number, endUs: number, extra: Record<string, unknown> = {}) => ({
      text: 'word',
      startUs,
      endUs,
      ...extra,
    });
    const transcript = (words: unknown[]) => ({
      language: 'en-US',
      words,
      speakers: [],
      provenance: {
        providerId: 'local',
        modelId: 'faster-whisper-large-v3-turbo',
        createdAt: '2026-11-22T10:00:00.000Z',
      },
    });
    for (const words of [
      [word(1, 1)],
      [word(2, 1)],
      [word(-1, 2)],
      [word(0, Number.MAX_SAFE_INTEGER + 1)],
      [word(0, 3), word(2, 4)],
      [word(3, 4), word(0, 2)],
      [word(0, 2, { confidence: 1.1 })],
    ]) {
      expect(parseSpeechTranscript(transcript(words))).toBeUndefined();
    }
  });

  it('allows timing words only when timing is available', () => {
    expect(
      parseSpeechSynthesisTiming({ durationUs: 0, timingSource: 'unavailable', words: [] }),
    ).toEqual({
      durationUs: 0,
      timingSource: 'unavailable',
      words: [],
    });
    expect(
      parseSpeechSynthesisTiming({
        durationUs: 10,
        timingSource: 'unavailable',
        words: [{ text: 'x', startUs: 0, endUs: 1 }],
      }),
    ).toBeUndefined();
    expect(
      parseSpeechSynthesisTiming({
        durationUs: 10,
        timingSource: 'native',
        words: [{ text: 'x', startUs: 0, endUs: 1 }],
      }),
    ).toBeDefined();
    expect(
      parseSpeechSynthesisTiming({ durationUs: 10, timingSource: 'aligned', words: [] }),
    ).toBeDefined();
  });
});
