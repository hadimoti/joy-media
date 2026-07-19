import type { CaptionDocumentV1 } from '@joy-media/project-schema';
import type { CaptionCue } from './index.js';

/** Versioned P03.4 stress documents: Persian, Latin, emoji, and long wrapping text. */
export const RTL_STRESS_DOCUMENTS: readonly CaptionDocumentV1[] = [
  {
    id: 'rtl-mixed-emoji',
    language: 'fa',
    direction: 'auto',
    styleRef: 'joy-karaoke-pop',
    speakers: [],
    words: {
      w1: { id: 'w1', text: 'سلام', startUs: 0, endUs: 400_000 },
      w2: { id: 'w2', text: 'JOY', startUs: 400_000, endUs: 800_000 },
      w3: { id: 'w3', text: '👋', startUs: 800_000, endUs: 1_200_000 },
      w4: { id: 'w4', text: 'دنیا', startUs: 1_200_000, endUs: 1_600_000 },
    },
    segments: [{ id: 'mixed', startUs: 0, endUs: 1_600_000, wordIds: ['w1', 'w2', 'w3', 'w4'] }],
  },
  {
    id: 'rtl-long-text',
    language: 'fa',
    direction: 'rtl',
    styleRef: 'joy-rtl-classic',
    speakers: [],
    words: Object.fromEntries(
      'این یک متن بسیار طولانی برای آزمایش محدوده امن زیرنویس فارسی با واژه های انگلیسی JOY و ایموجی ✨ است'
        .split(' ')
        .map((text, index) => [
          `w${index}`,
          { id: `w${index}`, text, startUs: index * 100_000, endUs: (index + 1) * 100_000 },
        ]),
    ),
    segments: [
      {
        id: 'long',
        startUs: 0,
        endUs: 2_000_000,
        wordIds: Array.from({ length: 20 }, (_, index) => `w${index}`),
      },
    ],
  },
];

export function rtlStressCues(): readonly CaptionCue[] {
  return RTL_STRESS_DOCUMENTS.map((document) => ({
    clipId: `clip-${document.id}`,
    documentId: document.id,
    document,
    segment: document.segments[0]!,
    documentTimeUs: document.id === 'rtl-mixed-emoji' ? 100_000 : 1_000_000,
  }));
}
