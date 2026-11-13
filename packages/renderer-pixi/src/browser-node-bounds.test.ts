import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Pixi from 'pixi.js';
import type { RenderFrameIR, RenderNode, Transform2D } from '@joy-media/render-ir';
import { textPlateBounds } from '@joy-media/render-ir';
import { createBrowserPixiRenderer } from './browser.js';

/**
 * T-M15 `nodeBounds(id)` on the browser renderer. As in
 * `browser-monitor-view.test.ts`, the Pixi Application (it needs a GPU) is a
 * stand-in. `Text` is a stand-in too, because measuring glyphs needs a
 * browser canvas: it measures 10 px per character and 20 px high. Every
 * other Pixi class (Container, Graphics) is real, so the layer transforms
 * checked below are Pixi's own maths.
 */
const harness = vi.hoisted(() => ({ stages: [] as unknown[] }));

const CHAR_WIDTH = 10;
const LINE_HEIGHT = 20;

vi.mock('pixi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Pixi>();
  class FakeApplication {
    readonly canvas = { width: 0, height: 0, style: { width: '', height: '' } };
    readonly stage = new actual.Container();
    readonly renderer = {
      resolution: 1,
      resize: (width: number, height: number, resolution = 1): void => {
        this.canvas.width = Math.round(width * resolution);
        this.canvas.height = Math.round(height * resolution);
      },
      render: (): void => {},
    };
    async init(options: { width: number; height: number; resolution: number }): Promise<void> {
      this.renderer.resize(options.width, options.height, options.resolution);
      harness.stages.push(this.stage);
    }
    destroy(): void {}
  }
  class FakeText extends actual.Container {
    text = '';
    style: unknown = {};
    readonly anchor = {
      x: 0,
      y: 0,
      set(x: number, y: number): void {
        this.x = x;
        this.y = y;
      },
    };
    override get width(): number {
      return this.text.length * CHAR_WIDTH;
    }
    override set width(_value: number) {}
    override get height(): number {
      return LINE_HEIGHT;
    }
    override set height(_value: number) {}
  }
  return { ...actual, Application: FakeApplication, Text: FakeText };
});

const WHITE = { r: 255, g: 255, b: 255, a: 255 };

function frame(nodes: readonly RenderNode[]): RenderFrameIR {
  return {
    version: 1,
    compositionId: 'root',
    timeUs: 0,
    viewport: { width: 1080, height: 1920, dpr: 1 },
    background: { r: 0, g: 0, b: 0, a: 255 },
    nodes,
  };
}

const at = (translateX: number, translateY: number, scale = 1): Transform2D => ({
  translateX,
  translateY,
  scaleX: scale,
  scaleY: scale,
});

/** One node per element kind, shaped as `visualObjectToRenderNode`, the editor and captions build them. */
const kinds = {
  // VisualObject kind 'text' (align 'center').
  text: {
    kind: 'text',
    id: 'text-1',
    zIndex: 0,
    opacity: 1,
    transform: at(540, 300),
    text: 'Hello',
    color: WHITE,
    align: 'center',
    fontSizePx: 48,
  },
  // A burned-in caption line (`caption:<clip>:<segment>:line<n>`), with its plate.
  caption: {
    kind: 'text',
    id: 'caption:clip-cc:seg-1:line0',
    zIndex: 900,
    opacity: 1,
    transform: at(540, 1700),
    text: 'Burned in',
    color: WHITE,
    align: 'center',
    fontSizePx: 50,
    background: { r: 0, g: 0, b: 0, a: 160 },
  },
  // VisualObject kind 'shape': a fixed 100x100 sprite.
  shape: {
    kind: 'sprite',
    id: 'shape-1',
    zIndex: 0,
    opacity: 1,
    transform: { translateX: 100, translateY: 200, scaleX: 2, scaleY: 0.5 },
    width: 100,
    height: 100,
    color: WHITE,
  },
  // VisualObject kind 'image' with a known size: a video-frame of the picture's size.
  image: {
    kind: 'video-frame',
    id: 'image-1',
    zIndex: 10,
    opacity: 1,
    transform: at(10, 20, 0.5),
    width: 800,
    height: 600,
    sourceTimeUs: 0,
    color: { r: 0, g: 0, b: 0, a: 0 },
  },
  // A timeline video clip: keyed by its clip id, the media's size.
  video: {
    kind: 'video-frame',
    id: 'clip-video-1',
    zIndex: 0,
    opacity: 1,
    transform: at(0, 656, 0.5625),
    width: 1920,
    height: 1080,
    sourceTimeUs: 1_000_000,
    color: { r: 0, g: 0, b: 0, a: 255 },
  },
  // VisualObject kind 'html-scene' (the 3D element): a fixed 1080x1920 video-frame.
  scene3d: {
    kind: 'video-frame',
    id: 'scene-3d-1',
    zIndex: 0,
    opacity: 1,
    transform: at(0, 0),
    width: 1080,
    height: 1920,
    sourceTimeUs: 0,
    color: { r: 0, g: 0, b: 0, a: 0 },
  },
} satisfies Record<string, RenderNode>;

