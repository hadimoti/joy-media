/**
 * @joy-media/captions-core — structured caption evaluation and layout (WP-03.1).
 *
 * Captions are structured language data before they are graphics (§20.5). The
 * durable word/segment/speaker shapes live in `@joy-media/project-schema` v1;
 * this package owns the pure logic on top: display-text resolution that never
 * mutates source tokens, base-direction resolution for RTL/Persian (§33.4),
 * timeline integration (caption clips → active cues), and layout into Render
 * IR text nodes. No speech model, provider, renderer, or I/O concern may enter
 * this package (§2.7).
 */

import type {
  CaptionDocumentV1,
  CaptionSegmentV1,
  CaptionWordV1,
  CompositionV1,
  TimeUs,
} from '@joy-media/project-schema';
import { rangeContainsUs } from '@joy-media/project-schema';
import type { Rgba, RenderNode, TextNode } from '@joy-media/render-ir';

export const PACKAGE_NAME = '@joy-media/captions-core' as const;

export type {
  CaptionDocumentV1,
  CaptionSegmentV1,
  CaptionSpeakerV1,
  CaptionWordV1,
  CaptionClipV1,
} from '@joy-media/project-schema';

export type {
  CaptionApplyResult,
  CaptionCommand,
  CaptionSearchMatch,
  CaptionSlot,
} from './editing.js';
export {
  applyCaptionProjectCommand,
  CaptionCommandError,
  captionSlots,
  DEFAULT_CONFIDENCE_WARNING_THRESHOLD,
  searchCaptionSegments,
  segmentMinConfidence,
  segmentTimelineRange,
} from './editing.js';

export type {
  CaptionImportDiagnostic,
  CaptionImportOptions,
  CaptionImportResult,
} from './interchange.js';
export { formatSrt, formatWebVtt, parseSrt, parseWebVtt } from './interchange.js';

export type { CaptionLine, CaptionTemplate, TemplatedCaptionLayoutOptions } from './styling.js';
export {
  breakCaptionLines,
  DEFAULT_CAPTION_TEMPLATE_ID,
  JOY_CAPTION_TEMPLATES,
  layoutTemplatedCaptionNodes,
  resolveCaptionTemplate,
} from './styling.js';

/** Strong RTL ranges: Hebrew, Arabic (+supplements/extended), presentation forms. */
const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
/** Strong LTR: basic + extended Latin, Greek, Cyrillic, Armenian. */
const LTR_CHAR = /[A-Za-z\u00C0-\u024F\u0370-\u058F]/;

/**
 * Resolves the document's base direction. 'auto' scans display text for the
 * first strong directional character (per-character, cheap approximation of
 * UAX#9 rule P2/P3) and defaults to 'ltr' when none exists.
 */
export function resolveCaptionDirection(document: CaptionDocumentV1): 'ltr' | 'rtl' {
  if (document.direction !== 'auto') return document.direction;
  for (const segment of document.segments) {
    for (const char of segmentDisplayText(document, segment)) {
      if (RTL_CHAR.test(char)) return 'rtl';
      if (LTR_CHAR.test(char)) return 'ltr';
    }
  }
  return 'ltr';
}

/** Joined source tokens in `wordIds` order. Unknown ids are skipped, never invented. */
export function segmentSourceText(document: CaptionDocumentV1, segment: CaptionSegmentV1): string {
  return segment.wordIds
    .map((wordId) => document.words[wordId]?.text)
    .filter((text): text is string => text !== undefined && text.length > 0)
    .join(' ');
}

/**
 * What the viewer reads: the edited override when present, otherwise the source
 * tokens. Overrides never touch the word table (§20.5 revert guarantee).
 */
export function segmentDisplayText(document: CaptionDocumentV1, segment: CaptionSegmentV1): string {
  return segment.textOverride ?? segmentSourceText(document, segment);
}

/** Segments active at a document-local time, in start order (stable by id). */
export function activeCaptionSegments(
  document: CaptionDocumentV1,
  documentTimeUs: TimeUs,
): readonly CaptionSegmentV1[] {
  return document.segments
    .filter((segment) =>
      rangeContainsUs(
        { startUs: segment.startUs, durationUs: segment.endUs - segment.startUs },
        documentTimeUs,
      ),
    )
    .sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id));
}

