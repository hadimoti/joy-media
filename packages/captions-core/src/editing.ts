/**
 * Caption editing surface logic (WP-03.2): durable caption commands with
 * pre-state inverses, transcript search, confidence warnings, and
 * transcript↔timeline selection primitives. Pure — commands mutate nothing;
 * they return the next v1 project plus the inverse command (ADR-0003 style).
 *
 * Text edits write `textOverride` only; the source word tokens and their
 * timings are never rewritten by a text edit (§20.5 revert guarantee).
 */

import type {
  CaptionClipV1,
  CaptionClipStyleV2,
  CaptionDocumentV1,
  CaptionSegmentV1,
  CompositionV1,
  JoyProjectV1,
  TimeRange,
  TimeUs,
} from '@joy-media/project-schema';
import { segmentDisplayText, segmentSourceText } from './index.js';

export class CaptionCommandError extends RangeError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CaptionCommandError';
    this.code = code;
  }
}

export type CaptionCommand =
  | {
      readonly type: 'caption.setClipStyle';
      readonly payload: {
        readonly clipId: string;
        readonly style?: CaptionClipStyleV2;
      };
    }
  | {
      readonly type: 'caption.setSegmentText';
      readonly payload: {
        readonly documentId: string;
        readonly segmentId: string;
        /** Display override; undefined reverts the segment to its source tokens. */
        readonly textOverride: string | undefined;
      };
    }
  | {
      readonly type: 'caption.setSegmentTiming';
      readonly payload: {
        readonly documentId: string;
        readonly segmentId: string;
        readonly startUs: TimeUs;
        readonly endUs: TimeUs;
      };
    }
  | {
      readonly type: 'caption.setWordTiming';
      readonly payload: {
        readonly documentId: string;
        readonly wordId: string;
        readonly startUs: TimeUs;
        readonly endUs: TimeUs;
      };
    }
  | {
      readonly type: 'caption.addSegment';
      readonly payload: {
        readonly documentId: string;
        readonly segment: CaptionSegmentV1;
      };
    }
  | {
      readonly type: 'caption.removeSegment';
      readonly payload: {
        readonly documentId: string;
        readonly segmentId: string;
      };
    }
  | {
      readonly type: 'caption.setStyle';
      readonly payload: {
        readonly documentId: string;
        /** Template id from the style registry; undefined restores the default. */
        readonly styleRef: string | undefined;
      };
    }
  | {
      readonly type: 'caption.replaceDocument';
      readonly payload: {
        readonly documentId: string;
        /** Full replacement (SRT/WebVTT import, transcription insert). */
        readonly document: CaptionDocumentV1;
      };
    };

export interface CaptionApplyResult {
  readonly project: JoyProjectV1;
  readonly inverse: CaptionCommand;
}

