import { describe, expect, it } from 'vitest';
import { layoutTemplatedCaptionNodes, rtlStressCues } from '@joy-media/captions-core';
import type { CaptionCue } from '@joy-media/captions-core';
import type { CaptionDocumentV1 } from '@joy-media/project-schema';
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

  it('preserves karaoke word colours across wrapped lines in both reference renderers', () => {
    const document: CaptionDocumentV1 = {
      id: 'karaoke-doc',
      language: 'en-US',
      direction: 'ltr',
      styleRef: 'joy-karaoke-pop',
      speakers: [],
      words: {
        w1: { id: 'w1', text: 'JOY', startUs: 0, endUs: 500_000 },
        w2: { id: 'w2', text: 'makes', startUs: 500_000, endUs: 1_000_000 },
        w3: { id: 'w3', text: 'captions', startUs: 1_000_000, endUs: 1_500_000 },
        w4: { id: 'w4', text: 'sing', startUs: 1_500_000, endUs: 2_000_000 },
        w5: { id: 'w5', text: 'really', startUs: 2_000_000, endUs: 2_500_000 },
        w6: { id: 'w6', text: 'well', startUs: 2_500_000, endUs: 3_000_000 },
      },
      segments: [
        {
          id: 'karaoke-segment',
          startUs: 0,
          endUs: 3_000_000,
          wordIds: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'],
        },
      ],
    };
    const cue: CaptionCue = {
      clipId: 'karaoke-clip',
      documentId: document.id,
      document,
      segment: document.segments[0]!,
      documentTimeUs: 250_000,
    };
    const nodes = layoutTemplatedCaptionNodes([cue], {
      viewportWidth: 320,
      viewportHeight: 180,
    }) as readonly TextNode[];
    expect(nodes.map((node) => node.text)).toEqual(['really well', 'JOY makes captions sing']);
    const activeLine = nodes.find((node) => node.spans !== undefined)!;
    expect(activeLine.spans!.map((span) => span.text).join('')).toBe(activeLine.text);
    expect(activeLine.spans).toEqual([
      { text: 'JOY', color: { r: 233, g: 185, b: 73, a: 255 }, emphasis: true },
      { text: ' makes captions sing', color: { r: 255, g: 255, b: 255, a: 255 } },
    ]);

    const frame: RenderFrameIR = {
      version: 1,
      compositionId: 'karaoke-active-word',
      timeUs: 250_000,
      viewport: { width: 320, height: 180, dpr: 1 },
      background: { r: 0, g: 0, b: 0, a: 255 },
      nodes,
    };
    const pixi = renderPixiPreview(frame);
    const headless = renderHeadlessFrame(frame);
    const amber = [233, 185, 73, 255];
    const hasAmberPixel = (pixels: Uint8Array): boolean => {
      for (let index = 0; index < pixels.length; index += 4) {
        if (
          pixels[index] === amber[0] &&
          pixels[index + 1] === amber[1] &&
          pixels[index + 2] === amber[2] &&
          pixels[index + 3] === amber[3]
        )
          return true;
      }
      return false;
    };
    expect(hasAmberPixel(pixi.pixels)).toBe(true);
    expect(hasAmberPixel(headless.pixels)).toBe(true);
    expect(pixi.pixels).toEqual(headless.pixels);
    expect(compareGoldenFrame(frame).identical).toBe(true);
  });

  it('keeps the no-span and one-span headless paths unchanged', () => {
    const oneSpanFrame: RenderFrameIR = {
      version: 1,
      compositionId: 'single-span-noop',
      timeUs: 0,
      viewport: { width: 80, height: 20, dpr: 1 },
      background: { r: 0, g: 0, b: 0, a: 255 },
      nodes: [
        {
          kind: 'text',
          id: 'plain',
          text: 'JOY',
          color: { r: 255, g: 255, b: 255, a: 255 },
          zIndex: 1,
          opacity: 1,
          transform: { translateX: 10, translateY: 2, scaleX: 1, scaleY: 1 },
        },
        {
          kind: 'text',
          id: 'one-span',
          text: 'JOY',
          color: { r: 255, g: 255, b: 255, a: 255 },
          spans: [{ text: 'JOY', color: { r: 230, g: 40, b: 50, a: 255 } }],
          zIndex: 1,
          opacity: 1,
          transform: { translateX: 10, translateY: 2, scaleX: 1, scaleY: 1 },
        },
      ],
    };
    const nodes = oneSpanFrame.nodes;
    expect(compareGoldenFrame({ ...oneSpanFrame, nodes: [nodes[0]!] }).identical).toBe(true);
    expect(compareGoldenFrame({ ...oneSpanFrame, nodes: [nodes[1]!] }).identical).toBe(true);
    expect(renderHeadlessFrame({ ...oneSpanFrame, nodes: [nodes[0]!] }).pixels).toEqual(
      renderHeadlessFrame({ ...oneSpanFrame, nodes: [nodes[1]!] }).pixels,
    );
  });
});