/** The segment word active at a document-local time — the karaoke basis (WP-03.3). */
export function activeCaptionWord(
  document: CaptionDocumentV1,
  segment: CaptionSegmentV1,
  documentTimeUs: TimeUs,
): CaptionWordV1 | undefined {
  for (const wordId of segment.wordIds) {
    const word = document.words[wordId];
    if (
      word !== undefined &&
      rangeContainsUs(
        { startUs: word.startUs, durationUs: word.endUs - word.startUs },
        documentTimeUs,
      )
    )
      return word;
  }
  return undefined;
}

/** One visible caption line: an active segment reached through a caption clip. */
export interface CaptionCue {
  readonly clipId: string;
  readonly documentId: string;
  readonly document: CaptionDocumentV1;
  readonly segment: CaptionSegmentV1;
  /** Document-local time (clip-relative) that produced this cue. */
  readonly documentTimeUs: TimeUs;
}

/**
 * Timeline integration: resolves a composition's enabled caption tracks at a
 * composition time into active cues. Document times are clip-relative, so
 * moving a caption clip moves every cue with it. A clip whose document is
 * missing yields no cues instead of failing — manual editing must survive
 * missing data (P03 exit criterion).
 */
export function captionCuesAt(
  composition: CompositionV1,
  captionDocuments: Readonly<Record<string, CaptionDocumentV1>>,
  timeUs: TimeUs,
): readonly CaptionCue[] {
  const cues: CaptionCue[] = [];
  const tracks = [...composition.tracks]
    .filter((track) => track.kind === 'caption' && track.enabled)
    .sort((left, right) => left.order - right.order);
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== 'caption') continue;
      if (!rangeContainsUs({ startUs: clip.startUs, durationUs: clip.durationUs }, timeUs))
        continue;
      const document = captionDocuments[clip.captionDocumentId];
      if (document === undefined) continue;
      const documentTimeUs = timeUs - clip.startUs;
      for (const segment of activeCaptionSegments(document, documentTimeUs)) {
        cues.push({
          clipId: clip.id,
          documentId: document.id,
          document,
          segment,
          documentTimeUs,
        });
      }
    }
  }
  return cues;
}

export interface CaptionLayoutOptions {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** Insets in viewport pixels keeping captions clear of platform UI (§20.5). */
  readonly safeArea?: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  /** Vertical stacking step in pixels; defaults to 6% of viewport height. */
  readonly lineHeightPx?: number;
  /** Horizontal anchor; defaults to 'center' for LTR and RTL alike. */
  readonly align?: 'left' | 'center' | 'right';
  readonly color?: Rgba;
}

const DEFAULT_CAPTION_COLOR: Rgba = { r: 255, g: 255, b: 255, a: 255 };

/**
 * Lays active cues out as Render IR text nodes inside the safe area, stacking
 * upward from the bottom safe line. Alignment and resolved base direction ride
 * on the nodes; renderers own glyph shaping and metrics, never re-detection.
 */
export function layoutCaptionNodes(
  cues: readonly CaptionCue[],
  options: CaptionLayoutOptions,
): readonly RenderNode[] {
  const safeArea = options.safeArea ?? {
    left: options.viewportWidth * 0.1,
    top: options.viewportHeight * 0.1,
    right: options.viewportWidth * 0.1,
    bottom: options.viewportHeight * 0.1,
  };
  const lineHeightPx = options.lineHeightPx ?? options.viewportHeight * 0.06;
  const align = options.align ?? 'center';
  const usableWidth = options.viewportWidth - safeArea.left - safeArea.right;
  const anchorX =
    align === 'left'
      ? safeArea.left
      : align === 'right'
        ? options.viewportWidth - safeArea.right
        : options.viewportWidth / 2;
  const bottomLineY = options.viewportHeight - safeArea.bottom - lineHeightPx;

  const nodes: TextNode[] = [];
  for (const [index, cue] of cues.entries()) {
    const text = segmentDisplayText(cue.document, cue.segment);
    if (text.length === 0) continue;
    const lineY = bottomLineY - (cues.length - 1 - index) * lineHeightPx;
    if (lineY < safeArea.top) continue; // never escape the top safe boundary
    nodes.push({
      kind: 'text',
      id: `caption:${cue.clipId}:${cue.segment.id}`,
      zIndex: 10_000 + index,
      opacity: 1,
      transform: { translateX: anchorX, translateY: lineY, scaleX: 1, scaleY: 1 },
      text,
      color: options.color ?? DEFAULT_CAPTION_COLOR,
      direction: resolveCaptionDirection(cue.document),
      align,
      maxWidth: usableWidth,
    });
  }
  return nodes;
}
