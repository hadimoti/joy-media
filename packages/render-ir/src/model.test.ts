import { describe, expect, it } from 'vitest';
import type { RenderFrameIR } from './model.js';
import { flattenRenderNodes, validateRenderFrameIR } from './model.js';

const frame: RenderFrameIR = {
  version: 1,
  compositionId: 'root',
  timeUs: 0,
  viewport: { width: 4, height: 4, dpr: 1 },
  background: { r: 0, g: 0, b: 0, a: 255 },
  nodes: [
    {
      kind: 'sprite',
      id: 'image',
      zIndex: 0,
      opacity: 1,
      transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
      width: 1,
      height: 1,
      color: { r: 255, g: 0, b: 0, a: 255 },
    },
  ],
};

describe('RenderFrameIR', () => {
  it('accepts the minimal evaluated frame', () => {
    expect(() => validateRenderFrameIR(frame)).not.toThrow();
  });

  it('rejects duplicated node identities at the renderer boundary', () => {
    expect(() =>
      validateRenderFrameIR({ ...frame, nodes: [...frame.nodes, frame.nodes[0]!] }),
    ).toThrow(/unique/);
  });

  it('flattens group transforms for renderer adapters while keeping overlays out of content IR', () => {
    const grouped: RenderFrameIR = {
      ...frame,
      nodes: [
        {
          kind: 'group',
          id: 'group',
          zIndex: 0,
          opacity: 0.5,
          transform: { translateX: 2, translateY: 3, scaleX: 2, scaleY: 2 },
          children: [
            {
              ...frame.nodes[0]!,
              transform: { translateX: 1, translateY: 1, scaleX: 1, scaleY: 1 },
            },
          ],
        },
      ],
    };
    validateRenderFrameIR(grouped);
    expect(flattenRenderNodes(grouped.nodes)).toMatchObject([
      {
        id: 'image',
        opacity: 0.5,
        transform: { translateX: 4, translateY: 5, scaleX: 2, scaleY: 2 },
      },
    ]);
  });
});