/** Applies one caption command to the durable v1 project, returning its inverse. */
export function applyCaptionProjectCommand(
  project: JoyProjectV1,
  command: CaptionCommand,
): CaptionApplyResult {
  if (command.type === 'caption.setClipStyle') return applyClipStyle(project, command);
  const document = project.captionDocuments[command.payload.documentId];
  if (document === undefined)
    throw new CaptionCommandError(
      'CAPTION_COMMAND_UNKNOWN_DOCUMENT',
      `unknown caption document "${command.payload.documentId}"`,
    );

  switch (command.type) {
    case 'caption.setSegmentText': {
      const segment = requireSegment(document, command.payload.segmentId);
      const withoutOverride = { ...segment };
      delete withoutOverride.textOverride;
      const nextSegment: CaptionSegmentV1 =
        command.payload.textOverride === undefined
          ? withoutOverride
          : { ...withoutOverride, textOverride: command.payload.textOverride };
      return {
        project: withSegment(project, document, nextSegment),
        inverse: {
          type: 'caption.setSegmentText',
          payload: {
            documentId: document.id,
            segmentId: segment.id,
            textOverride: segment.textOverride,
          },
        },
      };
    }
    case 'caption.setSegmentTiming': {
      const segment = requireSegment(document, command.payload.segmentId);
      assertRange(command.payload.startUs, command.payload.endUs);
      return {
        project: withSegment(project, document, {
          ...segment,
          startUs: command.payload.startUs,
          endUs: command.payload.endUs,
        }),
        inverse: {
          type: 'caption.setSegmentTiming',
          payload: {
            documentId: document.id,
            segmentId: segment.id,
            startUs: segment.startUs,
            endUs: segment.endUs,
          },
        },
      };
    }
    case 'caption.setWordTiming': {
      const word = document.words[command.payload.wordId];
      if (word === undefined)
        throw new CaptionCommandError(
          'CAPTION_COMMAND_UNKNOWN_WORD',
          `unknown caption word "${command.payload.wordId}"`,
        );
      assertRange(command.payload.startUs, command.payload.endUs);
      return {
        project: withDocument(project, {
          ...document,
          words: {
            ...document.words,
            [word.id]: {
              ...word,
              startUs: command.payload.startUs,
              endUs: command.payload.endUs,
            },
          },
        }),
        inverse: {
          type: 'caption.setWordTiming',
          payload: {
            documentId: document.id,
            wordId: word.id,
            startUs: word.startUs,
            endUs: word.endUs,
          },
        },
      };
    }
    case 'caption.addSegment': {
      const segment = command.payload.segment;
      if (document.segments.some((existing) => existing.id === segment.id))
        throw new CaptionCommandError(
          'CAPTION_COMMAND_DUPLICATE_SEGMENT',
          `segment "${segment.id}" already exists`,
        );
      assertRange(segment.startUs, segment.endUs);
      for (const wordId of segment.wordIds) {
        if (document.words[wordId] === undefined)
          throw new CaptionCommandError(
            'CAPTION_COMMAND_UNKNOWN_WORD',
            `segment references unknown word "${wordId}"`,
          );
      }
      const segments = [...document.segments, segment].sort(
        (left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id),
      );
      return {
        project: withDocument(project, { ...document, segments }),
        inverse: {
          type: 'caption.removeSegment',
          payload: { documentId: document.id, segmentId: segment.id },
        },
      };
    }
    case 'caption.removeSegment': {
      const segment = requireSegment(document, command.payload.segmentId);
      return {
        project: withDocument(project, {
          ...document,
          segments: document.segments.filter((existing) => existing.id !== segment.id),
        }),
        inverse: {
          type: 'caption.addSegment',
          payload: { documentId: document.id, segment },
        },
      };
    }
    case 'caption.setStyle': {
      const withoutStyle = { ...document };
      delete withoutStyle.styleRef;
      const nextDocument: CaptionDocumentV1 =
        command.payload.styleRef === undefined
          ? withoutStyle
          : { ...withoutStyle, styleRef: command.payload.styleRef };
      return {
        project: withDocument(project, nextDocument),
        inverse: {
          type: 'caption.setStyle',
          payload: { documentId: document.id, styleRef: document.styleRef },
        },
      };
    }
    case 'caption.replaceDocument': {
      if (command.payload.document.id !== command.payload.documentId)
        throw new CaptionCommandError(
          'CAPTION_COMMAND_DOCUMENT_ID_MISMATCH',
          `replacement document id "${command.payload.document.id}" must match "${command.payload.documentId}"`,
        );
      return {
        project: withDocument(project, command.payload.document),
        inverse: {
          type: 'caption.replaceDocument',
          payload: { documentId: document.id, document },
        },
      };
    }
  }
}

function applyClipStyle(
  project: JoyProjectV1,
  command: Extract<CaptionCommand, { readonly type: 'caption.setClipStyle' }>,
): CaptionApplyResult {
  let found: CaptionClipV1 | undefined;
  let matchCount = 0;
  for (const composition of Object.values(project.compositions)) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        if (clip.kind === 'caption' && clip.id === command.payload.clipId) {
          found = clip;
          matchCount += 1;
        }
      }
    }
  }
  if (found === undefined)
    throw new CaptionCommandError(
      'CAPTION_COMMAND_UNKNOWN_CLIP',
      `unknown caption clip "${command.payload.clipId}"`,
    );
  if (matchCount !== 1)
    throw new CaptionCommandError(
      'CAPTION_COMMAND_DUPLICATE_CLIP',
      `caption clip "${command.payload.clipId}" must be unique`,
    );
  const nextProject = mapCaptionClip(project, found.id, (clip) => {
    const next = { ...clip };
    if (command.payload.style === undefined) delete next.style;
    else next.style = command.payload.style;
    return next;
  });
  return {
    project: nextProject,
    inverse: {
      type: 'caption.setClipStyle',
      payload: {
        clipId: found.id,
        ...(found.style === undefined ? {} : { style: found.style }),
      },
    },
  };
}

function mapCaptionClip(
  project: JoyProjectV1,
  clipId: string,
  map: (clip: CaptionClipV1) => CaptionClipV1,
): JoyProjectV1 {
  return {
    ...project,
    compositions: Object.fromEntries(
      Object.entries(project.compositions).map(([compositionId, composition]) => [
        compositionId,
        {
          ...composition,
          tracks: composition.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((clip) =>
              clip.kind === 'caption' && clip.id === clipId ? map(clip) : clip,
            ),
          })),
        },
      ]),
    ),
  };
}

