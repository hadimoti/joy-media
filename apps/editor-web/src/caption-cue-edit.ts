import type { CaptionDocumentV1, CaptionSegmentV1, CaptionWordV1 } from '@joy-media/project-schema';
import { segmentDisplayText } from '@joy-media/captions-core';

export interface CaptionCueEdit {
  readonly document: CaptionDocumentV1;
  readonly focusCueId: string;
  /** Logical UTF-16 offset for the focused cue's text editor. */
  readonly caret: number;
}

interface Grapheme {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const INVISIBLE_PRESENTATION = /[\s\u200c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;

function graphemes(text: string): Grapheme[] {
  if (typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
      ({ segment, index }) => ({ text: segment, start: index, end: index + segment.length }),
    );
  }

  const result: Grapheme[] = [];
  let index = 0;
  for (const character of text) {
    const end = index + character.length;
    const previous = result.at(-1);
    if (
      previous !== undefined &&
      (/\p{Mark}/u.test(character) ||
        /[\p{Variation_Selector}\p{Emoji_Modifier}]/u.test(character) ||
        previous.text.endsWith('\u200d') ||
        character === '\u200d')
    ) {
      result[result.length - 1] = { ...previous, text: previous.text + character, end };
    } else result.push({ text: character, start: index, end });
    index = end;
  }
  return result;
}

function snapOffset(text: string, requested: number): number {
  const offset = Math.max(
    0,
    Math.min(text.length, Number.isFinite(requested) ? Math.trunc(requested) : 0),
  );
  let before = 0;
  for (const grapheme of graphemes(text)) {
    if (offset === grapheme.start || offset === grapheme.end) return offset;
    if (offset < grapheme.end) {
      return offset - grapheme.start <= grapheme.end - offset ? grapheme.start : grapheme.end;
    }
    before = grapheme.end;
  }
  return before;
}

function hasVisibleText(text: string): boolean {
  return text.replace(INVISIBLE_PRESENTATION, '').length > 0;
}

function normalizedGraphemes(text: string): string[] {
  return graphemes(text)
    .map(({ text: value }) => value.replace(INVISIBLE_PRESENTATION, ''))
    .filter((value) => value.length > 0);
}

function wordEntries(document: CaptionDocumentV1, segment: CaptionSegmentV1) {
  return [...new Set(segment.wordIds)].map((id, index) => ({
    id,
    index,
    word: document.words[id],
  }));
}

function mappedWordCut(
  document: CaptionDocumentV1,
  segment: CaptionSegmentV1,
  text: string,
  caret: number,
): number | undefined {
  const entries = wordEntries(document, segment).filter(
    (entry): entry is typeof entry & { word: CaptionWordV1 } => entry.word !== undefined,
  );
  if (entries.length === 0) return undefined;
  const source = entries.flatMap(({ word }) => normalizedGraphemes(word.text));
  const shown = normalizedGraphemes(text);
  if (source.length !== shown.length || source.some((value, index) => value !== shown[index]))
    return undefined;

  const prefixCount = graphemes(text)
    .filter(({ end }) => end <= caret)
    .flatMap(({ text: value }) => normalizedGraphemes(value)).length;
  let consumed = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const { word } = entries[index]!;
    const length = normalizedGraphemes(word.text).length;
    const end = consumed + length;
    if (prefixCount > consumed && prefixCount < end) {
      const fraction = (prefixCount - consumed) / length;
      return word.startUs + (word.endUs - word.startUs) * fraction;
    }
    if (prefixCount === end) {
      const next = entries[index + 1]?.word;
      return next === undefined ? word.endUs : (word.endUs + next.startUs) / 2;
    }
    if (prefixCount === consumed) {
      const previous = entries[index - 1]?.word;
      return previous === undefined ? word.startUs : (previous.endUs + word.startUs) / 2;
    }
    consumed = end;
  }
  return entries.at(-1)!.word.endUs;
}

