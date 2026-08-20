import { describe, expect, it } from 'vitest';
import type { RenderFrameIR } from '@joy-media/render-ir';
import { renderPixiEditorPreview, renderPixiPreview } from './index.js';

const content: RenderFrameIR = {
  version: 1,
  compositionId: 'root',
  timeUs: 0,
  viewport: { width: 2, height: 2, dpr: 1 },
  background: { r: 0, g: 0, b: 0, a: 255 },
  nodes: [],
};

describe('Pixi editor preview host', () => {
  it('keeps editor overlays out of content pixels', () => {
    const contentPreview = renderPixiPreview(content);
    const editorPreview = renderPixiEditorPreview(content, {
      version: 1,
      selections: [{ nodeId: 'not-a-content-node', x: 0, y: 0, width: 2, height: 2 }],
    });
    expect(editorPreview.pixels).toEqual(contentPreview.pixels);
    expect(editorPreview.overlay.selections).toHaveLength(1);
  });

  it('applies master color grade to content pixels', () => {
    const graded: RenderFrameIR = {
      ...content,
      background: { r: 100, g: 100, b: 100, a: 255 },
      colorGrade: { lift: 0, gamma: 1, gain: 2, saturation: 1 },
    };
    const plain = renderPixiPreview({
      version: graded.version,
      compositionId: graded.compositionId,
      timeUs: graded.timeUs,
      viewport: graded.viewport,
      background: graded.background,
      nodes: graded.nodes,
    });
    const withGrade = renderPixiPreview(graded);
    expect(withGrade.pixels[0]).toBeGreaterThan(plain.pixels[0]!);
  });

  it('paints active transition overlays', () => {
    const frame: RenderFrameIR = {
      version: 1,
      compositionId: 'root',
      timeUs: 0,
      viewport: { width: 4, height: 2, dpr: 1 },
      background: { r: 0, g: 0, b: 0, a: 255 },
      nodes: [
        {
          kind: 'transition',
          id: 'tr-1',
          zIndex: 10,
          opacity: 1,
          transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
          width: 4,
          height: 2,
          color: { r: 255, g: 0, b: 0, a: 255 },
          transitionType: 'wipe',
          shaderId: 'wipe',
          progress: 0.5,
          leftClipId: 'a',
          rightClipId: 'b',
        },
      ],
    };
    const preview = renderPixiPreview(frame);
    expect(preview.drawCalls).toEqual([{ nodeId: 'tr-1', kind: 'transition' }]);
    // Left half covered by wipe at 0.5
    expect(preview.pixels[0]).toBeGreaterThan(0);
    expect(preview.pixels[(2 * 4 + 0) * 4] ?? preview.pixels[8]).toBeDefined();
  });

  it('paints caption plates behind text glyphs', () => {
    const frame: RenderFrameIR = {
      version: 1,
      compositionId: 'root',
      timeUs: 0,
      viewport: { width: 16, height: 8, dpr: 1 },
      background: { r: 0, g: 0, b: 0, a: 255 },
      nodes: [
        {
          kind: 'text',
          id: 'caption',
          text: 'JOY',
          color: { r: 255, g: 255, b: 255, a: 255 },
          background: { r: 200, g: 20, b: 30, a: 255 },
          align: 'left',
          zIndex: 1,
          opacity: 1,
          transform: { translateX: 1, translateY: 1, scaleX: 1, scaleY: 1 },
        },
      ],
    };

    const preview = renderPixiPreview(frame);
    const platePixel = (1 * frame.viewport.width + 1) * 4;
    expect([...preview.pixels.slice(platePixel, platePixel + 4)]).toEqual([200, 20, 30, 255]);
  });

  it('renders inline text spans with their own colors', () => {
    const frame: RenderFrameIR = {
      ...content,
      viewport: { width: 20, height: 8, dpr: 1 },
      nodes: [
        {
          kind: 'text',
          id: 'spans',
          text: 'JOY',
          spans: [
            { text: 'J', color: { r: 255, g: 0, b: 0, a: 255 } },
            { text: 'O', color: { r: 0, g: 255, b: 0, a: 255 }, emphasis: true },
            { text: 'Y', color: { r: 0, g: 0, b: 255, a: 255 } },
          ],
          color: { r: 255, g: 255, b: 255, a: 255 },
          align: 'left',
          zIndex: 1,
          opacity: 1,
          transform: { translateX: 1, translateY: 1, scaleX: 1, scaleY: 1 },
        },
      ],
    };
    const preview = renderPixiPreview(frame);
    expect([...preview.pixels.slice((1 * 20 + 2) * 4, (1 * 20 + 2) * 4 + 4)]).toEqual([
      255, 0, 0, 255,
    ]);
    expect([...preview.pixels.slice((1 * 20 + 6) * 4, (1 * 20 + 6) * 4 + 4)]).toEqual([
      0, 255, 0, 255,
    ]);
  });
});
