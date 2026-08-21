import { describe, expect, it } from 'vitest';
import type { EffectInstanceIR, RenderFrameIR } from '@joy-media/render-ir';
import { renderHeadlessFrame } from './index.js';

describe('headless renderer determinism', () => {
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
