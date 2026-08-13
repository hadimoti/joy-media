/**
 * Schema-driven caption styling (WP-03.3, §20.5 template model).
 *
 * A template is versioned data, not a hardcoded look: typography, colors,
 * plate, alignment with RTL behavior, safe areas, responsive line limits, and
 * karaoke. Layout is renderer-neutral — line breaking uses a deterministic
 * character-budget estimate (real glyph metrics stay a renderer concern), and
 * the output is Render IR text nodes whose optional spans carry the active
 * word. Documents select a template through `styleRef`; unknown or missing
 * references fall back to the default template so captions never disappear
 * with a stale style (§20.5 fallback spirit).
 */

import type { Rgba, RenderNode, TextNode, TextSpan } from '@joy-media/render-ir';
import type { CaptionCue } from './index.js';
import { activeCaptionWord, resolveCaptionDirection, segmentDisplayText } from './index.js';

export interface CaptionTemplate {
  readonly id: string;
  readonly name: string;
  /** Bumped on breaking visual changes; recorded for future migrations. */
  readonly version: 1;
  readonly description: string;
  /** Font size as a fraction of viewport height. */
  readonly fontSizePct: number;
  readonly lineHeightFactor: number;
  readonly textColor: Rgba;
  /** Active-word (karaoke) color; used only when `karaoke` is true. */
  readonly activeWordColor: Rgba;
  /** Plate behind each line; undefined renders no box. */
  readonly plateColor?: Rgba;
  /**
   * Logical alignment resolved against the document direction (§33.4):
   * 'start' is left for LTR and right for RTL, 'end' the opposite.
   */
  readonly align: 'start' | 'center' | 'end';
  /** Safe-area insets as fractions of the viewport dimensions. */
  readonly safeAreaPct: { readonly x: number; readonly y: number };
  readonly maxLines: number;
  readonly maxCharsPerLine: number;
  readonly karaoke: boolean;
}

/** Original JOY caption templates (§20.5: descriptive presets, no trademarks). */
export const JOY_CAPTION_TEMPLATES: readonly CaptionTemplate[] = [
  {
    id: 'joy-clean',
    name: 'JOY Clean',
    version: 1,
    description: 'Centered broadcast-clean white text on a soft dark plate.',
    fontSizePct: 0.045,
    lineHeightFactor: 1.3,
    textColor: { r: 255, g: 255, b: 255, a: 255 },
    activeWordColor: { r: 255, g: 255, b: 255, a: 255 },
    plateColor: { r: 10, g: 14, b: 26, a: 200 },
    align: 'center',
    safeAreaPct: { x: 0.1, y: 0.1 },
    maxLines: 2,
    maxCharsPerLine: 42,
    karaoke: false,
  },
  {
    id: 'joy-karaoke-pop',
    name: 'JOY Karaoke Pop',
    version: 1,
    description: 'Bold centered captions; the spoken word pops in JOY amber.',
    fontSizePct: 0.055,
    lineHeightFactor: 1.25,
    textColor: { r: 255, g: 255, b: 255, a: 255 },
    activeWordColor: { r: 233, g: 185, b: 73, a: 255 },
    plateColor: { r: 0, g: 0, b: 0, a: 160 },
    align: 'center',
    safeAreaPct: { x: 0.08, y: 0.12 },
    maxLines: 3,
    maxCharsPerLine: 24,
    karaoke: true,
  },
  {
    id: 'joy-rtl-classic',
    name: 'JOY RTL Classic',
    version: 1,
    description: 'Right-aligned Persian-first captions with a warm tone.',
    fontSizePct: 0.042,
    lineHeightFactor: 1.45,
    textColor: { r: 250, g: 240, b: 220, a: 255 },
    activeWordColor: { r: 233, g: 185, b: 73, a: 255 },
    align: 'start',
    safeAreaPct: { x: 0.12, y: 0.12 },
    maxLines: 2,
    maxCharsPerLine: 36,
    karaoke: false,
  },
];

export const DEFAULT_CAPTION_TEMPLATE_ID = 'joy-clean';

