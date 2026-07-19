import { describe, expect, it } from 'vitest';
import { transcribeReferenceCaption } from './local-transcription.js';

describe('transcribeReferenceCaption', () => {
  it('normalizes the Persian reference through the local provider seam', async () => {
    const document = await transcribeReferenceCaption('caption-fa', 'fa-IR');

    expect(document.language).toBe('fa-IR');
    expect(document.segments).toHaveLength(1);
    expect(Object.values(document.words).map((word) => word.text)).toEqual(['سلام', 'JOY', 'دنیا']);
    expect(document.provenance).toMatchObject({
      providerId: 'joy.local-whisper',
      modelId: 'local-whisper-reference',
    });
  });

  it('normalizes the English reference through the same provider', async () => {
    const document = await transcribeReferenceCaption('caption-en', 'en-US');

    expect(document.language).toBe('en-US');
    expect(Object.values(document.words).map((word) => word.text)).toEqual([
      'Hello',
      'JOY',
      'world',
    ]);
  });
});
