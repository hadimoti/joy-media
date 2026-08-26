import { describe, expect, it } from 'vitest';
import type { EffectInstanceIR, RenderFrameIR } from '@joy-media/render-ir';
import { renderHeadlessFrame } from './index.js';

describe('headless renderer determinism', () => {
  it('composes static position, scale, opacity, rotation, and z-order for image/text nodes', () => {
    const frame: RenderFrameIR = {
      version: 1,
      compositionId: 'transform-regression',
      timeUs: 0,
      viewport: { width: 12, height: 12, dpr: 1 },
      background: { r: 0, g: 0, b: 0, a: 255 },
      nodes: [
        {
          kind: 'sprite',
          id: 'image',
          zIndex: 1,
          opacity: 0.5,
          transform: { translateX: 3, translateY: 3, scaleX: 2, scaleY: 2, rotationDeg: 90 },
          width: 2,
          height: 2,
          color: { r: 255, g: 0, b: 0, a: 255 },
        },
        {
          kind: 'text',
          id: 'text',
          zIndex: 2,
          opacity: 1,
          transform: { translateX: 3, translateY: 3, scaleX: 1, scaleY: 1, rotationDeg: 90 },
          text: 'A',
          color: { r: 0, g: 255, b: 0, a: 255 },
        },
      ],
    };
    const rendered = renderHeadlessFrame(frame).pixels;
    expect([...rendered].some((value, index) => index % 4 === 0 && value > 0 && value < 255)).toBe(
      true,
    );
    expect([...rendered].some((value, index) => index % 4 === 1 && value > 0)).toBe(true);
  });

  it.each(['noise', 'grain'] as const)('%s uses a repeatable frame/effect seed', (kind) => {
    const frame = makeFrame({
      id: `${kind}-node`,
      effect: { id: `${kind}-effect`, kind, enabled: true, params: { amount: 0.18 } },
      timeUs: 0,
    });

    const first = renderHeadlessFrame(frame);
    const second = renderHeadlessFrame(frame);
    const shifted = renderHeadlessFrame({ ...frame, timeUs: 33_333 });

    expect(first.pixels).toEqual(second.pixels);
    expect(first.pixels).not.toEqual(shifted.pixels);
  });
});

function makeFrame(input: { id: string; effect: EffectInstanceIR; timeUs: number }): RenderFrameIR {
  return {
    version: 1,
    compositionId: 'comp-1',
    timeUs: input.timeUs,
    viewport: { width: 8, height: 8, dpr: 1 },
    background: { r: 0, g: 0, b: 0, a: 255 },
    nodes: [
      {
        id: input.id,
        kind: 'sprite',
        zIndex: 0,
        opacity: 1,
        width: 8,
        height: 8,
        color: { r: 120, g: 160, b: 200, a: 255 },
        transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
        effects: [input.effect],
      },
    ],
  };
}