/** Resolves a document's styleRef to a template; unknown refs use the default. */
export function resolveCaptionTemplate(
  styleRef: string | undefined,
  templates: readonly CaptionTemplate[] = JOY_CAPTION_TEMPLATES,
): CaptionTemplate {
  const fallback =
    templates.find((template) => template.id === DEFAULT_CAPTION_TEMPLATE_ID) ?? templates[0];
  if (fallback === undefined) throw new RangeError('caption template registry is empty');
  if (styleRef === undefined) return fallback;
  return templates.find((template) => template.id === styleRef) ?? fallback;
}

export interface CaptionLine {
  readonly text: string;
  /** Word indices (into the segment's wordIds) this line covers; empty for overridden text. */
  readonly wordIndices: readonly number[];
}

/**
 * Deterministic greedy word wrap by character budget. When the wrap exceeds
 * `maxLines`, the caller is expected to retry with a smaller font (see
 * `layoutTemplatedCaptionNodes`); this function never drops text.
 */
export function breakCaptionLines(
  tokens: readonly string[],
  maxCharsPerLine: number,
): readonly CaptionLine[] {
  const lines: { text: string; wordIndices: number[] }[] = [];
  for (const [index, token] of tokens.entries()) {
    const current = lines[lines.length - 1];
    if (current !== undefined && current.text.length + 1 + token.length <= maxCharsPerLine) {
      current.text = `${current.text} ${token}`;
      current.wordIndices.push(index);
    } else {
      lines.push({ text: token, wordIndices: [index] });
    }
  }
  return lines;
}

export interface TemplatedCaptionLayoutOptions {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly templates?: readonly CaptionTemplate[];
}

/**
 * Lays active cues out with their documents' templates: responsive line
 * breaking inside the safe area (font shrinks when the text needs more lines
 * than the template allows), RTL-aware alignment, plates, and karaoke spans on
 * the line containing the active word. Cues stack upward from the bottom safe
 * line; text is never dropped.
 */
