import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Pixi from 'pixi.js';
import type { RenderFrameIR } from '@joy-media/render-ir';
import { createBrowserPixiRenderer } from './browser.js';

/**
 * The real Pixi Application needs a GPU context, which a Node test does not
 * have. Every other Pixi class stays real; only the Application is replaced by
 * a stand-in whose canvas backing store follows `renderer.resize(w, h, r)`
 * exactly like Pixi's (w * r by h * r device pixels).
 */
const harness = vi.hoisted(() => ({
  /** Largest drawing buffer the fake browser hands out (per side). */
  maxDrawingBuffer: Number.POSITIVE_INFINITY,
  renders: 0,
}));

vi.mock('pixi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Pixi>();
  class FakeApplication {
    readonly canvas = { width: 0, height: 0, style: { width: '', height: '' } };
    readonly stage = new actual.Container();
    readonly renderer = {
      resolution: 1,
      gl: {
        get drawingBufferWidth(): number {
          return 0;
        },
        get drawingBufferHeight(): number {
          return 0;
        },
      },
      resize: (width: number, height: number, resolution = 1): void => {
        this.canvas.width = Math.round(width * resolution);
        this.canvas.height = Math.round(height * resolution);
        this.renderer.resolution = resolution;
      },
      render: (): void => {
        harness.renders += 1;
      },
    };
    constructor() {
      const canvas = this.canvas;
      Object.defineProperty(this.renderer, 'gl', {
        value: {
          get drawingBufferWidth(): number {
            return Math.min(canvas.width, harness.maxDrawingBuffer);
          },
          get drawingBufferHeight(): number {
            return Math.min(canvas.height, harness.maxDrawingBuffer);
          },
        },
      });
    }
    async init(options: { width: number; height: number; resolution: number }): Promise<void> {
      this.renderer.resize(options.width, options.height, options.resolution);
    }
    destroy(): void {}
  }
  return { ...actual, Application: FakeApplication };
});

const frame = (width: number, height: number): RenderFrameIR => ({
  version: 1,
  compositionId: 'root',
  timeUs: 0,
  viewport: { width, height, dpr: 1 },
  background: { r: 0, g: 0, b: 0, a: 255 },
  nodes: [],
});

beforeEach(() => {
  harness.maxDrawingBuffer = Number.POSITIVE_INFINITY;
  harness.renders = 0;
});

describe('export safety (ADR-0046 B7)', () => {
  it('keeps the export canvas at the composition width after another renderer calls setPixelScale(4)', async () => {
    const monitor = await createBrowserPixiRenderer({ resolution: 0.25 });
    monitor.setPixelScale(4);
    monitor.setView({ zoom: 2, panX: -300, panY: -100 }, { width: 800, height: 450 });
    monitor.render(frame(1920, 1080));
    expect(monitor.canvas.width).toBe(800 * 4);

    // Same construction as the export path in App.tsx.
    const exporter = await createBrowserPixiRenderer({ width: 1920, height: 1080, resolution: 1 });
    exporter.render(frame(1920, 1080));
    expect(exporter.canvas.width).toBe(1920);
    expect(exporter.canvas.height).toBe(1080);
    expect(exporter.resolution).toBe(1);

    // Further monitor changes still do not leak into the export instance.
    monitor.setPixelScale(8);
    monitor.render(frame(1920, 1080));
    exporter.render(frame(1920, 1080));
    expect(exporter.canvas.width).toBe(1920);
    monitor.destroy();
    exporter.destroy();
  });

  it('without a pixel scale or view, renders exactly as before: authored size, resolution clamped to [0.1, 2]', async () => {
    const renderer = await createBrowserPixiRenderer({ resolution: 3 });
    const stats = renderer.render(frame(1080, 1920));
    expect(stats.width).toBe(1080);
    expect(stats.height).toBe(1920);
    expect(renderer.resolution).toBe(2);
    expect(renderer.canvas.width).toBe(2160);
    renderer.destroy();
  });
});

