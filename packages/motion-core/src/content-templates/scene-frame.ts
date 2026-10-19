import type { TitleInstanceV1 } from '@joy-media/project-schema';
import { sampleTitleMotion } from './motion.js';

export interface TitleSceneFrameInput {
  readonly frameRate?: { readonly num: number; readonly den: number };
  readonly locale?: string;
  readonly seed?: string;
}
export interface TitleSceneFrame {
  readonly instanceId: string;
  readonly templateId: TitleInstanceV1['templateId'];
  readonly timeUs: number;
  readonly durationUs: number;
  readonly variables: Readonly<Record<string, string | number | boolean>>;
  readonly markup: string;
  readonly paintLines: Readonly<{ primary: readonly string[]; secondary: readonly string[] }>;
  readonly motion: ReturnType<typeof sampleTitleMotion>;
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly frameRate: Readonly<{ num: number; den: number }>;
  readonly locale: string;
  readonly seed: string;
}

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/gu,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

export function buildTitleSceneFrame(
  instance: TitleInstanceV1,
  instanceId: string,
  durationUs: number,
  localTimeUs: number,
  frame: TitleSceneFrameInput & { readonly widthPx: number; readonly heightPx: number },
): TitleSceneFrame {
  if (!Number.isSafeInteger(durationUs) || durationUs < 0 || !Number.isSafeInteger(localTimeUs))
    throw new RangeError(
      'title frame time must use non-negative safe integer duration and integer local time',
    );
  const paintLines = Object.freeze({
    primary: Object.freeze([...instance.layout.primaryLines]),
    secondary: Object.freeze([...instance.layout.secondaryLines]),
  });
  const motion = sampleTitleMotion(instance.motion, durationUs, localTimeUs);
  const markup = `<div class="joy-p0-title" dir="${instance.direction}" style="position:absolute;left:${instance.placement.xPx}px;top:${instance.placement.yPx + motion.translateYPx}px;width:${instance.placement.maxWidthPx}px;opacity:${motion.opacity};font-family:'Noto Sans Arabic',sans-serif;font-weight:${instance.font.weight};text-align:${instance.templateId === 'joy.p0.title' ? 'center' : 'left'}"><div class="primary">${paintLines.primary.map(escapeHtml).join('<br>')}</div><div class="secondary">${paintLines.secondary.map(escapeHtml).join('<br>')}</div></div>`;
  return Object.freeze({
    instanceId,
    templateId: instance.templateId,
    timeUs: localTimeUs,
    durationUs,
    variables: Object.freeze({
      primaryText: instance.lines.primary,
      secondaryText: instance.lines.secondary,
      direction: instance.direction,
      weight: instance.font.weight,
    }),
    markup,
    paintLines,
    motion,
    viewport: Object.freeze({ width: frame.widthPx, height: frame.heightPx }),
    frameRate: Object.freeze(frame.frameRate ?? { num: 30, den: 1 }),
    locale: frame.locale ?? 'en',
    seed: frame.seed ?? instanceId,
  });
}
