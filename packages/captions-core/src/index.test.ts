import { describe, expect, it } from 'vitest';
import { activeCaptionText, captionTextNode } from './index.js';
const document = {
  id: 'captions',
  locale: 'fa-IR',
  speakers: [{ id: 's', name: 'Narrator' }],
  segments: [
    {
      id: 'segment',
      speakerId: 's',
      startUs: 0,
      endUs: 2_000_000,
      words: [
        { id: 'w1', text: 'سلام', startUs: 0, endUs: 1_000_000 },
        { id: 'w2', text: 'JOY', startUs: 1_000_000, endUs: 2_000_000 },
      ],
    },
  ],
} as const;
describe('caption core', () => {
  it('keeps words/segments/speakers structured and maps active text to IR', () => {
    expect(activeCaptionText(document, 500_000)).toBe('سلام');
    expect(captionTextNode(document, 1_500_000, 1920, 1080)).toMatchObject({
      kind: 'text',
      text: 'JOY',
    });
  });
});
