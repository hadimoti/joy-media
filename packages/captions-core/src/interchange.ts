/**
 * SRT/WebVTT interchange (WP-03.3, §20.5 core features).
 *
 * Import produces a structured caption document: cue text is tokenized into
 * source words with linear timing inside the cue window, because neither
 * format carries word timing. Export writes the display text (overrides win),
 * so an edited transcript exports what the viewer reads. Multi-line cue text
 * is joined with spaces on import; JOY line breaking is a layout concern, not
 * document data. Parsers report malformed blocks as diagnostics and keep the
 * valid remainder instead of failing the whole file.
 */

import type { CaptionDocumentV1, CaptionSegmentV1, CaptionWordV1 } from '@joy-media/project-schema';
import { segmentDisplayText } from './index.js';

export interface CaptionImportDiagnostic {
  readonly code: 'CAPTION_IMPORT_BAD_TIMING' | 'CAPTION_IMPORT_EMPTY_CUE';
  readonly message: string;
  /** 1-based line number of the offending block start in the source text. */
  readonly line: number;
}

export interface CaptionImportResult {
  readonly document: CaptionDocumentV1;
  readonly diagnostics: readonly CaptionImportDiagnostic[];
}

export interface CaptionImportOptions {
  readonly documentId: string;
  /** BCP-47 tag recorded on the document; direction stays 'auto'. */
  readonly language?: string;
}

/** Parses SubRip text. Numeric cue counters are accepted and ignored. */
export function parseSrt(text: string, options: CaptionImportOptions): CaptionImportResult {
  return parseCueBlocks(text, options, 'srt');
}

/** Parses WebVTT text. Cue settings after the timing line are ignored. */
export function parseWebVtt(text: string, options: CaptionImportOptions): CaptionImportResult {
  return parseCueBlocks(text, options, 'vtt');
}

/** Serializes display text as SubRip. */
export function formatSrt(document: CaptionDocumentV1): string {
  return document.segments
    .map(
      (segment, index) =>
        `${index + 1}\n${formatTimestamp(segment.startUs, ',')} --> ${formatTimestamp(
          segment.endUs,
          ',',
        )}\n${segmentDisplayText(document, segment)}`,
    )
    .join('\n\n')
    .concat('\n');
}

/** Serializes display text as WebVTT with stable cue identifiers. */
export function formatWebVtt(document: CaptionDocumentV1): string {
  const cues = document.segments.map(
    (segment) =>
      `${segment.id}\n${formatTimestamp(segment.startUs, '.')} --> ${formatTimestamp(
        segment.endUs,
        '.',
      )}\n${segmentDisplayText(document, segment)}`,
  );
  return ['WEBVTT', ...cues].join('\n\n').concat('\n');
}

const TIMING_LINE =
  /^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})[.,](\d{3})\s+-->\s+(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})[.,](\d{3})/;

function parseCueBlocks(
  text: string,
  options: CaptionImportOptions,
  flavor: 'srt' | 'vtt',
): CaptionImportResult {
  const diagnostics: CaptionImportDiagnostic[] = [];
  const words: Record<string, CaptionWordV1> = {};
  const segments: CaptionSegmentV1[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  let index = 0;
  if (flavor === 'vtt' && (lines[0] ?? '').startsWith('WEBVTT')) index = 1;

  let cueNumber = 0;
  while (index < lines.length) {
    while (index < lines.length && lines[index]!.trim().length === 0) index += 1;
    if (index >= lines.length) break;
    const blockStart = index;
    const block: string[] = [];
    while (index < lines.length && lines[index]!.trim().length > 0) {
      block.push(lines[index]!);
      index += 1;
    }
    if (flavor === 'vtt' && /^(NOTE|STYLE|REGION)\b/.test(block[0]!.trim())) continue;

    let timingLineIndex = 0;
    if (!TIMING_LINE.test(block[0]!) && block.length > 1 && TIMING_LINE.test(block[1]!)) {
      timingLineIndex = 1; // counter (SRT) or cue id (VTT) line
    }
    const timing = TIMING_LINE.exec(block[timingLineIndex] ?? '');
    if (timing === null) {
      diagnostics.push({
        code: 'CAPTION_IMPORT_BAD_TIMING',
        message: `cue block has no valid timing line: "${block[0]!.slice(0, 40)}"`,
        line: blockStart + 1,
      });
      continue;
    }
    const startUs = timestampUs(timing[1], timing[2]!, timing[3]!, timing[4]!);
    const endUs = timestampUs(timing[5], timing[6]!, timing[7]!, timing[8]!);
    const cueText = block
      .slice(timingLineIndex + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '') // strip inline VTT/SRT markup tags
      .trim();
    if (endUs <= startUs || cueText.length === 0) {
      diagnostics.push({
        code: endUs <= startUs ? 'CAPTION_IMPORT_BAD_TIMING' : 'CAPTION_IMPORT_EMPTY_CUE',
        message:
          endUs <= startUs
            ? `cue timing is empty or reversed: [${startUs}, ${endUs})`
            : 'cue has no text',
        line: blockStart + 1,
      });
      continue;
    }

    cueNumber += 1;
    const segmentId = `${options.documentId}-seg-${cueNumber}`;
    const wordIds = tokenizeCue(cueText, startUs, endUs, segmentId, words);
    segments.push({ id: segmentId, startUs, endUs, wordIds });
  }

  return {
    document: {
      id: options.documentId,
      language: options.language ?? 'und',
      direction: 'auto',
      speakers: [],
      words,
      segments,
    },
    diagnostics,
  };
}

/**
 * Splits cue text into source words with linear timing across the cue window.
 * An honest approximation: neither SRT nor WebVTT carries word timing, so no
 * confidence is recorded and karaoke gets evenly spaced word boundaries.
 */
function tokenizeCue(
  text: string,
  startUs: number,
  endUs: number,
  segmentId: string,
  words: Record<string, CaptionWordV1>,
): readonly string[] {
  const tokens = text.split(/\s+/).filter((token) => token.length > 0);
  const ids: string[] = [];
  const step = (endUs - startUs) / tokens.length;
  for (const [tokenIndex, token] of tokens.entries()) {
    const id = `${segmentId}-w-${tokenIndex + 1}`;
    const wordStartUs = Math.round(startUs + step * tokenIndex);
    const wordEndUs =
      tokenIndex === tokens.length - 1 ? endUs : Math.round(startUs + step * (tokenIndex + 1));
    words[id] = {
      id,
      text: token,
      startUs: wordStartUs,
      endUs: Math.max(wordEndUs, wordStartUs + 1),
    };
    ids.push(id);
  }
  return ids;
}

function timestampUs(
  hours: string | undefined,
  minutes: string,
  seconds: string,
  millis: string,
): number {
  return (
    (Number(hours ?? '0') * 3600 + Number(minutes) * 60 + Number(seconds)) * 1_000_000 +
    Number(millis) * 1_000
  );
}

function formatTimestamp(timeUs: number, millisSeparator: ',' | '.'): string {
  const totalMillis = Math.round(timeUs / 1_000);
  const millis = totalMillis % 1_000;
  const totalSeconds = (totalMillis - millis) / 1_000;
  const seconds = totalSeconds % 60;
  const minutes = ((totalSeconds - seconds) / 60) % 60;
  const hours = (totalSeconds - seconds - minutes * 60) / 3600;
  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${millisSeparator}${pad(millis, 3)}`;
}