/** Expected unrotated aabb for each kind (authored pixels). */
const expected = {
  text: { x: 540 - 25, y: 300, width: 50, height: 20 },
  // Plate padding = max(2, round(50 * 0.12)) = 6.
  caption: { x: 540 - 45 - 6, y: 1700 - 6, width: 90 + 12, height: 20 + 12 },
  shape: { x: 100, y: 200, width: 200, height: 50 },
  image: { x: 10, y: 20, width: 400, height: 300 },
  video: { x: 0, y: 656, width: 1080, height: 607.5 },
  scene3d: { x: 0, y: 0, width: 1080, height: 1920 },
} as const;

/** Finds the layer container the renderer made for a node id. */
function layerOf(id: string): Pixi.Container {
  const stage = harness.stages[harness.stages.length - 1] as Pixi.Container;
  const found = stage.getChildByLabel(`layer:${id}`, true);
  if (found === null) throw new Error(`no layer for ${id}`);
  return found;
}

beforeEach(() => {
  harness.stages.length = 0;
});

describe('nodeBounds without rotation', () => {
  it.each(Object.keys(kinds) as (keyof typeof kinds)[])(
    'returns the drawn box of a %s node',
    async (kind) => {
      const renderer = await createBrowserPixiRenderer();
      const node = kinds[kind];
      renderer.render(frame([node]));
      const bounds = renderer.nodeBounds(node.id)!;
      expect(bounds).toBeDefined();
      expect(bounds.id).toBe(node.id);
      expect(bounds.rotationDeg).toBe(0);
      expect(bounds.aabb).toEqual(expected[kind]);
      expect(bounds.width).toBe(expected[kind].width);
      expect(bounds.height).toBe(expected[kind].height);
      expect(bounds.corners[0]).toEqual({ x: expected[kind].x, y: expected[kind].y });
      // Placement is exactly the old one: position = translate, no pivot, no rotation.
      const layer = layerOf(node.id);
      expect(layer.position.x).toBe(node.transform.translateX);
      expect(layer.position.y).toBe(node.transform.translateY);
      expect(layer.pivot.x).toBe(0);
      expect(layer.pivot.y).toBe(0);
      expect(layer.rotation).toBe(0);
      renderer.destroy();
    },
  );

  it('finds every node of a frame with all kinds, and nothing for unknown or removed ids', async () => {
    const renderer = await createBrowserPixiRenderer();
    renderer.render(frame(Object.values(kinds)));
    for (const node of Object.values(kinds)) expect(renderer.nodeBounds(node.id)).toBeDefined();
    expect(renderer.nodeBounds('nope')).toBeUndefined();
    renderer.render(frame([kinds.shape]));
    expect(renderer.nodeBounds(kinds.text.id)).toBeUndefined();
    expect(renderer.nodeBounds(kinds.shape.id)).toBeDefined();
    renderer.destroy();
    expect(renderer.nodeBounds(kinds.shape.id)).toBeUndefined();
  });

  it('is in authored pixels: the Monitor view does not change it', async () => {
    const renderer = await createBrowserPixiRenderer();
    renderer.setView({ zoom: 3, panX: -500, panY: 40 }, { width: 600, height: 400 });
    renderer.render(frame([kinds.shape]));
    expect(renderer.nodeBounds(kinds.shape.id)!.aabb).toEqual(expected.shape);
    renderer.destroy();
  });
});

