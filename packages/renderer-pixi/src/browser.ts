/**
 * WP-11.1 real browser Pixi.js preview entry.
 *
 * Consumes {@link RenderFrameIR} and paints it onto a `<canvas>` via a
 * `pixi.js` Application. The Node software rasterizer in `./index.ts`
 * remains the parity reference; this module is browser-only and must never
 * be evaluated in a Node test build.
 *
 * Mapping:
 * - `sprite` nodes → a `Graphics` rectangle of the node's intrinsic size
 *   filled with the evaluated color and alpha.
 * - `video-frame` nodes → a Pixi `Sprite` backed by the separately supplied
 *   decoded RGBA buffer, or the same color rectangle when no buffer is
 *   available. Pixels deliberately stay outside RenderFrameIR: the IR remains
 *   serializable and renderer-neutral while this browser adapter owns the
 *   transient GPU texture.
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

import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type {
  Rgba,
  RenderFrameIR,
  SpriteNode,
  TextNode,
  TransitionNode,
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

/** Structural browser-safe mirror of a decoded RGBA frame. */
export interface BrowserVideoFrameBitmap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

interface LayerContainer extends Container {
  /** Backing child: a `Graphics` for rects, a `Sprite` for decoded video, or `Text`. */
  visual: Graphics | Sprite | Text;
  /** Last kind observed for this layer — used to avoid reallocating on kind change. */
  kind: VisualRenderNode['kind'];
  /** Persistent CPU canvas and GPU texture for a decoded video node. */
  videoCanvas?: HTMLCanvasElement | undefined;
  videoTexture?: Texture | undefined;
  /** Persistent GPU texture for a transition node. */
  transitionTexture?: Texture | undefined;
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
  render(
    frame: RenderFrameIR,
    videoBitmaps?: ReadonlyMap<string, BrowserVideoFrameBitmap>,
  ): BrowserPixiRenderStats;
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

  const transitionLayer = new Container();
  transitionLayer.label = 'renderer-pixi:transitions';
  app.stage.addChild(transitionLayer);
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

  const paintRectVisual = (node: Exclude<VisualRenderNode, { kind: 'text' }>): Graphics => {
    const graphic = new Graphics();
    graphic
      .rect(0, 0, node.width, node.height)
      .fill({ color: rgbaToHex(node.color), alpha: node.color.a / 255 });
    graphic.label = `${node.kind}:${node.id}`;
    return graphic;
  };

  const paintVideoVisual = (
    node: VideoFrameNode,
    bitmap: BrowserVideoFrameBitmap,
  ): Pick<LayerContainer, 'visual' | 'videoCanvas' | 'videoTexture'> => {
    const canvas = document.createElement('canvas');
    const texture = Texture.from(canvas, true);
    const sprite = new Sprite(texture);
    sprite.label = `video-frame:${node.id}`;
    const layer = { visual: sprite, videoCanvas: canvas, videoTexture: texture };
    updateVideoTexture(layer, node, bitmap);
    return layer;
  };