describe('setPixelScale', () => {
  it('wins over options.resolution and is not clamped to 2', async () => {
    const renderer = await createBrowserPixiRenderer({ resolution: 0.25 });
    renderer.render(frame(1000, 500));
    expect(renderer.canvas.width).toBe(250);
    renderer.setPixelScale(3);
    expect(renderer.resolution).toBe(3);
    expect(renderer.canvas.width).toBe(3000);
    renderer.render(frame(1000, 500));
    expect(renderer.canvas.width).toBe(3000);
    renderer.setPixelScale(0.5);
    renderer.render(frame(1000, 500));
    expect(renderer.canvas.width).toBe(500);
    renderer.destroy();
  });

  it('keeps the 0.1 floor and returns to options.resolution when cleared', async () => {
    const renderer = await createBrowserPixiRenderer({ resolution: 0.5 });
    renderer.render(frame(1000, 500));
    renderer.setPixelScale(0.01);
    expect(renderer.resolution).toBeCloseTo(0.1, 12);
    renderer.setPixelScale(undefined);
    expect(renderer.resolution).toBe(0.5);
    expect(renderer.canvas.width).toBe(500);
    renderer.destroy();
  });

  it('falls back when the browser shrinks the drawing buffer', async () => {
    harness.maxDrawingBuffer = 4096;
    const renderer = await createBrowserPixiRenderer({ resolution: 1 });
    renderer.render(frame(1920, 1080));
    renderer.setPixelScale(4);
    expect(renderer.canvas.width).toBeLessThanOrEqual(4096);
    expect(renderer.resolution).toBeCloseTo(4096 / 1920, 6);
    renderer.destroy();
  });

  it('does not redraw when the scale does not change', async () => {
    const renderer = await createBrowserPixiRenderer();
    renderer.render(frame(100, 100));
    renderer.setPixelScale(2);
    const before = harness.renders;
    renderer.setPixelScale(2);
    expect(harness.renders).toBe(before);
    renderer.destroy();
  });
});

describe('setView (Monitor only)', () => {
  it('keeps the canvas the size of the panel and draws the frame through the view', async () => {
    const renderer = await createBrowserPixiRenderer({ resolution: 1 });
    renderer.setPixelScale(1.25 * 0.5);
    renderer.setView({ zoom: 3, panX: -1200, panY: -40 }, { width: 640, height: 360 });
    const stats = renderer.render(frame(1080, 1920));
    // The stats and the IR stay the authored frame.
    expect(stats.width).toBe(1080);
    expect(stats.height).toBe(1920);
    // Backing store = panel size x pixel scale, whatever the zoom.
    expect(renderer.canvas.width).toBe(Math.round(640 * 0.625));
    expect(renderer.canvas.height).toBe(Math.round(360 * 0.625));
    expect(renderer.canvas.style.width).toBe('640px');
    expect(renderer.canvas.style.height).toBe('360px');
    renderer.destroy();
  });

  it('a zoom change does not change the backing store size', async () => {
    const renderer = await createBrowserPixiRenderer();
    renderer.setPixelScale(2);
    renderer.setView({ zoom: 0.1, panX: 0, panY: 0 }, { width: 500, height: 300 });
    renderer.render(frame(1920, 1080));
    const small = renderer.canvas.width;
    renderer.setView({ zoom: 8, panX: -9000, panY: -4000 }, { width: 500, height: 300 });
    expect(renderer.canvas.width).toBe(small);
    expect(renderer.canvas.width).toBe(1000);
    renderer.destroy();
  });

  it('returns to the authored size when the view is cleared', async () => {
    const renderer = await createBrowserPixiRenderer({ resolution: 1 });
    renderer.setView({ zoom: 2, panX: 10, panY: 10 }, { width: 300, height: 200 });
    renderer.render(frame(1280, 720));
    expect(renderer.canvas.width).toBe(300);
    renderer.setView(undefined);
    expect(renderer.canvas.width).toBe(1280);
    expect(renderer.canvas.style.width).toBe('');
    renderer.destroy();
  });
});