describe('nodeBounds and drawing with rotation', () => {
  it.each(Object.keys(kinds) as (keyof typeof kinds)[])(
    'a rotated %s node turns about its centre, and the box matches what Pixi draws',
    async (kind) => {
      const renderer = await createBrowserPixiRenderer();
      const base = kinds[kind];
      const node = { ...base, transform: { ...base.transform, rotationDeg: 30 } } as RenderNode;
      renderer.render(frame([node]));
      const bounds = renderer.nodeBounds(node.id)!;
      const plain = expected[kind];
      // The centre stays put, the size of the box is kept, the aabb is the turned box's.
      expect(bounds.center.x).toBeCloseTo(plain.x + plain.width / 2, 6);
      expect(bounds.center.y).toBeCloseTo(plain.y + plain.height / 2, 6);
      expect(bounds.width).toBeCloseTo(plain.width, 9);
      expect(bounds.height).toBeCloseTo(plain.height, 9);
      expect(bounds.rotationDeg).toBe(30);
      const cos = Math.cos(Math.PI / 6);
      const sin = Math.sin(Math.PI / 6);
      expect(bounds.aabb.width).toBeCloseTo(plain.width * cos + plain.height * sin, 6);
      expect(bounds.aabb.height).toBeCloseTo(plain.width * sin + plain.height * cos, 6);
      // Pixi's own layer matrix maps the local box corners onto the reported corners.
      const layer = layerOf(node.id);
      layer.updateLocalTransform();
      const scaleX = node.transform.scaleX;
      const scaleY = node.transform.scaleY;
      const local = [
        { x: plain.x, y: plain.y },
        { x: plain.x + plain.width, y: plain.y },
        { x: plain.x + plain.width, y: plain.y + plain.height },
        { x: plain.x, y: plain.y + plain.height },
      ].map((point) => ({
        x: (point.x - node.transform.translateX) / scaleX,
        y: (point.y - node.transform.translateY) / scaleY,
      }));
      local.forEach((point, index) => {
        const drawn = layer.localTransform.apply(point);
        expect(drawn.x).toBeCloseTo(bounds.corners[index]!.x, 6);
        expect(drawn.y).toBeCloseTo(bounds.corners[index]!.y, 6);
      });
      renderer.destroy();
    },
  );

  it('the origin is the pivot: a top-left origin keeps the top-left corner in place', async () => {
    const renderer = await createBrowserPixiRenderer();
    const node = {
      ...kinds.shape,
      transform: { ...kinds.shape.transform, rotationDeg: 90, origin: { x: 0, y: 0 } },
    };
    renderer.render(frame([node]));
    const bounds = renderer.nodeBounds(node.id)!;
    expect(bounds.origin).toEqual({ x: 100, y: 200 });
    expect(bounds.corners[0].x).toBeCloseTo(100, 9);
    expect(bounds.corners[0].y).toBeCloseTo(200, 9);
    // 200 wide (scaled) swings down; 50 high swings left.
    expect(bounds.aabb.x).toBeCloseTo(50, 9);
    expect(bounds.aabb.y).toBeCloseTo(200, 9);
    expect(bounds.aabb.width).toBeCloseTo(50, 9);
    expect(bounds.aabb.height).toBeCloseTo(200, 9);
    renderer.destroy();
  });

  it('clips a rotated image to its crop and reports the cropped box', async () => {
    const renderer = await createBrowserPixiRenderer();
    const crop = { left: 0.25, top: 0.1, right: 0.25, bottom: 0.1 };
    const node = {
      ...kinds.image,
      transform: { ...kinds.image.transform, rotationDeg: 90, crop } as Transform2D,
    };
    renderer.render(frame([node]));

    const bounds = renderer.nodeBounds(node.id)!;
    expect(bounds.width).toBe(200);
    expect(bounds.height).toBe(240);
    expect(bounds.center).toEqual({ x: 210, y: 170 });
    expect(bounds.aabb.x).toBeCloseTo(90, 9);
    expect(bounds.aabb.y).toBeCloseTo(70, 9);
    expect(bounds.aabb.width).toBeCloseTo(240, 9);
    expect(bounds.aabb.height).toBeCloseTo(200, 9);

    const layer = layerOf(node.id);
    expect(layer.mask).toBeDefined();
    const mask = layer.mask as Pixi.Graphics;
    expect(mask.getLocalBounds()).toMatchObject({ x: 200, y: 60, width: 400, height: 480 });

    // Resetting a reused layer to the old zero-crop transform removes the mask.
    renderer.render(frame([kinds.image]));
    expect(layer.mask).toBeFalsy();
    expect(renderer.nodeBounds(node.id)!.aabb).toEqual(expected.image);
    renderer.destroy();
  });

  it('turning back to 0 restores the old placement on a reused layer', async () => {
    const renderer = await createBrowserPixiRenderer();
    const turned = { ...kinds.shape, transform: { ...kinds.shape.transform, rotationDeg: 45 } };
    renderer.render(frame([turned]));
    expect(layerOf(kinds.shape.id).rotation).not.toBe(0);
    renderer.render(frame([kinds.shape]));
    const layer = layerOf(kinds.shape.id);
    expect(layer.rotation).toBe(0);
    expect(layer.pivot.x).toBe(0);
    expect(layer.position.x).toBe(100);
    expect(layer.position.y).toBe(200);
    expect(renderer.nodeBounds(kinds.shape.id)!.aabb).toEqual(expected.shape);
    renderer.destroy();
  });

  it('text bounds follow the alignment (left, centre, right)', async () => {
    const renderer = await createBrowserPixiRenderer();
    for (const align of ['left', 'center', 'right'] as const) {
      const node = { ...kinds.text, id: `t-${align}`, align };
      renderer.render(frame([node]));
      const box = textPlateBounds(50, LINE_HEIGHT, align);
      expect(renderer.nodeBounds(node.id)!.aabb).toEqual({
        x: 540 + box.x,
        y: 300,
        width: 50,
        height: LINE_HEIGHT,
      });
    }
    renderer.destroy();
  });
});
