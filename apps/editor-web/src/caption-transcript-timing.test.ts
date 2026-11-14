import { describe, expect, it } from 'vitest';
import type { CaptionDocumentV1 } from '@joy-media/project-schema';
import { placeTranscriptOnTimeline } from './caption-transcript-timing.js';

const document: CaptionDocumentV1 = {
  id: 'captions-1',
  language: 'en-US',
  direction: 'auto',
  speakers: [],
  words: {
    a: { id: 'a', text: 'Hello', startUs: 300_000, endUs: 600_000 },
    b: { id: 'b', text: 'there', startUs: 700_000, endUs: 1_000_000 },
    c: { id: 'c', text: 'friend', startUs: 5_000_000, endUs: 5_400_000 },
  },
  segments: [
    { id: 's1', startUs: 300_000, endUs: 1_000_000, wordIds: ['a', 'b'] },
    { id: 's2', startUs: 5_000_000, endUs: 5_400_000, wordIds: ['c'] },
  ],
};

describe('placeTranscriptOnTimeline', () => {
  it('moves the words to where the clip starts on the timeline', () => {
    const placed = placeTranscriptOnTimeline(document, {
      offsetUs: 40_000_000,
      sourceInUs: 0,
      durationUs: 8_000_000,
    });
    expect(placed.words['a']).toMatchObject({ startUs: 40_300_000, endUs: 40_600_000 });
    expect(placed.segments[0]).toMatchObject({ startUs: 40_300_000, endUs: 41_000_000 });
    expect(placed.segments[1]).toMatchObject({ startUs: 45_000_000 });
  });

  it('drops speech that the trim cut off and keeps the rest', () => {
    const placed = placeTranscriptOnTimeline(document, {
      offsetUs: 10_000_000,
      sourceInUs: 4_000_000,
      durationUs: 2_000_000,
    });
    expect(Object.keys(placed.words)).toEqual(['c']);
    expect(placed.segments).toHaveLength(1);
    expect(placed.words['c']).toMatchObject({ startUs: 11_000_000 });
  });

  it('squeezes the words of a clip played at double speed', () => {
    const placed = placeTranscriptOnTimeline(document, {
      offsetUs: 0,
      sourceInUs: 0,
      durationUs: 4_000_000,
      playbackRate: 2,
    });
    expect(placed.words['a']).toMatchObject({ startUs: 150_000, endUs: 300_000 });
    // Four seconds at double speed play eight seconds of the file, so the last word is kept too.
    expect(placed.words['c']).toMatchObject({ startUs: 2_500_000 });
  });
});
