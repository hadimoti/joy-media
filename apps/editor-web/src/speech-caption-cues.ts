import type {
  CaptionDocumentV1,
  CaptionSegmentV1,
  CaptionWordV1,
} from '@joy-media/project-schema';
import { segmentSourceText } from '@joy-media/captions-core';
import { repairPersianSpeechTokens } from './persian-speech-text.js';

const PAUSE_BREAK_US = 600_000;
const SOFT_DURATION_US = 6_000_000;
const MAX_LINE_GRAPHEMES = 42;

interface DisplayWord {
  readonly id: string;
  readonly word: CaptionWordV1;
  readonly text: string;
}

interface DisplayUnit {
  readonly words: readonly DisplayWord[];
  readonly text: string;
}

function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter === 'function')
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
      ({ segment }) => segment,
    );

  const result: string[] = [];
  for (const character of text) {
    const previous = result.at(-1);
    if (
      previous !== undefined &&
      (/\p{Mark}/u.test(character) ||
        /[\p{Variation_Selector}\p{Emoji_Modifier}]/u.test(character) ||
        previous.endsWith('\u200d') ||
        character === '\u200d' ||
        character === '\u200c')
    ) {
      result[result.length - 1] = previous + character;
    } else result.push(character);
  }
  return result;
}

function wrapText(text: string): string[] {
  const chunks = text.trim().split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let line = '';

  for (const chunk of chunks) {
    const candidate = line.length === 0 ? chunk : `${line} ${chunk}`;
    if (graphemes(candidate).length <= MAX_LINE_GRAPHEMES) {
      line = candidate;
      continue;
    }
    if (line.length > 0) lines.push(line);
    line = chunk;
  }
  if (line.length > 0) lines.push(line);

  // A single unbroken token can exceed a line. Split only at grapheme boundaries;
  // the original token remains one timed word in the source table.
  const splitLines: string[] = [];
  for (const value of lines) {
    const parts = graphemes(value);
    for (let index = 0; index < parts.length; index += MAX_LINE_GRAPHEMES)
      splitLines.push(parts.slice(index, index + MAX_LINE_GRAPHEMES).join(''));
  }
  return splitLines;
}

function endsSentence(text: string): boolean {
  return /[.!?؟۔]+["'”’»)}\]]*$/u.test(text.trimEnd());
}

function displayUnits(words: readonly DisplayWord[]): DisplayUnit[] {
  const units: DisplayUnit[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const first = words[index]!;
    const second = words[index + 1];
    if (second !== undefined && first.text.endsWith('\u200c')) {
      units.push({ words: [first, second], text: `${first.text}${second.text}` });
      index += 1;
    } else units.push({ words: [first], text: first.text });
  }
  return units;
}

function joinUnits(units: readonly DisplayUnit[]): string {
  let text = '';
  for (const unit of units) {
    const joinsPrevious = text.endsWith('\u200c');
    text += `${text.length > 0 && !joinsPrevious ? ' ' : ''}${unit.text}`;
  }
  return text;
}

function segmentId(firstWordId: string, lastWordId: string): string {
  return `speech-cue:${encodeURIComponent(firstWordId)}:${encodeURIComponent(lastWordId)}`;
}

/**
 * Rebuilds a freshly generated, already placed transcript as readable caption
 * cues. Word ids, intervals, and source text remain unchanged; only the cue
 * layout and, when needed, its display-only text override are generated here.
 */
export function buildSpeechCaptionCues(document: CaptionDocumentV1): CaptionDocumentV1 {
  const sourceWords = Object.entries(document.words)
    .map(([id, word], order) => ({ id, word, order }))
    .sort(
      (left, right) =>
        left.word.startUs - right.word.startUs ||
        left.word.endUs - right.word.endUs ||
        left.order - right.order,
    );
  if (sourceWords.length === 0) return { ...document, segments: [] };

  const repaired = repairPersianSpeechTokens(sourceWords.map(({ word }) => word));
  const displayWords = sourceWords.map(({ id, word }, index) => ({
    id,
    word,
    text: repaired[index]?.text ?? word.text,
  }));
  const units = displayUnits(displayWords);
  const cues: CaptionSegmentV1[] = [];
  let current: DisplayUnit[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const cueWords = current.flatMap((unit) => unit.words);
    const first = cueWords[0]!;
    const last = cueWords.at(-1)!;
    const text = joinUnits(current);
    const layout = wrapText(text).join('\n');
    const segment: CaptionSegmentV1 = {
      id: segmentId(first.id, last.id),
      startUs: first.word.startUs,
      endUs: last.word.endUs,
      wordIds: cueWords.map(({ id }) => id),
      ...(layout === segmentSourceText(document, {
        id: '',
        startUs: first.word.startUs,
        endUs: last.word.endUs,
        wordIds: cueWords.map(({ id }) => id),
      })
        ? {}
        : { textOverride: layout }),
      ...(first.word.speakerId === undefined ? {} : { speakerId: first.word.speakerId }),
    };
    cues.push(segment);
    current = [];
  };

  for (const unit of units) {
    const previous = current.at(-1);
    if (previous !== undefined) {
      const firstWord = current[0]!.words[0]!.word;
      const lastWord = previous.words.at(-1)!.word;
      const nextWord = unit.words[0]!.word;
      const pause = nextWord.startUs - lastWord.endUs;
      const duration = unit.words.at(-1)!.word.endUs - firstWord.startUs;
      const exceedsLines = wrapText(joinUnits([...current, unit])).length > 2;
      if (
        pause >= PAUSE_BREAK_US ||
        endsSentence(previous.text) ||
        duration > SOFT_DURATION_US ||
        previous.words.at(-1)?.word.speakerId !== nextWord.speakerId ||
        exceedsLines
      ) flush();
    }
    current.push(unit);
  }
  flush();

  return { ...document, segments: cues };
}
