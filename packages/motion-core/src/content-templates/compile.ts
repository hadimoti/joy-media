import type { FontChoice, P0TemplateId, TitleInstanceV1 } from '@joy-media/project-schema';
import { P0_TEMPLATES, templateSha256 } from './catalog.js';

export interface TitleCompileRequest {
  readonly instanceId: string;
  readonly templateId: string;
  readonly clipId: string;
  readonly objectId: string;
  readonly lines: { readonly primary: string; readonly secondary: string };
  readonly direction: 'ltr' | 'rtl' | 'auto';
  readonly font: FontChoice;
  readonly fontSha256: string;
  readonly placement: {
    readonly xPx: number;
    readonly yPx: number;
    readonly maxWidthPx: number;
    readonly safeInsetPx: number;
  };
  readonly motion: {
    readonly presetId: 'joy-fade-in' | 'joy-slide-up' | 'hold';
    readonly inUs: number;
    readonly outUs: number;
  };
  readonly clipDurationUs: number;
  /** Composition frame in pixels; the title box must stay inside its safe area. */
  readonly frame: { readonly widthPx: number; readonly heightPx: number };
}

export type TitleCompileErrorCode =
  | 'ID_CONFLICT'
  | 'TEMPLATE_UNSUPPORTED'
  | 'FONT_UNAVAILABLE'
  | 'PRIMARY_REQUIRED'
  | 'RANGE_ERROR'
  | 'TEXT_OVERFLOW';
export type TitleCompileResult =
  | { readonly ok: true; readonly instance: TitleInstanceV1 }
  | { readonly ok: false; readonly code: TitleCompileErrorCode; readonly message: string };
export type TextMeasure = (text: string, fontSizePx: number, weight: 400 | 700) => number;

function failure(code: TitleCompileErrorCode, message: string): TitleCompileResult {
  return { ok: false, code, message };
}

function wrap(
  text: string,
  size: number,
  limit: number,
  maxLines: number,
  measure: TextMeasure,
  weight: 400 | 700,
): string[] | undefined {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, size, weight) <= limit) {
      line = candidate;
      continue;
    }
    if (!line) return undefined;
    lines.push(line);
    line = word;
    if (measure(line, size, weight) > limit || lines.length >= maxLines) return undefined;
  }
  if (line) lines.push(line);
  return lines.length <= maxLines ? lines : undefined;
}

export function compileTitleInstance(
  request: TitleCompileRequest,
  measure: TextMeasure,
): TitleCompileResult {
  const objectId = `object-${request.instanceId}`;
  const clipId = `clip-${request.instanceId}`;
  if (request.objectId !== objectId || request.clipId !== clipId)
    return failure('ID_CONFLICT', 'objectId and clipId must be derived from instanceId');
  if (request.templateId !== 'joy.p0.lower-third' && request.templateId !== 'joy.p0.title')
    return failure('TEMPLATE_UNSUPPORTED', 'templateId is unsupported');
  if (
    request.font.family !== 'Noto Sans Arabic' ||
    (request.font.weight !== 400 && request.font.weight !== 700)
  )
    return failure('FONT_UNAVAILABLE', 'font family or weight is unavailable');
  if (request.lines.primary.trim().length === 0)
    return failure('PRIMARY_REQUIRED', 'primary text is required');
  if (
    !Number.isSafeInteger(request.clipDurationUs) ||
    request.clipDurationUs < 0 ||
    !Number.isSafeInteger(request.motion.inUs) ||
    !Number.isSafeInteger(request.motion.outUs) ||
    request.motion.inUs < 0 ||
    request.motion.outUs < 0 ||
    request.motion.inUs + request.motion.outUs > request.clipDurationUs
  )
    return failure('RANGE_ERROR', 'motion windows must fit within clip duration');

  const { widthPx: frameWidth, heightPx: frameHeight } = request.frame;
  if (
    !Number.isSafeInteger(frameWidth) ||
    !Number.isSafeInteger(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0
  ) {
    return failure('RANGE_ERROR', 'frame size must be positive integers');
  }

  const template = P0_TEMPLATES[request.templateId as P0TemplateId];
  const availableWidth =
    request.placement.maxWidthPx - request.placement.safeInsetPx - template.plate.paddingX;
  if (!(availableWidth > 0))
    return failure('TEXT_OVERFLOW', 'no width remains after safe inset and template padding');
  let primaryLines: string[] | undefined;
  let fontSizePx = 0;
  for (
    let size = template.primary.maxSizePx;
    size >= template.primary.minSizePx;
    size -= template.primary.stepPx
  ) {
    const wrapped = wrap(
      request.lines.primary,
      size,
      availableWidth,
      template.primary.maxLines,
      measure,
      request.font.weight,
    );
    if (wrapped !== undefined) {
      primaryLines = wrapped;
      fontSizePx = size;
      break;
    }
  }
  let secondaryLines: string[] | undefined;
  let secondarySizePx = template.secondary.maxSizePx;
  if (request.lines.secondary.trim().length === 0) secondaryLines = [];
  else
    for (
      let size = template.secondary.maxSizePx;
      size >= template.secondary.minSizePx;
      size -= template.secondary.stepPx
    ) {
      const wrapped = wrap(
        request.lines.secondary,
        size,
        availableWidth,
        template.secondary.maxLines,
        measure,
        request.font.weight,
      );
      if (wrapped !== undefined) {
        secondaryLines = wrapped;
        secondarySizePx = size;
        break;
      }
    }
  if (primaryLines === undefined || secondaryLines === undefined)
    return failure('TEXT_OVERFLOW', 'text does not fit at the minimum supported size');

  const lineHeightPx = Math.round(fontSizePx * 1.25);
  const secondaryLineHeight = Math.round(secondarySizePx * 1.25);
  // Include the full 80px entrance excursion for slide-up in the reserved height.
  const slideReserve = request.motion.presetId === 'joy-slide-up' ? 80 : 0;
  const boxHeightPx =
    primaryLines.length * lineHeightPx +
    secondaryLines.length * secondaryLineHeight +
    template.plate.paddingY +
    slideReserve;
  // The box, including the slide excursion, must stay inside the frame's safe area.
  const { xPx, yPx, maxWidthPx, safeInsetPx: inset } = request.placement;
  if (
    xPx < inset ||
    yPx < inset ||
    xPx + maxWidthPx > frameWidth - inset ||
    yPx + boxHeightPx > frameHeight - inset
  ) {
    return failure('TEXT_OVERFLOW', 'the title box does not fit inside the frame safe area');
  }
  const instance: TitleInstanceV1 = {
    templateId: request.templateId as P0TemplateId,
    templateVersion: 1,
    templateSha256: templateSha256(request.templateId as P0TemplateId),
    compilerVersion: 1,
    objectId,
    clipId,
    lines: { primary: request.lines.primary, secondary: request.lines.secondary },
    font: { family: request.font.family, weight: request.font.weight, sha256: request.fontSha256 },
    direction: request.direction,
    placement: { ...request.placement },
    motion: { ...request.motion },
    layout: {
      primaryLines,
      secondaryLines,
      fontSizePx,
      secondarySizePx,
      lineHeightPx,
      boxHeightPx,
    },
  };
  return { ok: true, instance };
}
