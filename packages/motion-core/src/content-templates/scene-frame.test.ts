import { describe, expect, it } from 'vitest';
import type { FontFaceDescriptorV1, TitleInstanceV1 } from '@joy-media/project-schema';
import { P0_TEMPLATES, compileTitleInstance } from './index.js';
import { P0_PAINT_POLICY } from './catalog.js';
import { buildTitleSceneFrame } from './scene-frame.js';
import type { TitleSceneFrameInput } from './scene-frame.js';

const measure = (text: string, size: number) => [...text].length * size * 0.45;
const fontSha256 = `sha256:${'a'.repeat(64)}`;
const fontFaces: readonly FontFaceDescriptorV1[] = [
  { family: 'Noto Sans Arabic', weight: 700, subset: 'latin', sha256: fontSha256, length: 1234 },
];

function compile(
  templateId: TitleInstanceV1['templateId'],
  presetId: 'joy-fade-in' | 'joy-slide-up',
) {
  const result = compileTitleInstance(
    {
      instanceId: templateId === 'joy.p0.lower-third' ? 'lower' : 'title',
      templateId,
      clipId: `clip-${templateId === 'joy.p0.lower-third' ? 'lower' : 'title'}`,
      objectId: `object-${templateId === 'joy.p0.lower-third' ? 'lower' : 'title'}`,
      lines: { primary: 'Hello world', secondary: 'Welcome' },
      direction: 'ltr',
      font: { family: 'Noto Sans Arabic', weight: 700 },
      fontSha256,
      placement: { xPx: 40, yPx: 50, maxWidthPx: 600, safeInsetPx: 8 },
      motion: { presetId, inUs: 200_000, outUs: 200_000 },
      clipDurationUs: 1_000_000,
      frame: { widthPx: 1280, heightPx: 720 },
    },
    measure,
  );
  if (!result.ok) throw new Error(`test fixture failed to compile: ${result.message}`);
  return result.instance;
}

function paintInput(
  instance: TitleInstanceV1,
): TitleSceneFrameInput & { widthPx: number; heightPx: number } {
  return { widthPx: 1280, heightPx: 720, fontFaces, locale: 'en-US', seed: 'scene-seed' };
}

describe('P0 title scene paint frame', () => {
  it('declares complete P0 paint policy without changing compiled layouts', () => {
    expect(P0_PAINT_POLICY).toMatchObject({
      textColour: '#ffffff',
      plateColour: '#000000',
      plateOpacity: 153 / 255,
      lineHeightMultiplier: 1.25,
      slideExcursionPx: 80,
      easedHandles: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
    });

    const lower = compile('joy.p0.lower-third', 'joy-slide-up');
    const title = compile('joy.p0.title', 'joy-fade-in');
    expect(lower.layout).toMatchObject({
      primaryLines: ['Hello world'],
      secondaryLines: ['Welcome'],
      fontSizePx: 48,
      secondarySizePx: 30,
      lineHeightPx: 60,
      boxHeightPx: 202,
    });
    expect(title.layout).toMatchObject({
      primaryLines: ['Hello world'],
      secondaryLines: ['Welcome'],
      fontSizePx: 48,
      secondarySizePx: 30,
      lineHeightPx: 60,
      boxHeightPx: 98,
    });
    expect(P0_TEMPLATES['joy.p0.lower-third'].plate).toEqual({
      kind: 'translucent-rectangle',
      paddingX: 48,
      paddingY: 24,
    });
    expect(P0_TEMPLATES['joy.p0.title'].plate.kind).toBe('transparent');
  });

  it('builds catalog-derived title geometry and motion', () => {
    for (const [templateId, presetId] of [
      ['joy.p0.lower-third', 'joy-slide-up'],
      ['joy.p0.title', 'joy-fade-in'],
    ] as const) {
      const instance = compile(templateId, presetId);
      const frame = buildTitleSceneFrame(
        instance,
        'fixture',
        1_000_000,
        100_000,
        paintInput(instance),
      );
      const template = P0_TEMPLATES[templateId];
      const midpoint = 0.5;
      const handles = P0_PAINT_POLICY.easedHandles;
      const easedMidpoint =
        3 * (1 - midpoint) ** 2 * midpoint * handles.y1 +
        3 * (1 - midpoint) * midpoint ** 2 * handles.y2 +
        midpoint ** 3;
      const incoming = easedMidpoint;
      const exitStart = 1_000_000 - instance.motion.outUs;
      const outgoing = 100_000 <= exitStart ? 1 : 1 - easedMidpoint;
      const opacity = Math.max(0, Math.min(1, incoming * outgoing));
      const translationY =
        presetId === 'joy-slide-up' ? P0_PAINT_POLICY.slideExcursionPx * (1 - incoming) : 0;
      const expectedX =
        template.alignment === 'center'
          ? instance.placement.xPx + instance.placement.maxWidthPx / 2
          : instance.placement.xPx + template.plate.paddingX;
      const expectedTextLines = [
        ...instance.layout.primaryLines.map((text, index) => ({
          text,
          x: expectedX,
          y:
            instance.placement.yPx +
            template.plate.paddingY +
            translationY +
            index * instance.layout.lineHeightPx,
          height: instance.layout.lineHeightPx,
          font: `700 ${instance.layout.fontSizePx}px "Noto Sans Arabic"`,
          colour: '#ffffff',
          direction: instance.direction,
          align: template.alignment,
          opacity,
          face: { family: instance.font.family, weight: instance.font.weight, subset: 'latin' },
        })),
        ...instance.layout.secondaryLines.map((text, index) => ({
          text,
          x: expectedX,
          y:
            instance.placement.yPx +
            template.plate.paddingY +
            translationY +
            instance.layout.primaryLines.length * instance.layout.lineHeightPx +
            index *
              Math.round(instance.layout.secondarySizePx * P0_PAINT_POLICY.lineHeightMultiplier),
          height: Math.round(
            instance.layout.secondarySizePx * P0_PAINT_POLICY.lineHeightMultiplier,
          ),
          font: `700 ${instance.layout.secondarySizePx}px "Noto Sans Arabic"`,
          colour: '#ffffff',
          direction: instance.direction,
          align: template.alignment,
          opacity,
          face: { family: instance.font.family, weight: instance.font.weight, subset: 'latin' },
        })),
      ];

      expect(frame.paint.lines).toEqual(expectedTextLines);
      expect(frame.paint.rects).toEqual(
        template.plate.kind === 'translucent-rectangle'
          ? [
              {
                x: instance.placement.xPx,
                y: instance.placement.yPx + translationY,
                width: instance.placement.maxWidthPx,
                height: instance.layout.boxHeightPx - P0_PAINT_POLICY.slideExcursionPx,
                colour: '#000000',
                opacity: (153 / 255) * opacity,
              },
            ]
          : [],
      );
      expect(frame.paint.fonts).toEqual(fontFaces);
      expect(frame.paint).toMatchObject({ width: 1280, height: 720 });
      expect(frame).toMatchObject({ locale: 'en-US', seed: 'scene-seed' });
    }
  });

  it('names the requested face when no verified descriptor matches', () => {
    const instance = compile('joy.p0.title', 'joy-fade-in');
    expect(() =>
      buildTitleSceneFrame(instance, 'fixture', 1_000_000, 100_000, {
        widthPx: 1280,
        heightPx: 720,
        fontFaces: [],
      }),
    ).toThrowError(
      new RangeError(`missing verified font face Noto Sans Arabic weight 700 sha256 ${fontSha256}`),
    );
  });
});
