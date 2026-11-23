import { describe, expect, it } from 'vitest';
import type { CaptionDocumentV1, CaptionSegmentV1 } from '@joy-media/project-schema';
import { mergeCaptionCueWithPrevious, splitCaptionCue } from './caption-cue-edit.js';

function documentOf(
  words: CaptionDocumentV1['words'],
  segments: readonly CaptionSegmentV1[],
  overrides: Partial<CaptionDocumentV1> = {},
): CaptionDocumentV1 {
  return {
    id: 'doc',
    language: 'en',
    direction: 'ltr',
    speakers: [],
    words,
    segments,
    styleRef: 'bold',
    provenance: { providerId: 'test-provider', modelId: 'test-model', createdAt: 'today' },
    ...overrides,
  };
}

const word = (id: string, text: string, startUs: number, endUs: number) => ({
  id,
  text,
  startUs,
  endUs,
  confidence: 0.9,
});

const cue = (
  id: string,
  startUs: number,
  endUs: number,
  wordIds: readonly string[],
  textOverride?: string,
): CaptionSegmentV1 => ({
  id,
  startUs,
  endUs,
  wordIds,
  speakerId: 'speaker',
  ...(textOverride === undefined ? {} : { textOverride }),
});

describe('splitCaptionCue', () => {
  it('splits on an exact word boundary and keeps the cue metadata and source table', () => {
    const document = documentOf(
      { a: word('a', 'hello', 0, 400), b: word('b', 'world', 600, 1000) },
      [cue('first', 0, 1000, ['a', 'b'], 'hello world')],
    );

    const edit = splitCaptionCue(document, 'first', 'hello world', 6, 'second');

    expect(edit?.focusCueId).toBe('second');
    expect(edit?.caret).toBe(0);
    expect(edit?.document.segments).toEqual([
      { ...cue('first', 0, 500, ['a'], 'hello '), endUs: 500 },
      { ...cue('second', 500, 1000, ['b'], 'world'), id: 'second', startUs: 500 },
    ]);
    expect(edit?.document.words).toBe(document.words);
    expect(edit?.document.provenance).toBe(document.provenance);
  });

  it('interpolates the cut inside a timed word and assigns its id once by overlap', () => {
    const document = documentOf({ a: word('a', 'hello', 0, 1000) }, [cue('first', 0, 1000, ['a'])]);
    const edit = splitCaptionCue(document, 'first', 'hello', 2, 'second');

    expect(
      edit?.document.segments.map(({ startUs, endUs, wordIds }) => ({ startUs, endUs, wordIds })),
    ).toEqual([
      { startUs: 0, endUs: 400, wordIds: [] },
      { startUs: 400, endUs: 1000, wordIds: ['a'] },
    ]);
  });

  it('uses grapheme proportions for edited text that cannot map to source words', () => {
    const document = documentOf(
      { a: word('a', 'hello', 0, 400), b: word('b', 'world', 600, 1000) },
      [cue('first', 0, 1000, ['a', 'b'])],
    );
    const edit = splitCaptionCue(document, 'first', 'Good morning', 5, 'second');

    expect(edit?.document.segments.map(({ startUs, wordIds }) => ({ startUs, wordIds }))).toEqual([
      { startUs: 0, wordIds: ['a'] },
      { startUs: 417, wordIds: ['b'] },
    ]);
  });

  it('preserves visible multiline text and rejects edge, whitespace-only, empty, and one-microsecond splits', () => {
    const document = documentOf({}, [cue('first', 0, 1000, [])]);
    expect(
      splitCaptionCue(document, 'first', 'one\ntwo', 4, 'second')?.document.segments.map(
        (s) => s.textOverride,
      ),
    ).toEqual(['one\n', 'two']);
    expect(splitCaptionCue(document, 'first', 'one\ntwo', 0, 'second')).toBeUndefined();
    expect(splitCaptionCue(document, 'first', 'one\ntwo', 8, 'second')).toBeUndefined();
    expect(splitCaptionCue(document, 'first', '   ', 1, 'second')).toBeUndefined();
    expect(splitCaptionCue(document, 'first', '', 0, 'second')).toBeUndefined();
    expect(
      splitCaptionCue(documentOf({}, [cue('first', 0, 1, [])]), 'first', 'a b', 1, 'second'),
    ).toBeUndefined();
  });

  it('keeps Persian digits, ZWNJ, bidi marks, and UTF-16 offsets intact', () => {
    const text = '\u200fسلام‌۱۲۳';
    const document = documentOf({ a: word('a', text, 0, 1000) }, [cue('first', 0, 1000, ['a'])], {
      language: 'fa-IR',
      direction: 'rtl',
    });
    const prefix = '\u200fسلام‌';
    const edit = splitCaptionCue(document, 'first', text, prefix.length, 'second');

    expect(edit?.document.segments.map((s) => s.textOverride)).toEqual([prefix, '۱۲۳']);
    expect(edit?.document.words).toBe(document.words);
  });

  it('snaps an offset inside a surrogate and grapheme sequence to the nearest grapheme boundary', () => {
    const text = 'A👨‍👩‍👧‍👦B';
    const document = documentOf({}, [cue('first', 0, 300, [], text)]);
    const edit = splitCaptionCue(document, 'first', text, 2, 'second');

    expect(edit?.document.segments.map((s) => s.textOverride)).toEqual(['A', '👨‍👩‍👧‍👦B']);
  });

  it('preserves missing word ids and returns no-op for a missing cue', () => {
    const document = documentOf({ a: word('a', 'one', 0, 400), b: word('b', 'two', 600, 1000) }, [
      cue('first', 0, 1000, ['a', 'missing', 'b', 'a']),
    ]);
    const edit = splitCaptionCue(document, 'first', 'changed words', 7, 'second');

    expect(edit?.document.segments.flatMap((s) => s.wordIds).sort()).toEqual(['a', 'b', 'missing']);
    expect(splitCaptionCue(document, 'absent', 'changed words', 7, 'second')).toBeUndefined();
  });
});

