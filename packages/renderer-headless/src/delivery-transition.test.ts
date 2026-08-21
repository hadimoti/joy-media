import { describe, expect, it } from 'vitest';
import type { RenderFrameIR } from '@joy-media/render-ir';
import { renderHeadlessFrame } from './index.js';

describe('headless delivery transitions', () => {
  it('uses both transition clip identities and progress for deterministic delivery pixels', () => {
    const early = renderHeadlessFrame(frame(0.25, 'left', 'right')).pixels;
    const late = renderHeadlessFrame(frame(0.75, 'left', 'right')).pixels;
    const changedLeft = renderHeadlessFrame(frame(0.75, 'alternate-left', 'right')).pixels;
    const changedRight = renderHeadlessFrame(frame(0.75, 'left', 'alternate-right')).pixels;

    expect([...early]).not.toEqual([...late]);
    expect([...late]).not.toEqual([...changedLeft]);
    expect([...late]).not.toEqual([...changedRight]);
  });
});

function frame(progress: number, leftClipId: string, rightClipId: string): RenderFrameIR {
  return {
    version: 1,
    compositionId: 'delivery',
    timeUs: 1_000_000,
    viewport: { width: 2, height: 1, dpr: 1 },
    background: { r: 0, g: 0, b: 0, a: 255 },
    nodes: [
      {
        id: 'transition-1',
        kind: 'transition',
        zIndex: 0,
        opacity: 1,
        transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
        width: 2,
        height: 1,
        color: { r: 0, g: 0, b: 0, a: 0 },
        transitionType: 'dissolve',
        shaderId: 'dissolve',
        progress,
        leftClipId,
        rightClipId,
      },
    ],
  };
}
