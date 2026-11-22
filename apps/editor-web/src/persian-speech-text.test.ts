import { describe, expect, it } from 'vitest';
import type { CaptionWordV1 } from '@joy-media/project-schema';
import { PERSIAN_HALF_SPACE, repairPersianSpeechTokens } from './persian-speech-text.js';

const HALF_SPACE = PERSIAN_HALF_SPACE;
/** Arabic yeh, not Persian yeh: "مي" must stay untouched. */
const ARABIC_MEI = '\u0645\u064A';

function word(
  id: string,
  text: string,
  startUs: number,
  endUs: number,
  extra: Partial<CaptionWordV1> = {},
): CaptionWordV1 {
  return { id, text, startUs, endUs, ...extra };
}

describe('repairPersianSpeechTokens', () => {
  it('joins a whitelisted pair that sits inside one token', () => {
    const repaired = repairPersianSpeechTokens([
      word('w1', 'می باشد', 1_000, 2_000, { confidence: 0.9, speakerId: 's1' }),
    ]);

    expect(repaired).toHaveLength(1);
    expect(repaired[0]?.text).toBe(`می${HALF_SPACE}باشد`);
    expect(repaired[0]?.id).toBe('w1');
    expect(repaired[0]?.startUs).toBe(1_000);
    expect(repaired[0]?.endUs).toBe(2_000);
    expect(repaired[0]?.confidence).toBe(0.9);
    expect(repaired[0]?.speakerId).toBe('s1');
  });

  it('joins the pair inside a longer token without touching the rest', () => {
    const repaired = repairPersianSpeechTokens([word('w1', 'که می باشد امروز', 0, 900)]);

    expect(repaired[0]?.text).toBe(`که می${HALF_SPACE}باشد امروز`);
  });

  it('annotates the first of two source words and keeps both ids and intervals', () => {
    const repaired = repairPersianSpeechTokens([
      word('w1', 'می', 0, 500),
      word('w2', 'باشد', 500, 1_200),
    ]);

    expect(repaired.map((entry) => entry.id)).toEqual(['w1', 'w2']);
    expect(repaired[0]?.text).toBe(`می${HALF_SPACE}`);
    expect(repaired[1]?.text).toBe('باشد');
    expect(repaired[0]?.startUs).toBe(0);
    expect(repaired[0]?.endUs).toBe(500);
    expect(repaired[1]?.startUs).toBe(500);
    expect(repaired[1]?.endUs).toBe(1_200);
    // The display formatter joins a word that ends with a half-space without
    // adding a space, so the pair reads as one word.
    expect(repaired.map((entry) => entry.text).join('')).toBe(`می${HALF_SPACE}باشد`);
  });

  it('handles the negated pair in both the one-token and two-token forms', () => {
    const single = repairPersianSpeechTokens([word('w1', 'نمی باشد', 0, 700)]);
    expect(single[0]?.text).toBe(`نمی${HALF_SPACE}باشد`);

    const pair = repairPersianSpeechTokens([
      word('w1', 'نمی', 0, 400),
      word('w2', 'باشد', 400, 900),
    ]);
    expect(pair[0]?.text).toBe(`نمی${HALF_SPACE}`);
    expect(pair[1]?.text).toBe('باشد');
  });

  it('keeps the order and the untouched neighbours', () => {
    const repaired = repairPersianSpeechTokens([
      word('w1', 'سلام', 0, 300),
      word('w2', 'می', 300, 600),
      word('w3', 'باشد', 600, 1_100),
      word('w4', 'عالی', 1_100, 1_500),
    ]);

    expect(repaired.map((entry) => entry.id)).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(repaired.map((entry) => entry.text)).toEqual([
      'سلام',
      `می${HALF_SPACE}`,
      'باشد',
      'عالی',
    ]);
  });

  it('leaves an existing half-space alone', () => {
    const already = `می${HALF_SPACE}باشد`;
    const repaired = repairPersianSpeechTokens([
      word('w1', already, 0, 800),
      word('w2', 'باشد', 800, 1_400),
    ]);

    expect(repaired[0]?.text).toBe(already);
    expect(repaired[0]?.text).not.toContain(`${HALF_SPACE}${HALF_SPACE}`);
    expect(repaired[1]?.text).toBe('باشد');
  });

  it('does not join across punctuation', () => {
    const repaired = repairPersianSpeechTokens([
      word('w1', 'می،', 0, 400),
      word('w2', 'باشد', 400, 900),
    ]);
    expect(repaired[0]?.text).toBe('می،');
    expect(repaired[1]?.text).toBe('باشد');

    const punctuated = repairPersianSpeechTokens([
      word('w1', 'می باشد،', 0, 900),
      word('w2', 'می', 900, 1_200),
      word('w3', 'باشد.', 1_200, 1_800),
    ]);
    expect(punctuated[0]?.text).toBe('می باشد،');
    expect(punctuated[2]?.text).toBe('باشد.');
  });

  it('leaves digits alone', () => {
    const repaired = repairPersianSpeechTokens([
      word('w1', 'در سال ۱۴۰۳', 0, 900),
      word('w2', 'می ۱۲۳', 900, 1_400),
      word('w3', '۱۲۰ می باشد', 1_400, 2_000),
    ]);

    expect(repaired[0]?.text).toBe('در سال ۱۴۰۳');
    expect(repaired[1]?.text).toBe('می ۱۲۳');
    expect(repaired[2]?.text).toBe(`۱۲۰ می${HALF_SPACE}باشد`);
    expect(repaired[2]?.text).toContain('۱۲۰');
  });

  it('leaves Arabic and English words alone', () => {
    const repaired = repairPersianSpeechTokens([
      word('w1', `${ARABIC_MEI} باشد`, 0, 600),
      word('w2', ARABIC_MEI, 600, 900),
      word('w3', 'باشد', 900, 1_300),
      word('w4', 'may be', 1_300, 1_700),
    ]);

    expect(repaired[0]?.text).toBe(`${ARABIC_MEI} باشد`);
    expect(repaired[1]?.text).toBe(ARABIC_MEI);
    expect(repaired[2]?.text).toBe('باشد');
    expect(repaired[3]?.text).toBe('may be');
  });

  it('does not guess other morphemes', () => {
    const repaired = repairPersianSpeechTokens([
      word('w1', 'که', 0, 300),
      word('w2', 'است', 300, 700),
      word('w3', 'نمی', 700, 1_000),
      word('w4', 'شود', 1_000, 1_400),
    ]);

    expect(repaired.map((entry) => entry.text)).toEqual(['که', 'است', 'نمی', 'شود']);
  });

  it('never modifies the source words', () => {
    const source = [word('w1', 'می', 0, 400), word('w2', 'باشد', 400, 900)];
    const repaired = repairPersianSpeechTokens(source);

    expect(source[0]?.text).toBe('می');
    expect(source[1]?.text).toBe('باشد');
    expect(repaired[0]).not.toBe(source[0]);
    expect(repaired[1]).not.toBe(source[1]);
  });

  it('returns an empty list when there are no words', () => {
    expect(repairPersianSpeechTokens([])).toEqual([]);
  });
});
