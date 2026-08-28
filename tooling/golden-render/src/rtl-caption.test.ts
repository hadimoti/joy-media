import { describe, expect, it } from 'vitest';
import { layoutTemplatedCaptionNodes, rtlStressCues } from '@joy-media/captions-core';
import { visualTextGlyphs } from '@joy-media/render-ir';
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
    // RTL visual ordering reverses Arabic runs and the run order while keeping
    // the embedded Latin brand and emoji in their own readable direction.
    expect(
      visualTextGlyphs('سلام JOY 👋 دنیا', 'rtl')
        .map((glyph) => glyph.character)
        .join(''),
    ).toBe('ایند JOY 👋 مالس');
    expect(
      visualTextGlyphs('سلام JOY 👋 دنیا', 'ltr')
        .map((glyph) => glyph.character)
        .join(''),
    ).toBe('مالس JOY 👋 ایند');
    for (const node of nodes) {
      const glyphWidth = Math.max(4, Math.round((node.fontSizePx ?? 0) / 12));
      const renderedWidth = [...node.text].length * glyphWidth;
      expect(renderedWidth).toBeLessThanOrEqual(node.maxWidth ?? 0);
      const left =
        node.align === 'right'
          ? node.transform.translateX - renderedWidth
          : node.align === 'center'
            ? node.transform.translateX - renderedWidth / 2
            : node.transform.translateX;
      const right = left + renderedWidth;
      expect(left).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(320);
    }
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

  it('uses Unicode bidi ordering for punctuation, numbers, and adjacent scripts', () => {
    const parenthesized = visualTextGlyphs('سلام(JOY)', 'rtl');
    expect(parenthesized.map((glyph) => glyph.character).join('')).toBe('(JOY)مالس');
    expect(parenthesized.map((glyph) => glyph.sourceIndex)).toEqual([8, 5, 6, 7, 4, 3, 2, 1, 0]);
    expect(
      visualTextGlyphs('سلام123', 'rtl')
        .map((glyph) => glyph.character)
        .join(''),
    ).toBe('123مالس');
    expect(
      visualTextGlyphs('abcשלום', 'ltr')
        .map((glyph) => glyph.character)
        .join(''),
    ).toBe('abcםולש');
  });
});
