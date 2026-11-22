import { describe, expect, it } from 'vitest';
import type { CaptionDocumentV1, CaptionWordV1 } from '@joy-media/project-schema';
import { placeTranscriptOnTimeline } from './caption-transcript-timing.js';
import { buildSpeechCaptionCues } from './speech-caption-cues.js';

function documentOf(words: readonly CaptionWordV1[], language = 'en-US'): CaptionDocumentV1 {
  const table = Object.fromEntries(words.map((word) => [word.id, word]));
  return {
    id: 'speech',
    language,
    direction: language === 'fa-IR' ? 'rtl' : 'ltr',
    speakers: [],
    words: table,
    segments:
      words.length === 0
        ? []
        : [
            {
              id: 'raw-transcript',
              startUs: words[0]!.startUs,
              endUs: words.at(-1)!.endUs,
              wordIds: words.map(({ id }) => id),
            },
          ],
  };
}

function word(id: string, text: string, startUs: number, endUs: number): CaptionWordV1 {
  return { id, text, startUs, endUs };
}

function graphemeCount(text: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;
}

describe('buildSpeechCaptionCues', () => {
  it('wraps English into no more than two lines of 42 graphemes', () => {
    const source = documentOf([
      word('w1', 'This', 0, 300_000),
      word('w2', 'is', 300_000, 500_000),
      word('w3', 'a', 500_000, 600_000),
      word('w4', 'readable', 600_000, 1_000_000),
      word('w5', 'caption', 1_000_000, 1_400_000),
      word('w6', 'with', 1_400_000, 1_600_000),
      word('w7', 'enough', 1_600_000, 2_000_000),
      word('w8', 'words', 2_000_000, 2_300_000),
      word('w9', 'to', 2_300_000, 2_500_000),
      word('w10', 'wrap', 2_500_000, 2_800_000),
      word('w11', 'cleanly', 2_800_000, 3_200_000),
    ]);

    const result = buildSpeechCaptionCues(source);
    expect(result.segments).toHaveLength(1);
    const layout = result.segments[0]?.textOverride;
    expect(layout).toBeDefined();
    expect(layout?.split('\n')).toHaveLength(2);
    expect(layout?.split('\n').every((line) => graphemeCount(line) <= 42)).toBe(true);
    expect(result.segments[0]?.wordIds).toEqual(Object.keys(source.words));
  });

  it('repairs a Persian pair in display while keeping both source records and U+200C', () => {
    const source = documentOf(
      [word('fa1', 'می', 10, 300_010), word('fa2', 'باشد', 300_010, 700_010)],
      'fa-IR',
    );

    const result = buildSpeechCaptionCues(source);
    expect(result.segments[0]?.textOverride).toBe('می\u200cباشد');
    expect(result.segments[0]?.wordIds).toEqual(['fa1', 'fa2']);
    expect(result.words).toBe(source.words);
    expect(result.words.fa1?.text).toBe('می');
    expect(result.words.fa1?.startUs).toBe(10);
    expect(result.words.fa2?.endUs).toBe(700_010);
  });

  it('uses explicit newline layout and stable ids, without inserting extra spaces around half-space', () => {
    const source = documentOf(
      [word('fa1', 'می', 0, 400_000), word('fa2', 'باشد', 400_000, 900_000)],
      'fa-IR',
    );
    const first = buildSpeechCaptionCues(source).segments[0]!;
    const second = buildSpeechCaptionCues(source).segments[0]!;
    expect(first.id).toBe('speech-cue:fa1:fa2');
    expect(first.id).toBe(second.id);
    expect(first.textOverride).not.toContain(' \u200c');
    expect(first.textOverride).not.toContain('\u200c ');
  });

  it('keeps trimmed and rate-mapped intervals from transcript placement', () => {
    const source = documentOf([
      word('before', 'before', 0, 400_000),
      word('kept1', 'Hello', 500_000, 1_000_000),
      word('kept2', 'there.', 1_000_000, 1_500_000),
      word('after', 'after', 2_600_000, 3_000_000),
    ]);
    const placed = placeTranscriptOnTimeline(source, {
      offsetUs: 2_000_000,
      sourceInUs: 500_000,
      durationUs: 1_000_000,
      playbackRate: 2,
    });
    const result = buildSpeechCaptionCues(placed);
    expect(Object.keys(result.words)).toEqual(['kept1', 'kept2']);
    expect(result.segments[0]).toMatchObject({ startUs: 2_000_000, endUs: 2_500_000 });
  });

  it('breaks at long pauses and sentence punctuation, with adjacent cue boundaries', () => {
    const source = documentOf([
      word('a', 'Hello.', 0, 300_000),
      word('b', 'Next', 300_000, 500_000),
      word('c', 'after', 1_100_000, 1_300_000),
      word('d', 'pause.', 1_300_000, 1_600_000),
    ]);

    const result = buildSpeechCaptionCues(source);
    expect(result.segments.map(({ wordIds }) => wordIds)).toEqual([['a'], ['b'], ['c', 'd']]);
    expect(result.segments[0]?.endUs).toBe(result.segments[1]?.startUs);
    expect(result.segments[1]?.endUs).toBeLessThanOrEqual(result.segments[2]?.startUs ?? 0);
  });

  it('preserves very short intervals and wraps a long unbroken token at grapheme boundaries', () => {
    const token = 'x'.repeat(50);
    const source = documentOf([word('short', token, 7, 8)]);

    const result = buildSpeechCaptionCues(source);
    expect(result.segments[0]).toMatchObject({ startUs: 7, endUs: 8, wordIds: ['short'] });
    expect(result.segments[0]?.textOverride).toBe(`${'x'.repeat(42)}\n${'x'.repeat(8)}`);
    expect(result.words.short?.text).toBe(token);
  });

  it('returns an empty generated document without inventing cues', () => {
    const source = documentOf([]);
    expect(buildSpeechCaptionCues(source)).toEqual(source);
  });
});
