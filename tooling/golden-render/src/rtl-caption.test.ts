import { describe, expect, it } from 'vitest';
import { layoutTemplatedCaptionNodes, rtlStressCues } from '@joy-media/captions-core';
import type { RenderFrameIR, TextNode } from '@joy-media/render-ir';
import { compareGoldenFrame } from './index.js';

describe('P03.4 Persian/RTL caption stress fixtures', () => {
  it('keeps mixed-script, emoji, and long Persian captions inside safe areas in both render paths', () => {
    const nodes = layoutTemplatedCaptionNodes(rtlStressCues(), {
      viewportWidth: 320,
      viewportHeight: 180,
    }) as readonly TextNode[];
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.map((node) => node.text).join(' ')).toContain('سلام JOY 👋 دنیا');
    expect(nodes.some((node) => node.direction === 'rtl' && node.align === 'right')).toBe(true);
    expect(
      nodes.every((node) => node.transform.translateX >= 0 && node.transform.translateX <= 320),
    ).toBe(true);
    expect(
      nodes.every((node) => node.transform.translateY >= 0 && node.transform.translateY <= 180),
    ).toBe(true);
    expect(
      nodes.every(
        (node) =>
          node.spans === undefined || node.spans.map((span) => span.text).join('') === node.text,
      ),
    ).toBe(true);
    const frame: RenderFrameIR = {
      version: 1,
      compositionId: 'rtl-caption-stress',
      timeUs: 1_000_000,
      viewport: { width: 320, height: 180, dpr: 1 },
      background: { r: 0, g: 0, b: 0, a: 255 },
      nodes,
    };
    expect(compareGoldenFrame(frame).identical).toBe(true);
  });
});
