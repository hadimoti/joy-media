import { describe, expect, it } from 'vitest';
import { ProviderUnavailableError } from '@joy-media/provider-sdk';
import { transcribeReferenceCaption } from './local-transcription.js';

describe('transcribeReferenceCaption (WP-20 fixtures)', () => {
  it('loads the Persian fixture through the local provider seam', async () => {
    const document = await transcribeReferenceCaption('caption-fa', 'fa-IR');

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
    expect(document.provenance?.modelId).not.toBe('pending');
  });

  it('loads the English fixture through the same provider', async () => {
    const document = await transcribeReferenceCaption('caption-en', 'en-US');

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