describe('mergeCaptionCueWithPrevious', () => {
  it('merges with the nearest chronological predecessor, trims the seam, and returns its splice caret', () => {
    const earlier = cue('earlier', 0, 100, ['a'], 'earlier');
    const nearest = cue('nearest', 300, 400, ['b', 'a'], 'Hello  ');
    const current = cue('current', 500, 800, ['a', 'c'], '  world');
    const document = documentOf(
      { a: word('a', 'a', 0, 100), b: word('b', 'b', 300, 400), c: word('c', 'c', 500, 800) },
      [current, earlier, cue('later', 900, 1000, ['c']), nearest],
    );
    const edit = mergeCaptionCueWithPrevious(document, 'current', '  world');

    expect(edit?.focusCueId).toBe('nearest');
    expect(edit?.caret).toBe(6);
    expect(edit?.document.segments).toEqual([
      { ...earlier },
      cue('later', 900, 1000, ['c']),
      { ...nearest, endUs: 800, wordIds: ['b', 'a', 'c'], textOverride: 'Hello world' },
    ]);
  });

  it('uses the source display text by default and retains document and predecessor metadata', () => {
    const previous = cue('previous', 0, 400, ['a']);
    const current = cue('current', 500, 800, ['b']);
    const document = documentOf(
      { a: word('a', 'hello', 0, 400), b: word('b', 'there', 500, 800) },
      [previous, current],
    );
    const edit = mergeCaptionCueWithPrevious(document, 'current', 'there');

    expect(edit?.document.segments).toEqual([
      { ...previous, endUs: 800, wordIds: ['a', 'b'], textOverride: 'hello there' },
    ]);
    expect(edit?.document.styleRef).toBe('bold');
    expect(edit?.document.provenance).toBe(document.provenance);
  });

  it('returns no-op for missing, first, and empty cue edits', () => {
    const document = documentOf({}, [cue('first', 0, 100, [], 'first')]);
    expect(mergeCaptionCueWithPrevious(document, 'first', 'first')).toBeUndefined();
    expect(mergeCaptionCueWithPrevious(document, 'missing', 'text')).toBeUndefined();
    expect(mergeCaptionCueWithPrevious(document, 'first', '')).toBeUndefined();
  });
});