  const updateVideoTexture = (
    layer: Pick<LayerContainer, 'visual' | 'videoCanvas' | 'videoTexture'>,
    node: VideoFrameNode,
    bitmap: BrowserVideoFrameBitmap,
  ): void => {
    const canvas = layer.videoCanvas;
    const texture = layer.videoTexture;
    if (canvas === undefined || texture === undefined || !(layer.visual instanceof Sprite)) return;
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    const context = canvas.getContext('2d');
    if (context === null)
      throw new Error(`${BROWSER_PACKAGE_ENTRY}: unable to create video texture canvas`);
    const image = context.createImageData(bitmap.width, bitmap.height);
    image.data.set(bitmap.data);
    context.putImageData(image, 0, 0);
    texture.source.update();
    layer.visual.width = node.width;
    layer.visual.height = node.height;
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

  const createLayer = (
    node: VisualRenderNode,
    videoBitmap: BrowserVideoFrameBitmap | undefined,
  ): LayerContainer => {
    const container = new Container() as LayerContainer;
    container.label = `layer:${node.id}`;
    container.zIndex = node.zIndex;
    if (node.kind === 'video-frame' && videoBitmap !== undefined) {
      const video = paintVideoVisual(node, videoBitmap);
      container.addChild(video.visual);
      container.visual = video.visual;
      container.videoCanvas = video.videoCanvas;
      container.videoTexture = video.videoTexture;
    } else {
      const visual = node.kind === 'text' ? paintTextVisual(node) : paintRectVisual(node);
      container.addChild(visual);
      container.visual = visual;
    }
    container.kind = node.kind;
    updateLayerTransform(container, node);
    return container;
  };

  const replaceVisual = (layer: LayerContainer, visual: Graphics | Sprite | Text): void => {
    layer.visual.destroy();
    layer.removeChildren();
    layer.addChild(visual);
    layer.visual = visual;
    layer.videoCanvas = undefined;
    layer.videoTexture = undefined;
  };

  const paint = (
    frame: RenderFrameIR,
    videoBitmaps: ReadonlyMap<string, BrowserVideoFrameBitmap>,
  ): Omit<BrowserPixiRenderStats, 'width' | 'height'> => {
    const drawNodes = flattenRenderNodes(frame.nodes)
      .map((node, index) => ({ node, index }))
      .sort((a, b) => a.node.zIndex - b.node.zIndex || a.index - b.index);
    const seen = new Set<string>();
    let drawCalls = 0;
    let created = 0;
    let reused = 0;
    const transitionNodes: Array<{ node: TransitionNode; index: number }> = [];
    for (const { node, index } of drawNodes) {
      if (node.kind === 'transition') {
        transitionNodes.push({ node, index });
        continue;
      }
      seen.add(node.id);
      const existing = spriteMap.get(node.id);
      const videoBitmap = node.kind === 'video-frame' ? videoBitmaps.get(node.id) : undefined;
      if (existing === undefined) {
        const layer = createLayer(node, videoBitmap);
        layers.addChild(layer);
        spriteMap.set(node.id, layer);
        created += 1;
      } else {
        if (existing.kind !== node.kind) {
          if (node.kind === 'video-frame' && videoBitmap !== undefined) {
            const video = paintVideoVisual(node, videoBitmap);
            replaceVisual(existing, video.visual);
            existing.videoCanvas = video.videoCanvas;
            existing.videoTexture = video.videoTexture;
          } else
            replaceVisual(
              existing,
              node.kind === 'text' ? paintTextVisual(node) : paintRectVisual(node),
            );
          existing.kind = node.kind;
        } else if (node.kind === 'video-frame' && videoBitmap !== undefined) {
          if (existing.visual instanceof Sprite) updateVideoTexture(existing, node, videoBitmap);
          else {
            const video = paintVideoVisual(node, videoBitmap);
            replaceVisual(existing, video.visual);
            existing.videoCanvas = video.videoCanvas;
            existing.videoTexture = video.videoTexture;
          }
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
    // Paint transitions in their own layer
    const seenTransitionIds = new Set<string>();
    for (const { node } of transitionNodes) {
      seenTransitionIds.add(node.id);
      const existing = transitionLayer.getChildByName(`transition:${node.id}`) as Container | undefined;
      if (existing === undefined) {
        const container = createTransitionLayer(node);
        transitionLayer.addChild(container);
      } else {
        updateTransitionLayer(existing, node);
      }
      drawCalls += 1;
    }
    for (const child of transitionLayer.children) {
      const name = child.name;
      if (name.startsWith('transition:') && !seenTransitionIds.has(name.slice('transition:'.length))) {
        child.destroy({ children: true });
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
    render(
      frame: RenderFrameIR,
      videoBitmaps: ReadonlyMap<string, BrowserVideoFrameBitmap> = new Map(),
    ): BrowserPixiRenderStats {
      assertAlive();
      validateRenderFrameIR(frame);
      const { width, height, dpr } = frame.viewport;
      const resolution = options.resolution ?? dpr;
      resize(width, height, resolution);
      background
        .clear()
        .rect(0, 0, width, height)
        .fill({ color: rgbaToHex(frame.background), alpha: frame.background.a / 255 });
      const { drawCalls, created, reused } = paint(frame, videoBitmaps);
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

function createTransitionLayer(node: TransitionNode): Container {
  const container = new Container();
  container.name = `transition:${node.id}`;
  container.zIndex = node.zIndex;

  const graphic = new Graphics();
  graphic.label = `transition:${node.id}:visual`;
  container.addChild(graphic);
  paintTransitionVisual(graphic, node);

  return container;
}

function updateTransitionLayer(container: Container, node: TransitionNode): void {
  const graphic = container.getChildByName(`transition:${node.id}:visual`) as Graphics | undefined;
  if (graphic === undefined) return;
  graphic.clear();
  paintTransitionVisual(graphic, node);
}

function paintTransitionVisual(graphic: Graphics, node: TransitionNode): void {
  graphic.clear();
  switch (node.transitionType) {
    case 'dissolve': {
      const alpha = node.progress;
      graphic
        .rect(0, 0, node.width, node.height)
        .fill({ color: rgbaToHex(node.color), alpha });
      break;
    }
    case 'wipe': {
      graphic
        .rect(0, 0, node.width, node.height)
        .fill({ color: rgbaToHex({ ...node.color, a: Math.round(node.color.a * node.progress) }) });
      graphic
        .rect(node.width * node.progress, 0, node.width * (1 - node.progress), node.height)
        .fill({ color: rgbaToHex(node.color), alpha: node.progress });
      break;
    }
    case 'slide': {
      graphic
        .rect(node.width * (1 - node.progress), 0, node.width * node.progress, node.height)
        .fill({ color: rgbaToHex(node.color), alpha: node.progress });
      break;
    }
  }
}

function rgbaToHex(color: Rgba): number {
  return ((color.r & 0xff) << 16) | ((color.g & 0xff) << 8) | (color.b & 0xff);
}

function rgbaToHexString(color: Rgba): string {
  const toHex = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}
