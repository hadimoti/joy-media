/**
 * WP-11.1 real browser Pixi.js preview entry.
 *
 * Consumes {@link RenderFrameIR} and paints it onto a `<canvas>` via a
 * `pixi.js` Application. The Node software rasterizer in `./index.ts`
 * remains the parity reference; this module is browser-only and must never
 * be evaluated in a Node test build.
 *
 * Mapping:
 * - `sprite` / `video-frame` nodes → a `Graphics` rectangle of the node's
 *   intrinsic size filled with the evaluated color and alpha. Real texture
 *   loading lands when decode integration (WP-11.2) is wired in.
 * - `text` nodes → a `Text` object with fill color, the IR's `fontSizePx` /
 *   `maxWidth` constraints, and the resolved alignment. The IR does not
 *   currently expose rotation; the property is wired through so a future IR
 *   revision can populate it without an API change.
 * - `group` nodes are flattened by `flattenRenderNodes` before paint; the
 *   group transform is composed into each child's transform upstream.
 *
 * Re-rendering is incremental: layers are keyed by `node.id` and reused
 * across frames. Nodes that disappear from the frame are destroyed; nodes
 * that persist have their transform / opacity / zIndex updated in place.
 */

import { Application, Container, Graphics, Text } from 'pixi.js';
import type {
  Rgba,
  RenderFrameIR,
  SpriteNode,
  TextNode,
  VideoFrameNode,
  VisualRenderNode,
} from '@joy-media/render-ir';
import { flattenRenderNodes, validateRenderFrameIR } from '@joy-media/render-ir';

export const BROWSER_PACKAGE_ENTRY = '@joy-media/renderer-pixi/browser' as const;

export interface BrowserPixiRendererOptions {
  /** Element to append the Pixi canvas to. If omitted, the canvas is detached. */
  readonly parent?: HTMLElement;
  /** Initial canvas width in CSS pixels. The frame's viewport may resize it. */
  readonly width?: number;
  /** Initial canvas height in CSS pixels. The frame's viewport may resize it. */
  readonly height?: number;
  /** Device pixel ratio passed to Pixi. Defaults to the frame's `viewport.dpr`. */
  readonly resolution?: number;
  /** When true, Pixi auto-runs its render loop. Off by default for caller-driven frames. */
  readonly autoStart?: boolean;
  /** Renderer preference. WebGL is broadly supported; WebGPU is faster when available. */
  readonly preference?: 'webgl' | 'webgpu';
  /** Alpha passed to the Pixi clear color. `0` keeps the background transparent. */
  readonly backgroundAlpha?: number;
}

export interface BrowserPixiRenderStats {
  readonly width: number;
  readonly height: number;
  readonly drawCalls: number;
  /** Visual nodes that were reused rather than re-created this frame. */
  readonly reused: number;
  /** Visual nodes that were newly allocated this frame. */
  readonly created: number;
}

interface LayerContainer extends Container {
  /** Backing child: a `Graphics` for rects, a `Text` for text. */
  visual: Graphics | Text;
  /** Last kind observed for this layer — used to avoid reallocating on kind change. */
  kind: VisualRenderNode['kind'];
}

/**
 * Browser-side Pixi preview renderer. Construct via
 * {@link createBrowserPixiRenderer} because `Application.init` is async.
 */
export interface BrowserPixiRenderer {
  /** The HTML canvas element backing the Pixi Application. */
  readonly canvas: HTMLCanvasElement;
  /** Current canvas CSS width in pixels (tracks the last rendered frame). */
  readonly width: number;
  /** Current canvas CSS height in pixels (tracks the last rendered frame). */
  readonly height: number;
  /** Paints a {@link RenderFrameIR} into the canvas and returns per-frame stats. */
  render(frame: RenderFrameIR): BrowserPixiRenderStats;
  /** Tears down the Pixi Application and releases all GPU resources. */
  destroy(): void;
}

