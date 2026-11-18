import { describe, expect, it } from 'vitest';
import { layoutTemplatedCaptionNodes, rtlStressCues } from '@joy-media/captions-core';
import type { RenderFrameIR, TextNode } from '@joy-media/render-ir';
import { renderHeadlessFrame } from '@joy-media/renderer-headless';
import { renderPixiPreview } from '@joy-media/renderer-pixi';
import { compareGoldenFrame } from './index.js';

describe('P03.4 Persian/RTL caption stress fixtures', () => {
  it('keeps mixed-script, emoji, and long Persian captions inside safe areas in both render paths', () => {
    const nodes = layoutTemplatedCaptionNodes(rtlStressCues(), {
      viewportWidth: 320,
      viewportHeight: 180,
    }) as readonly TextNode[];
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.map((node) => node.text).join(' ')).toContain('سلام JOY 👋 دنیا');
    expect(
      nodes.some(
        (node) =>
          node.direction === 'rtl' && node.align === 'start' && node.transform.translateX > 160,
      ),
    ).toBe(true);
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

  it('uses the first paragraph direction for text plates in both reference renderers', () => {
    const frame: RenderFrameIR = {
      version: 1,
      compositionId: 'mixed-paragraph-direction',
      timeUs: 0,
      viewport: { width: 80, height: 12, dpr: 1 },
      background: { r: 0, g: 0, b: 0, a: 255 },
      nodes: [
        {
          kind: 'text',
          id: 'mixed-paragraphs',
          text: '日本語\nسلام',
          direction: 'auto',
          align: 'start',
          color: { r: 255, g: 255, b: 255, a: 255 },
          background: { r: 220, g: 30, b: 40, a: 255 },
          zIndex: 1,
          opacity: 1,
          transform: { translateX: 48, translateY: 2, scaleX: 1, scaleY: 1 },
        },
      ],
    };
    const pixi = renderPixiPreview(frame);
    const headless = renderHeadlessFrame(frame);
    const pixelAt = (pixels: Uint8Array, x: number, y: number) => [
      ...pixels.slice((y * frame.viewport.width + x) * 4, (y * frame.viewport.width + x) * 4 + 4),
    ];

    expect(pixelAt(pixi.pixels, 16, 1)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(headless.pixels, 16, 1)).toEqual([0, 0, 0, 255]);
    expect(compareGoldenFrame(frame).identical).toBe(true);
  });
});
