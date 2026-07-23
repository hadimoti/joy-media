import { describe, expect, it } from 'vitest';
import { ProviderUnavailableError } from '@joy-media/provider-sdk';
import { BrowserControlPlaneClient } from './control-plane-client.js';
import { transcribeReferenceCaption } from './local-transcription.js';

describe('transcribeReferenceCaption (live + fixture fallback)', () => {
  it('uses the live API result when transcription succeeds', async () => {
    const client = {
      async transcribeSpeech() {
        return {
          language: 'fa-IR',
          words: [
            {
              text: 'زنده',
              startUs: 0,
              endUs: 500_000,
              confidence: 0.99,
              speakerId: 'speaker-1',
            },
          ],
          speakers: [{ id: 'speaker-1', name: 'Speaker 1' }],
          provenance: {
            providerId: 'joy.faster-whisper',
            modelId: 'faster-whisper-tiny',
            createdAt: '2026-07-23T12:00:00.000Z',
          },
        };
      },
    } as unknown as BrowserControlPlaneClient;

    const document = await transcribeReferenceCaption('caption-fa', 'fa-IR', client);
    expect(document.provenance?.modelId).toBe('faster-whisper-tiny');
    expect(Object.values(document.words).map((word) => word.text)).toEqual(['زنده']);
  });

  it('falls back to the Persian fixture when the live API fails', async () => {
    const client = {
      async transcribeSpeech() {
        throw new Error('AUTH_REQUIRED');
      },
    } as unknown as BrowserControlPlaneClient;

    const document = await transcribeReferenceCaption('caption-fa', 'fa-IR', client);
    expect(document.language).toBe('fa-IR');
    expect(document.segments).toHaveLength(1);
    expect(Object.values(document.words).map((word) => word.text)).toEqual([
      'سلام',
      'به',
      'استودیوی',
      'جوی',
      'خوش',
      'آمدید',
    ]);
    expect(document.provenance).toMatchObject({
      providerId: 'joy.local-whisper',
      modelId: 'fixture-whisper-fa-v1',
    });
  });

  it('falls back to the English fixture when the live API fails', async () => {
    const client = {
      async transcribeSpeech() {
        throw new Error('offline');
      },
    } as unknown as BrowserControlPlaneClient;

    const document = await transcribeReferenceCaption('caption-en', 'en-US', client);
    expect(document.language).toBe('en-US');
    expect(Object.values(document.words).map((word) => word.text)).toEqual([
      'Welcome',
      'to',
      'the',
      'JOY',
      'Media',
      'studio',
    ]);
    expect(document.provenance).toMatchObject({
      modelId: 'fixture-whisper-en-v1',
    });
  });

  it('keeps ProviderUnavailableError typed for callers', () => {
    expect(ProviderUnavailableError.name).toBe('ProviderUnavailableError');
  });
});