export async function createBrowserPixiRenderer(
  options: BrowserPixiRendererOptions = {},
): Promise<BrowserPixiRenderer> {
  const app = new Application();
  await app.init({
    width: options.width ?? 320,
    height: options.height ?? 180,
    resolution: options.resolution ?? 1,
    autoStart: options.autoStart ?? false,
    backgroundAlpha: options.backgroundAlpha ?? 0,
    preference: options.preference ?? 'webgl',
    // Without this, the WebGL drawing buffer clears itself after compositing
    // (visible on screen fine, but any programmatic read-back — toDataURL,
    // getImageData, a future thumbnail/screenshot feature — sees blank).
    preserveDrawingBuffer: true,
  });
  if (options.parent !== undefined) options.parent.appendChild(app.canvas);

  const background = new Graphics();
  background.label = 'renderer-pixi:background';
  background.zIndex = -1;
  app.stage.addChild(background);

  const layers = new Container();
  layers.label = 'renderer-pixi:layers';
  app.stage.addChild(layers);
  app.stage.sortableChildren = true;

  const spriteMap = new Map<string, LayerContainer>();
  let frameWidth = options.width ?? 320;
  let frameHeight = options.height ?? 180;
  let disposed = false;

  const assertAlive = (): void => {
    if (disposed) throw new Error(`${BROWSER_PACKAGE_ENTRY}: renderer has been destroyed`);
  };

  const resize = (width: number, height: number, resolution: number): void => {
    frameWidth = width;
    frameHeight = height;
    app.renderer.resize(width, height, resolution);
  };

  const paintRectVisual = (node: SpriteNode | VideoFrameNode): Graphics => {
    const graphic = new Graphics();
    graphic
      .rect(0, 0, node.width, node.height)
      .fill({ color: rgbaToHex(node.color), alpha: node.color.a / 255 });
    graphic.label = `${node.kind}:${node.id}`;
    return graphic;
  };

  const paintTextVisual = (node: TextNode): Text => {
    const text = new Text({
      text: node.text,
      style: {
        fill: rgbaToHexString(node.color),
        fontSize: node.fontSizePx ?? 16,
        ...(node.maxWidth !== undefined ? { wordWrap: true, wordWrapWidth: node.maxWidth } : {}),
      },
    });
    text.label = `text:${node.id}`;
    applyTextAlignment(text, node);
    // TODO(WP-11.x): paint a background plate behind the text when
    // `node.background` is set. Requires a layout pass to size the plate to
    // the rendered text width/height; deferred until caption-plate UX lands.
    return text;
  };

  const applyTextAlignment = (text: Text, node: TextNode): void => {
    const align = node.align ?? 'left';
    if (align === 'center') text.anchor.set(0.5, 0);
    else if (align === 'right') text.anchor.set(1, 0);
    else text.anchor.set(0, 0);
  };

  const updateLayerTransform = (layer: LayerContainer, node: VisualRenderNode): void => {
    layer.position.set(node.transform.translateX, node.transform.translateY);
    layer.scale.set(node.transform.scaleX, node.transform.scaleY);
    // `Transform2D` does not currently carry rotation; wired through so a
    // future IR revision can populate it without an API change.
    layer.rotation = 0;
    layer.alpha = node.opacity;
    layer.zIndex = node.zIndex;
  };

  const createLayer = (node: VisualRenderNode): LayerContainer => {
    const container = new Container() as LayerContainer;
    container.label = `layer:${node.id}`;
    container.zIndex = node.zIndex;
    const visual = node.kind === 'text' ? paintTextVisual(node) : paintRectVisual(node);
    container.addChild(visual);
    container.visual = visual;
    container.kind = node.kind;
    updateLayerTransform(container, node);
    return container;
  };

  const paint = (frame: RenderFrameIR): Omit<BrowserPixiRenderStats, 'width' | 'height'> => {
    const drawNodes = flattenRenderNodes(frame.nodes)
      .map((node, index) => ({ node, index }))
      .sort((a, b) => a.node.zIndex - b.node.zIndex || a.index - b.index);
    const seen = new Set<string>();
    let drawCalls = 0;
    let created = 0;
    let reused = 0;
    for (const { node } of drawNodes) {
      seen.add(node.id);
      const existing = spriteMap.get(node.id);
      if (existing === undefined) {
        const layer = createLayer(node);
        layers.addChild(layer);
        spriteMap.set(node.id, layer);
        created += 1;
      } else {
        if (existing.kind !== node.kind) {
          existing.visual.destroy();
          const visual = node.kind === 'text' ? paintTextVisual(node) : paintRectVisual(node);
          existing.addChild(visual);
          existing.visual = visual;
          existing.kind = node.kind;
        }
        updateLayerTransform(existing, node);
        reused += 1;
      }
      drawCalls += 1;
    }
    for (const [id, layer] of spriteMap) {
      if (!seen.has(id)) {
        layer.destroy({ children: true });
        spriteMap.delete(id);
      }
    }
    return { drawCalls, created, reused };
  };

  return {
    get canvas() {
      return app.canvas;
    },
    get width() {
      return frameWidth;
    },
    get height() {
      return frameHeight;
    },
    render(frame: RenderFrameIR): BrowserPixiRenderStats {
      assertAlive();
      validateRenderFrameIR(frame);
      const { width, height, dpr } = frame.viewport;
      const resolution = options.resolution ?? dpr;
      resize(width, height, resolution);
      background
        .clear()
        .rect(0, 0, width, height)
        .fill({ color: rgbaToHex(frame.background), alpha: frame.background.a / 255 });
      const { drawCalls, created, reused } = paint(frame);
      if (options.autoStart !== true) app.renderer.render(app.stage);
      return { width: frameWidth, height: frameHeight, drawCalls, created, reused };
    },
    destroy(): void {
      if (disposed) return;
      disposed = true;
      spriteMap.clear();
      app.destroy(true, { children: true, texture: true });
    },
  };
}

function rgbaToHex(color: Rgba): number {
  return ((color.r & 0xff) << 16) | ((color.g & 0xff) << 8) | (color.b & 0xff);
}

function rgbaToHexString(color: Rgba): string {
  const toHex = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}