/** A caption clip resolved with its document — what editing panels iterate. */
export interface CaptionSlot {
  readonly trackId: string;
  readonly clip: CaptionClipV1;
  readonly document: CaptionDocumentV1;
}

/**
 * Caption clips on enabled caption tracks whose documents exist, in track/clip
 * order. Clips with missing documents are skipped so manual editing keeps
 * working when data is unavailable (P03 exit criterion).
 */
export function captionSlots(
  composition: CompositionV1,
  captionDocuments: Readonly<Record<string, CaptionDocumentV1>>,
): readonly CaptionSlot[] {
  const slots: CaptionSlot[] = [];
  const tracks = [...composition.tracks]
    .filter((track) => track.kind === 'caption' && track.enabled)
    .sort((left, right) => left.order - right.order);
  for (const track of tracks) {
    const clips = [...track.clips]
      .filter((clip): clip is CaptionClipV1 => clip.kind === 'caption')
      .sort((left, right) => left.startUs - right.startUs);
    for (const clip of clips) {
      const document = captionDocuments[clip.captionDocumentId];
      if (document !== undefined) slots.push({ trackId: track.id, clip, document });
    }
  }
  return slots;
}

/**
 * Transcript→timeline selection primitive: the composition-time range a
 * segment occupies through a clip, clamped to the clip's own range.
 */
export function segmentTimelineRange(
  clip: CaptionClipV1,
  segment: CaptionSegmentV1,
): TimeRange | undefined {
  const startUs = clip.startUs + segment.startUs;
  const endUs = Math.min(clip.startUs + segment.endUs, clip.startUs + clip.durationUs);
  if (startUs >= clip.startUs + clip.durationUs || endUs <= startUs) return undefined;
  return { startUs, durationUs: endUs - startUs };
}

export interface CaptionSearchMatch {
  readonly segment: CaptionSegmentV1;
  readonly matchedText: string;
}

/** Case-insensitive transcript search over display text and source tokens. */
export function searchCaptionSegments(
  document: CaptionDocumentV1,
  query: string,
): readonly CaptionSearchMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return [];
  const matches: CaptionSearchMatch[] = [];
  for (const segment of document.segments) {
    const display = segmentDisplayText(document, segment);
    const source = segmentSourceText(document, segment);
    if (display.toLocaleLowerCase().includes(needle)) {
      matches.push({ segment, matchedText: display });
    } else if (source.toLocaleLowerCase().includes(needle)) {
      matches.push({ segment, matchedText: source });
    }
  }
  return matches;
}

export const DEFAULT_CONFIDENCE_WARNING_THRESHOLD = 0.75;

/**
 * Lowest word confidence in a segment, or undefined when no word carries a
 * score (manually authored captions warn about nothing).
 */
export function segmentMinConfidence(
  document: CaptionDocumentV1,
  segment: CaptionSegmentV1,
): number | undefined {
  let min: number | undefined;
  for (const wordId of segment.wordIds) {
    const confidence = document.words[wordId]?.confidence;
    if (confidence !== undefined && (min === undefined || confidence < min)) min = confidence;
  }
  return min;
}

function requireSegment(document: CaptionDocumentV1, segmentId: string): CaptionSegmentV1 {
  const segment = document.segments.find((existing) => existing.id === segmentId);
  if (segment === undefined)
    throw new CaptionCommandError(
      'CAPTION_COMMAND_UNKNOWN_SEGMENT',
      `unknown caption segment "${segmentId}"`,
    );
  return segment;
}

function assertRange(startUs: TimeUs, endUs: TimeUs): void {
  if (
    !Number.isSafeInteger(startUs) ||
    !Number.isSafeInteger(endUs) ||
    startUs < 0 ||
    endUs <= startUs
  )
    throw new CaptionCommandError(
      'CAPTION_COMMAND_INVALID_RANGE',
      `caption range must satisfy 0 <= startUs < endUs, got [${startUs}, ${endUs})`,
    );
}

function withSegment(
  project: JoyProjectV1,
  document: CaptionDocumentV1,
  segment: CaptionSegmentV1,
): JoyProjectV1 {
  return withDocument(project, {
    ...document,
    segments: document.segments.map((existing) =>
      existing.id === segment.id ? segment : existing,
    ),
  });
}

function withDocument(project: JoyProjectV1, document: CaptionDocumentV1): JoyProjectV1 {
  return {
    ...project,
    captionDocuments: { ...project.captionDocuments, [document.id]: document },
  };
}
