import { describe, expect, it } from 'vitest';
import {
  captionDocumentFromTranscription,
  createLocalWhisperProvider,
  ProviderUnavailableError,
} from './index.js';
describe('local Whisper provider', () => {
  it('normalizes aligned words and provenance', async () => {
    const provider = createLocalWhisperProvider(async () => ({
      language: 'fa-IR',
      words: [{ text: 'سلام', startUs: 0, endUs: 500000, confidence: 0.9, speakerId: 's1' }],
      speakers: [{ id: 's1', name: 'Speaker 1' }],
      provenance: {
        providerId: 'joy.local-whisper',
        modelId: 'whisper-local',
        createdAt: '2026-07-19T00:00:00.000Z',
      },
    }));
    const document = captionDocumentFromTranscription(
      'doc',
      await provider.invoke('speech.transcribe', { assetId: 'a' }),
    );
    expect(document.words['word-0']?.text).toBe('سلام');
    expect(document.segments[0]?.speakerId).toBeUndefined();
    expect(document.provenance?.modelId).toBe('whisper-local');
  });
  it('reports unavailable local models without corrupting manual state', async () => {
    const provider = createLocalWhisperProvider(async () => {
      throw new Error('missing model');
    });
    await expect(provider.invoke('speech.transcribe', { assetId: 'a' })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });
});
