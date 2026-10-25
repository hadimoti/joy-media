import type {
  FontFaceDescriptorV1,
  ScenePaintFrameV1,
  ScenePaintLineV1,
  TitleInstanceV1,
} from '@joy-media/project-schema';
import { P0_PAINT_POLICY, P0_TEMPLATES } from './catalog.js';
import { sampleTitleMotion } from './motion.js';

export interface TitleSceneFrameInput {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly fontFaces?: readonly FontFaceDescriptorV1[];
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
  readonly paint: ScenePaintFrameV1;
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
  frame: TitleSceneFrameInput,
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
  const template = P0_TEMPLATES[instance.templateId];
  const selectedFace = frame.fontFaces?.find(
    (face) =>
      face.family === instance.font.family &&
      face.weight === instance.font.weight &&
      face.sha256 === instance.font.sha256,
  );
  if (!selectedFace) {
    throw new RangeError(
      `missing verified font face ${instance.font.family} weight ${instance.font.weight} sha256 ${instance.font.sha256}`,
    );
  }
  const slideReserve =
    instance.motion.presetId === 'joy-slide-up' ? P0_PAINT_POLICY.slideExcursionPx : 0;
  const secondaryLineHeight = Math.round(
    instance.layout.secondarySizePx * P0_PAINT_POLICY.lineHeightMultiplier,
  );
  const anchorX =
    template.alignment === 'center'
      ? instance.placement.xPx + instance.placement.maxWidthPx / 2
      : instance.placement.xPx + template.plate.paddingX;
  const lineY = instance.placement.yPx + template.plate.paddingY + motion.translateYPx;
  const faceRef = Object.freeze({
    family: selectedFace.family,
    weight: selectedFace.weight,
    subset: selectedFace.subset,
  });
  const lines: ScenePaintLineV1[] = [
    ...paintLines.primary.map((text, index) =>
      Object.freeze({
        text,
        font: `${instance.font.weight} ${instance.layout.fontSizePx}px "${instance.font.family}"`,
        colour: P0_PAINT_POLICY.textColour,
        direction: instance.direction,
        align: template.alignment,
        x: anchorX,
        y: lineY + index * instance.layout.lineHeightPx,
        height: instance.layout.lineHeightPx,
        opacity: motion.opacity,
        face: faceRef,
      }),
    ),
    ...paintLines.secondary.map((text, index) =>
      Object.freeze({
        text,
        font: `${instance.font.weight} ${instance.layout.secondarySizePx}px "${instance.font.family}"`,
        colour: P0_PAINT_POLICY.textColour,
        direction: instance.direction,
        align: template.alignment,
        x: anchorX,
        y:
          lineY +
          paintLines.primary.length * instance.layout.lineHeightPx +
          index * secondaryLineHeight,
        height: secondaryLineHeight,
        opacity: motion.opacity,
        face: faceRef,
      }),
    ),
  ];
  const paint: ScenePaintFrameV1 = Object.freeze({
    width: frame.widthPx,
    height: frame.heightPx,
    rects:
      template.plate.kind === 'translucent-rectangle'
        ? Object.freeze([
            Object.freeze({
              x: instance.placement.xPx,
              y: instance.placement.yPx + motion.translateYPx,
              width: instance.placement.maxWidthPx,
              height: instance.layout.boxHeightPx - slideReserve,
              colour: P0_PAINT_POLICY.plateColour,
              opacity: P0_PAINT_POLICY.plateOpacity * motion.opacity,
            }),
          ])
        : Object.freeze([]),
    lines: Object.freeze(lines),
    fonts: Object.freeze([
      Object.freeze({
        family: selectedFace.family,
        weight: selectedFace.weight,
        subset: selectedFace.subset,
        sha256: selectedFace.sha256,
        length: selectedFace.length,
      }),
    ]),
  });
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
    paint,
    frameRate: Object.freeze(frame.frameRate ?? { num: 30, den: 1 }),
    locale: frame.locale ?? 'en',
    seed: frame.seed ?? instanceId,
  });
}