function splitWordIds(
  document: CaptionDocumentV1,
  segment: CaptionSegmentV1,
  cutUs: number,
  fallbackRatio: number,
): { before: string[]; after: string[] } {
  const before: string[] = [];
  const after: string[] = [];
  const entries = wordEntries(document, segment);
  for (const entry of entries) {
    const { id, word } = entry;
    let goesBefore: boolean;
    if (word === undefined)
      goesBefore = (entry.index + 0.5) / Math.max(1, entries.length) < fallbackRatio;
    else {
      const left = Math.max(
        0,
        Math.min(cutUs, word.endUs) - Math.max(segment.startUs, word.startUs),
      );
      const right = Math.max(
        0,
        Math.min(segment.endUs, word.endUs) - Math.max(cutUs, word.startUs),
      );
      goesBefore = left === right ? (word.startUs + word.endUs) / 2 <= cutUs : left > right;
      if (word.endUs <= segment.startUs || word.startUs >= segment.endUs)
        goesBefore = (word.startUs + word.endUs) / 2 <= cutUs;
    }
    (goesBefore ? before : after).push(id);
  }
  return { before, after };
}

export function splitCaptionCue(
  document: CaptionDocumentV1,
  cueId: string,
  text: string,
  caret: number,
  nextId: string,
): CaptionCueEdit | undefined {
  const index = document.segments.findIndex((segment) => segment.id === cueId);
  if (
    index < 0 ||
    nextId.length === 0 ||
    nextId === cueId ||
    document.segments.some((s) => s.id === nextId)
  )
    return undefined;

  const segment = document.segments[index]!;
  const offset = snapOffset(text, caret);
  const beforeText = text.slice(0, offset);
  const afterText = text.slice(offset);
  if (!hasVisibleText(beforeText) || !hasVisibleText(afterText)) return undefined;

  const graphemeList = graphemes(text);
  const beforeCount = graphemeList.filter(({ end }) => end <= offset).length;
  const ratio = graphemeList.length === 0 ? 0 : beforeCount / graphemeList.length;
  const duration = segment.endUs - segment.startUs;
  if (duration < 2) return undefined;
  const desiredCut =
    mappedWordCut(document, segment, text, offset) ?? segment.startUs + duration * ratio;
  const cutUs = Math.max(segment.startUs + 1, Math.min(segment.endUs - 1, Math.round(desiredCut)));
  if (cutUs <= segment.startUs || cutUs >= segment.endUs) return undefined;

  const ids = splitWordIds(document, segment, cutUs, ratio);
  const first: CaptionSegmentV1 = {
    ...segment,
    endUs: cutUs,
    wordIds: ids.before,
    textOverride: beforeText,
  };
  const second: CaptionSegmentV1 = {
    ...segment,
    id: nextId,
    startUs: cutUs,
    wordIds: ids.after,
    textOverride: afterText,
  };
  const segments = [...document.segments];
  segments.splice(index, 1, first, second);
  return { document: { ...document, segments }, focusCueId: nextId, caret: 0 };
}

export function mergeCaptionCueWithPrevious(
  document: CaptionDocumentV1,
  cueId: string,
  text: string,
  previousDraft?: string,
): CaptionCueEdit | undefined {
  const index = document.segments.findIndex((segment) => segment.id === cueId);
  if (index < 0 || text.length === 0) return undefined;
  const segment = document.segments[index]!;
  const predecessor = document.segments
    .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
    .filter(({ candidate }) => candidate.id !== cueId && candidate.startUs < segment.startUs)
    .sort(
      (left, right) =>
        right.candidate.startUs - left.candidate.startUs ||
        right.candidateIndex - left.candidateIndex,
    )[0]?.candidate;
  if (predecessor === undefined) return undefined;

  const left = (previousDraft ?? segmentDisplayText(document, predecessor)).trim();
  const right = text.trim();
  const separator = left.length > 0 && right.length > 0 ? ' ' : '';
  const merged: CaptionSegmentV1 = {
    ...predecessor,
    endUs: Math.max(predecessor.endUs, segment.endUs),
    wordIds: [...new Set([...predecessor.wordIds, ...segment.wordIds])],
    textOverride: `${left}${separator}${right}`,
  };
  const segments = document.segments
    .filter((candidate) => candidate.id !== cueId)
    .map((candidate) => (candidate.id === predecessor.id ? merged : candidate));
  return {
    document: { ...document, segments },
    focusCueId: predecessor.id,
    caret: left.length + separator.length,
  };
}
