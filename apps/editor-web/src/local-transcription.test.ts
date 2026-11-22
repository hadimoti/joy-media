import { describe, expect, it, vi } from 'vitest';
import { ProviderUnavailableError } from '@joy-media/provider-sdk';
import type { BrowserControlPlaneClient } from './control-plane-client.js';
import { transcribeReferenceCaption } from './local-transcription.js';
import { DesktopSpeechError } from './local-media-client.js';

describe('transcribeReferenceCaption (live + fixture fallback)', () => {
  it('uses the live API result when transcription succeeds', async () => {
    const client = {
      async transcribeSpeech() {
        return {
          language: 'fa-IR',
          words: [
            {
              text: 'Live',
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
    expect(Object.values(document.words).map((word) => word.text)).toEqual(['Live']);
  });

  it('falls back to the fa-IR fixture when the live API fails', async () => {
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

  it('never substitutes fixture words when selected media transcription fails', async () => {
    const media = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    const client = {
      async transcribeSpeech() {
        throw new Error('local Whisper unavailable');
      },
    } as unknown as BrowserControlPlaneClient;

    await expect(
      transcribeReferenceCaption('caption-en', 'en-US', client, { media, mediaType: 'audio/wav' }),
    ).rejects.toThrow(
      'Live transcription could not process the selected media. local Whisper unavailable',
    );
  });

  it('surfaces the local Whisper configuration error for selected media', async () => {
    const media = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    const client = {
      async transcribeSpeech() {
        throw new Error('Local Whisper is not configured.');
      },
    } as unknown as BrowserControlPlaneClient;

    await expect(
      transcribeReferenceCaption('caption-en', 'en-US', client, { media, mediaType: 'audio/wav' }),
    ).rejects.toThrow('Local Whisper is not configured.');
  });

  it('keeps ProviderUnavailableError typed for callers', () => {
    expect(ProviderUnavailableError.name).toBe('ProviderUnavailableError');
  });

  it('uses first-party speech without loading media', async () => {
    const loadMedia = vi.fn(async () => ({ media: new Blob(['audio']), mediaType: 'audio/wav' }));
    const client = {
      async runLocalTranscription() {
        return {
          language: 'fa-IR',
          words: [{ text: 'Worker', startUs: 0, endUs: 400_000 }],
          speakers: [],
          provenance: {
            providerId: 'local',
            modelId: 'faster-whisper-large-v3-turbo',
            createdAt: '2026-11-22T00:00:00.000Z',
          },
        };
      },
    } as unknown as BrowserControlPlaneClient;

    const document = await transcribeReferenceCaption('caption-fa', 'fa-IR', client, {
      workerRequest: {
        projectId: 'project-1',
        assetId: 'asset-1',
        request: { schemaVersion: 1, language: 'fa-IR', modelId: 'faster-whisper-large-v3-turbo' },
      },
      loadMedia,
    });

    expect(Object.values(document.words).map((word) => word.text)).toEqual(['Worker']);
    expect(loadMedia).not.toHaveBeenCalled();
  });

  it('loads media once only when first-party setup is missing', async () => {
    const loadMedia = vi.fn(async () => ({ media: new Blob(['audio']), mediaType: 'audio/wav' }));
    const client = {
      async runLocalTranscription() {
        throw new DesktopSpeechError('SETUP_REQUIRED', 'Worker speech is not set up');
      },
      async transcribeSpeech() {
        return {
          language: 'fa-IR',
          words: [{ text: 'Loopback', startUs: 0, endUs: 400_000 }],
          speakers: [],
          provenance: {
            providerId: 'local',
            modelId: 'faster-whisper-large-v3-turbo',
            createdAt: '2026-11-22T00:00:00.000Z',
          },
        };
      },
    } as unknown as BrowserControlPlaneClient;

    const document = await transcribeReferenceCaption('caption-fa', 'fa-IR', client, {
      workerRequest: {
        projectId: 'project-1',
        assetId: 'asset-1',
        request: { schemaVersion: 1, language: 'fa-IR', modelId: 'faster-whisper-large-v3-turbo' },
      },
      loadMedia,
    });

    expect(Object.values(document.words).map((word) => word.text)).toEqual(['Loopback']);
    expect(loadMedia).toHaveBeenCalledTimes(1);
  });

  it('does not use loopback fallback for a first-party runtime failure', async () => {
    const loadMedia = vi.fn(async () => ({ media: new Blob(['audio']) }));
    const failure = new Error('runtime failure');
    const client = {
      async runLocalTranscription() {
        throw failure;
      },
    } as unknown as BrowserControlPlaneClient;

    await expect(
      transcribeReferenceCaption('caption-fa', 'fa-IR', client, {
        workerRequest: {
          projectId: 'project-1',
          assetId: 'asset-1',
          request: {
            schemaVersion: 1,
            language: 'fa-IR',
            modelId: 'faster-whisper-large-v3-turbo',
          },
        },
        loadMedia,
      }),
    ).rejects.toBe(failure);
    expect(loadMedia).not.toHaveBeenCalled();
  });
});
