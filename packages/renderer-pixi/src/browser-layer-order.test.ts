import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Pixi from 'pixi.js';
import { CanvasTextMetrics } from 'pixi.js';
import type { RenderFrameIR, RenderNode } from '@joy-media/render-ir';
import { createBrowserPixiRenderer } from './browser.js';

const harness = vi.hoisted(() => ({ stages: [] as unknown[] }));

vi.mock('pixi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Pixi>();
  class FakeApplication {
    readonly canvas = { width: 0, height: 0, style: { width: '', height: '' } };
    readonly stage = new actual.Container();
    readonly renderer = {
      resolution: 1,
      gl: { drawingBufferWidth: 1_000_000, drawingBufferHeight: 1_000_000 },
      resize: (width: number, height: number, resolution = 1): void => {
        this.canvas.width = Math.round(width * resolution);
        this.canvas.height = Math.round(height * resolution);
        this.renderer.resolution = resolution;
      },
      render: (): void => {},
    };
    async init(options: { width: number; height: number; resolution: number }): Promise<void> {
      this.renderer.resize(options.width, options.height, options.resolution);
      harness.stages.push(this.stage);
    }
    destroy(): void {}
  }
  return { ...actual, Application: FakeApplication };
});

const WHITE = { r: 255, g: 255, b: 255, a: 255 };

function textNode(id: string, zIndex = 0): RenderNode {
  return {
    kind: 'text',
    id,
    zIndex,
    opacity: 1,
    transform: { translateX: 100, translateY: 100, scaleX: 1, scaleY: 1 },
    text: id,
    color: WHITE,
  } satisfies RenderNode;
}

function frame(nodes: readonly RenderNode[]): RenderFrameIR {
  return {
    version: 1,
    compositionId: 'root',
    timeUs: 0,
    viewport: { width: 640, height: 360, dpr: 1 },
    background: { r: 0, g: 0, b: 0, a: 255 },
    nodes,
  };
}

/** The labels of the layers in draw order (child order), without the `text:` prefix. */
function layerOrder(): string[] {
  const stage = harness.stages.at(-1) as Pixi.Container;
  const layers = stage.getChildByLabel('renderer-pixi:layers', true);
  if (layers === null) throw new Error('the layers container was not created');
  return layers.children.map((child) => String(child.label ?? ''));
}

function stubTextMetrics(): void {
  vi.spyOn(CanvasTextMetrics, 'measureText').mockImplementation((text, style) => {
    const content = String(text ?? '');
    const fontSize = Number(style?.fontSize ?? 16);
    const width = [...content].length * fontSize * 0.5;
    return {
      text: content,
      style,
      width,
      height: fontSize * 1.2,
      lines: [content],
      lineWidths: [width],
      lineHeight: fontSize * 1.2,
      maxLineWidth: width,
      fontProperties: { ascent: fontSize * 0.8, descent: fontSize * 0.2, fontSize },
    } as unknown as ReturnType<typeof CanvasTextMetrics.measureText>;
  });
}

beforeEach(() => {
  harness.stages.length = 0;
  stubTextMetrics();
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('layers with the same zIndex draw in the frame order', () => {
  it('puts a layer that appears later under an overlay that was painted first (the Monitor video bug)', async () => {
    const renderer = await createBrowserPixiRenderer();
    // The Monitor paints the title first; the decoded video arrives a moment later and is listed first
    // (the video sits under the overlays).
    renderer.render(frame([textNode('title')]));
    expect(layerOrder()).toEqual(['layer:title']);
    renderer.render(frame([textNode('video'), textNode('title')]));
    expect(layerOrder()).toEqual(['layer:video', 'layer:title']);
    renderer.destroy();
  });

  it('follows a reordered frame and leaves an already ordered frame alone', async () => {
    const renderer = await createBrowserPixiRenderer();
    renderer.render(frame([textNode('a'), textNode('b'), textNode('c')]));
    expect(layerOrder()).toEqual(['layer:a', 'layer:b', 'layer:c']);
    renderer.render(frame([textNode('c'), textNode('a'), textNode('b')]));
    expect(layerOrder()).toEqual(['layer:c', 'layer:a', 'layer:b']);
    renderer.render(frame([textNode('c'), textNode('a'), textNode('b')]));
    expect(layerOrder()).toEqual(['layer:c', 'layer:a', 'layer:b']);
    renderer.destroy();
  });
});