export function layoutTemplatedCaptionNodes(
  cues: readonly CaptionCue[],
  options: TemplatedCaptionLayoutOptions,
): readonly RenderNode[] {
  const nodes: TextNode[] = [];
  let bottomY = 0; // consumed height above the bottom safe line, across cues
  for (const [cueIndex, cue] of [...cues].reverse().entries()) {
    const baseTemplate = resolveCaptionTemplate(
      cue.style?.templateId ?? cue.document.styleRef,
      options.templates,
    );
    const clipStyle = cue.style;
    const plateColor =
      clipStyle === undefined
        ? baseTemplate.plateColor
        : clipStyle.plateOpacity > 0
          ? withAlpha(
              parseCaptionColor(clipStyle.plateColor) ?? baseTemplate.plateColor,
              clipStyle.plateOpacity,
            )
          : undefined;
    const template: CaptionTemplate = {
      ...baseTemplate,
      fontSizePct: baseTemplate.fontSizePct * (clipStyle?.fontSize ?? 1),
      lineHeightFactor: baseTemplate.lineHeightFactor * (clipStyle?.lineHeight ?? 1),
      textColor: parseCaptionColor(clipStyle?.textColor) ?? baseTemplate.textColor,
      activeWordColor: parseCaptionColor(clipStyle?.highlightColor) ?? baseTemplate.activeWordColor,
      align: clipStyle?.align ?? baseTemplate.align,
      ...(plateColor === undefined ? {} : { plateColor }),
    };
    const direction = resolveCaptionDirection(cue.document);
    const align =
      template.align === 'center'
        ? 'center'
        : (template.align === 'start') === (direction === 'ltr')
          ? 'left'
          : 'right';

    const displayText = segmentDisplayText(cue.document, cue.segment);
    if (displayText.length === 0) continue;
    // Karaoke needs intact source tokens; an override breaks word mapping.
    const sourceTokens =
      cue.segment.textOverride === undefined
        ? cue.segment.wordIds
            .map((wordId) => cue.document.words[wordId]?.text ?? '')
            .filter((token) => token.length > 0)
        : displayText.split(/\s+/);

    // Responsive sizing: shrink until the wrap fits the template's line budget.
    let fontSizePx = template.fontSizePct * options.viewportHeight;
    let lines = breakCaptionLines(sourceTokens, template.maxCharsPerLine);
    for (let pass = 0; lines.length > template.maxLines && pass < 3; pass += 1) {
      fontSizePx *= 0.85;
      const budget = Math.ceil(template.maxCharsPerLine / 0.85 ** (pass + 1));
      lines = breakCaptionLines(sourceTokens, budget);
    }

    const safeX = template.safeAreaPct.x * options.viewportWidth;
    const safeY = template.safeAreaPct.y * options.viewportHeight;
    const usableWidth = options.viewportWidth - 2 * safeX;
    const anchorX =
      align === 'left'
        ? safeX
        : align === 'right'
          ? options.viewportWidth - safeX
          : options.viewportWidth / 2;
    const positionedAnchorX = anchorX + (clipStyle?.positionX ?? 0) * options.viewportWidth;
    const lineHeightPx = fontSizePx * template.lineHeightFactor;

    const activeWord =
      template.karaoke && cue.segment.textOverride === undefined
        ? activeCaptionWord(cue.document, cue.segment, cue.documentTimeUs)
        : undefined;
    const activeIndex = activeWord === undefined ? -1 : cue.segment.wordIds.indexOf(activeWord.id);

    for (const [lineIndex, line] of [...lines].reverse().entries()) {
      const lineY =
        options.viewportHeight -
        safeY -
        bottomY -
        (lineIndex + 1) * lineHeightPx -
        (clipStyle?.positionY ?? 0) * options.viewportHeight;
      if (lineY < safeY) break; // never escape the top safe boundary
      nodes.push({
        kind: 'text',
        id: `caption:${cue.clipId}:${cue.segment.id}:line${lines.length - 1 - lineIndex}`,
        zIndex: 10_000 + cueIndex * 10 + lineIndex,
        opacity: clipStyle?.opacity ?? 1,
        transform: {
          translateX: positionedAnchorX,
          translateY: lineY,
          scaleX: clipStyle?.scale ?? 1,
          scaleY: clipStyle?.scale ?? 1,
        },
        text: line.text,
        color: template.textColor,
        direction,
        align,
        maxWidth: usableWidth,
        fontSizePx,
        ...(template.plateColor === undefined ? {} : { background: template.plateColor }),
        ...karaokeSpans(line, sourceTokens, activeIndex, template),
      });
    }
    bottomY += lines.length * lineHeightPx + lineHeightPx * 0.25;
  }
  return nodes;
}

function parseCaptionColor(value: string | undefined): Rgba | undefined {
  if (value === undefined) return undefined;
  const match = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (match === null) return undefined;
  const hex = match[1]!;
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255,
  };
}

function withAlpha(color: Rgba | undefined, opacity: number): Rgba | undefined {
  if (color === undefined) return undefined;
  return { ...color, a: Math.round(color.a * Math.max(0, Math.min(1, opacity))) };
}

function karaokeSpans(
  line: CaptionLine,
  tokens: readonly string[],
  activeIndex: number,
  template: CaptionTemplate,
): { readonly spans?: readonly TextSpan[] } {
  if (activeIndex < 0 || !line.wordIndices.includes(activeIndex)) return {};
  const spans: TextSpan[] = [];
  let pending = '';
  for (const [position, wordIndex] of line.wordIndices.entries()) {
    const token = tokens[wordIndex] ?? '';
    const separator = position === 0 ? '' : ' ';
    if (wordIndex === activeIndex) {
      if (pending.length > 0 || separator.length > 0) {
        spans.push({ text: `${pending}${separator}`, color: template.textColor });
      }
      spans.push({ text: token, color: template.activeWordColor, emphasis: true });
      pending = '';
    } else {
      pending = `${pending}${separator}${token}`;
    }
  }
  if (pending.length > 0) spans.push({ text: pending, color: template.textColor });
  return { spans };
}
