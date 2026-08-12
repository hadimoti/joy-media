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
  TextNode,
  TransitionNode,
  VideoFrameNode,
  VisualRenderNode,
} from '@joy-media/render-ir';
import { flattenRenderNodes, textPlateBounds, validateRenderFrameIR } from '@joy-media/render-ir';
import {
  buildPixiColorGradeFilter,
  buildPixiEffectFilters,
  colorGradeSignature,
  effectsSignature,
} from './effects-pixi.js';
import { createGlTransitionFilter, type GlTransitionFilterHandle } from './gl-transition-filter.js';
import { dualTextureBitmapsReady } from './transition-bitmaps.js';

export { dualTextureBitmapsReady } from './transition-bitmaps.js';

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
  /** Last applied effect stack signature (skip filter rebuild when unchanged). */
  effectsKey?: string;
  /** Persistent CPU canvas and GPU texture for a decoded video node. */
  videoCanvas?: HTMLCanvasElement | undefined;
  videoTexture?: Texture | undefined;
  /** Optional plate rendered behind a text visual. */
  textBackground?: Graphics | undefined;
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
  /** Returns a bounded RGBA readback for diagnostics; overlays are not painted into it. */
  readonly readPixels: (
    maxWidth?: number,
    maxHeight?: number,
  ) =>
    | {
        readonly width: number;
        readonly height: number;
        readonly data: Uint8ClampedArray;
      }
    | undefined;
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

  const content = new Container();
  content.label = 'renderer-pixi:content';
  content.zIndex = 0;
  app.stage.addChild(content);

  const layers = new Container();
  layers.label = 'renderer-pixi:layers';
  content.addChild(layers);

  const transitionLayer = new Container();
  transitionLayer.label = 'renderer-pixi:transitions';
  content.addChild(transitionLayer);
  app.stage.sortableChildren = true;
  layers.sortableChildren = true;

  const spriteMap = new Map<string, LayerContainer>();
  let frameWidth = options.width ?? 320;
  let frameHeight = options.height ?? 180;
  let disposed = false;
  let lastGradeKey = '';

  const assertAlive = (): void => {
    if (disposed) throw new Error(`${BROWSER_PACKAGE_ENTRY}: renderer has been destroyed`);
  };

  const resize = (width: number, height: number, resolution: number): void => {
    frameWidth = width;
    frameHeight = height;
    app.renderer.resize(width, height, resolution);
  };

  const updateRectVisual = (
    graphic: Graphics,
    node: Exclude<VisualRenderNode, { kind: 'text' }>,
  ): void => {
    graphic
      .clear()
      .rect(0, 0, node.width, node.height)
      .fill({ color: rgbaToHex(node.color), alpha: node.color.a / 255 });
    graphic.label = `${node.kind}:${node.id}`;
  };

  const paintRectVisual = (node: Exclude<VisualRenderNode, { kind: 'text' }>): Graphics => {
    const graphic = new Graphics();
    updateRectVisual(graphic, node);
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

  const applyTextAlignment = (text: Text, node: TextNode): void => {
    const align = node.align ?? 'left';
    if (align === 'center') text.anchor.set(0.5, 0);
    else if (align === 'right') text.anchor.set(1, 0);
    else text.anchor.set(0, 0);
  };

  const updateTextVisual = (text: Text, node: TextNode): void => {
    text.text = node.text;
    text.style = {
      fill: rgbaToHexString(node.color),
      fontSize: node.fontSizePx ?? 16,
      align: node.align ?? 'left',
      ...(node.maxWidth !== undefined ? { wordWrap: true, wordWrapWidth: node.maxWidth } : {}),
    };
    text.label = `text:${node.id}`;
    applyTextAlignment(text, node);
  };

  const paintTextVisual = (node: TextNode): Text => {
    const text = new Text();
    updateTextVisual(text, node);
    return text;
  };

  const clearTextBackground = (layer: LayerContainer): void => {
    const plate = layer.textBackground;
    if (plate === undefined) return;
    layer.removeChild(plate);
    plate.destroy();
    layer.textBackground = undefined;
  };

  const syncTextBackground = (layer: LayerContainer, node: TextNode): void => {
    if (node.background === undefined || !(layer.visual instanceof Text)) {
      clearTextBackground(layer);
      return;
    }
    const text = layer.visual;
    const padding = Math.max(2, Math.round((node.fontSizePx ?? 16) * 0.12));
    const bounds = textPlateBounds(text.width, text.height, node.align, padding);
    const plate = layer.textBackground ?? new Graphics();
    plate
      .clear()
      .rect(bounds.x, bounds.y, bounds.width, bounds.height)
      .fill({ color: rgbaToHex(node.background), alpha: node.background.a / 255 });
    plate.label = `text-background:${node.id}`;
    if (layer.textBackground === undefined) {
      layer.addChildAt(plate, 0);
      layer.textBackground = plate;
    }
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

  const syncLayerEffects = (layer: LayerContainer, node: VisualRenderNode): void => {
    const effects =
      node.kind === 'sprite' || node.kind === 'video-frame' || node.kind === 'text'
        ? node.effects
        : undefined;
    const grade = node.kind === 'video-frame' ? node.colorGrade : undefined;
    const key = `${colorGradeSignature(grade)}\n${effectsSignature(effects)}`;
    if (layer.effectsKey === key) return;
    layer.effectsKey = key;
    const gradeFilter = buildPixiColorGradeFilter(grade);
    const filters = [
      ...(gradeFilter === undefined ? [] : [gradeFilter]),
      ...buildPixiEffectFilters(effects),
    ];
    layer.filters = filters.length > 0 ? filters : null;
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
    if (node.kind === 'text') syncTextBackground(container, node);
    updateLayerTransform(container, node);
    syncLayerEffects(container, node);
    return container;
  };

  const replaceVisual = (layer: LayerContainer, visual: Graphics | Sprite | Text): void => {
    clearTextBackground(layer);
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
        } else if (node.kind === 'text' && existing.visual instanceof Text) {
          updateTextVisual(existing.visual, node);
        } else if (node.kind !== 'text' && existing.visual instanceof Graphics) {
          updateRectVisual(existing.visual, node);
        }
        if (node.kind === 'text') syncTextBackground(existing, node);
        else clearTextBackground(existing);
        updateLayerTransform(existing, node);
        syncLayerEffects(existing, node);
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
    // Hide clip video layers that are being blended by an active transition.
    const hiddenClipIds = new Set<string>();
    for (const { node } of transitionNodes) {
      hiddenClipIds.add(node.leftClipId);
      hiddenClipIds.add(node.rightClipId);
    }
    for (const [id, layer] of spriteMap) {
      if (hiddenClipIds.has(id)) layer.visible = false;
      else if (layer.visible === false) layer.visible = true;
    }

    // Paint transitions in their own layer (dual-texture gl-transitions when bitmaps exist).
    const seenTransitionIds = new Set<string>();
    for (const { node } of transitionNodes) {
      seenTransitionIds.add(node.id);
      const existing = transitionLayer.getChildByName(`transition:${node.id}`) as
        TransitionLayerContainer | undefined;
      if (existing === undefined) {
        const container = createTransitionLayer(node, videoBitmaps);
        transitionLayer.addChild(container);
      } else {
        updateTransitionLayer(existing, node, videoBitmaps);
      }
      drawCalls += 1;
    }
    for (const child of [...transitionLayer.children]) {
      const name = child.name;
      if (
        typeof name === 'string' &&
        name.startsWith('transition:') &&
        !seenTransitionIds.has(name.slice('transition:'.length))
      ) {
        destroyTransitionLayer(child as TransitionLayerContainer);
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
    readPixels(maxWidth = 640, maxHeight = 360) {
      if (disposed || frameWidth <= 0 || frameHeight <= 0) return undefined;
      const scale = Math.min(1, maxWidth / frameWidth, maxHeight / frameHeight);
      const width = Math.max(1, Math.round(frameWidth * scale));
      const height = Math.max(1, Math.round(frameHeight * scale));
      const copy = document.createElement('canvas');
      copy.width = width;
      copy.height = height;
      const context = copy.getContext('2d', { willReadFrequently: true });
      if (context === null) return undefined;
      context.drawImage(app.canvas, 0, 0, width, height);
      const image = context.getImageData(0, 0, width, height);
      return { width, height, data: image.data };
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
      const gradeKey = colorGradeSignature(frame.colorGrade);
      if (gradeKey !== lastGradeKey) {
        lastGradeKey = gradeKey;
        const gradeFilter = buildPixiColorGradeFilter(frame.colorGrade);
        content.filters = gradeFilter === undefined ? null : [gradeFilter];
      }
      const { drawCalls, created, reused } = paint(frame, videoBitmaps);
      if (options.autoStart !== true) app.renderer.render(app.stage);
      return { width: frameWidth, height: frameHeight, drawCalls, created, reused };
    },
    destroy(): void {
      if (disposed) return;
      disposed = true;
      spriteMap.clear();
      // Pixi's boolean `true` destroy shorthand also releases its process-wide
      // resource pools. Multiple preview renderers can briefly coexist while
      // React replaces a panel, so clearing those shared pools here invalidates
      // CanvasText textures that still belong to the surviving renderer.
      app.destroy({ removeView: true }, { children: true, texture: true });
    },
  };
}

interface TransitionLayerContainer extends Container {
  fromCanvas?: HTMLCanvasElement | undefined;
  fromTexture?: Texture | undefined;
  toCanvas?: HTMLCanvasElement | undefined;
  toTexture?: Texture | undefined;
  sprite?: Sprite | undefined;
  overlay?: Graphics | undefined;
  glHandle?: GlTransitionFilterHandle | undefined;
  shaderId?: string | undefined;
}

function createTransitionLayer(
  node: TransitionNode,
  videoBitmaps: ReadonlyMap<string, BrowserVideoFrameBitmap>,
): TransitionLayerContainer {
  const container = new Container() as TransitionLayerContainer;
  container.name = `transition:${node.id}`;
  container.zIndex = node.zIndex;
  updateTransitionLayer(container, node, videoBitmaps);
  return container;
}

function destroyTransitionLayer(container: TransitionLayerContainer): void {
  container.glHandle?.destroy();
  container.fromTexture?.destroy(true);
  container.toTexture?.destroy(true);
  container.destroy({ children: true });
}

function ensureBitmapTexture(
  canvas: HTMLCanvasElement | undefined,
  texture: Texture | undefined,
  bitmap: BrowserVideoFrameBitmap,
): { canvas: HTMLCanvasElement; texture: Texture } {
  const nextCanvas = canvas ?? document.createElement('canvas');
  if (nextCanvas.width !== bitmap.width || nextCanvas.height !== bitmap.height) {
    nextCanvas.width = bitmap.width;
    nextCanvas.height = bitmap.height;
  }
  const context = nextCanvas.getContext('2d');
  if (context === null)
    throw new Error(`${BROWSER_PACKAGE_ENTRY}: transition canvas 2d unavailable`);
  const image = context.createImageData(bitmap.width, bitmap.height);
  image.data.set(bitmap.data);
  context.putImageData(image, 0, 0);
  const nextTexture = texture ?? Texture.from(nextCanvas, true);
  nextTexture.source.update();
  return { canvas: nextCanvas, texture: nextTexture };
}

function updateTransitionLayer(
  container: TransitionLayerContainer,
  node: TransitionNode,
  videoBitmaps: ReadonlyMap<string, BrowserVideoFrameBitmap>,
): void {
  const fromBitmap = videoBitmaps.get(node.leftClipId);
  const toBitmap = videoBitmaps.get(node.rightClipId);
  const canBlend =
    fromBitmap !== undefined &&
    toBitmap !== undefined &&
    dualTextureBitmapsReady(node.leftClipId, node.rightClipId, videoBitmaps);

  if (!canBlend || fromBitmap === undefined || toBitmap === undefined) {
    container.glHandle?.destroy();
    container.glHandle = undefined;
    container.sprite?.destroy();
    container.sprite = undefined;
    if (container.overlay === undefined) {
      const overlay = new Graphics();
      overlay.label = `transition:${node.id}:overlay`;
      container.addChild(overlay);
      container.overlay = overlay;
    }
    paintTransitionOverlay(container.overlay, node);
    return;
  }

  if (container.overlay !== undefined) {
    container.overlay.destroy();
    container.overlay = undefined;
  }

  const from = ensureBitmapTexture(container.fromCanvas, container.fromTexture, fromBitmap);
  container.fromCanvas = from.canvas;
  container.fromTexture = from.texture;
  const to = ensureBitmapTexture(container.toCanvas, container.toTexture, toBitmap);
  container.toCanvas = to.canvas;
  container.toTexture = to.texture;

  if (container.sprite === undefined) {
    const sprite = new Sprite(from.texture);
    sprite.label = `transition:${node.id}:sprite`;
    container.addChild(sprite);
    container.sprite = sprite;
  } else {
    container.sprite.texture = from.texture;
  }
  container.sprite.width = node.width;
  container.sprite.height = node.height;

  if (container.glHandle === undefined || container.shaderId !== node.shaderId) {
    container.glHandle?.destroy();
    container.glHandle = createGlTransitionFilter(node.shaderId, node.params);
    container.shaderId = node.shaderId;
    container.sprite.filters =
      container.glHandle === undefined ? null : [container.glHandle.filter];
  }

  if (container.glHandle !== undefined) {
    container.glHandle.setToTexture(to.texture);
    container.glHandle.setProgress(node.progress);
    container.glHandle.setRatio(node.width / Math.max(1, node.height));
    if (node.params !== undefined) container.glHandle.setParams(node.params);
  } else {
    // Unknown shader — soft crossfade fallback in CPU-ish style via sprite alpha.
    container.sprite.alpha = 1 - node.progress;
  }
}

function paintTransitionOverlay(graphic: Graphics, node: TransitionNode): void {
  graphic.clear();
  const progress = Math.min(1, Math.max(0, node.progress));
  // Fallback when A/B bitmaps are not yet available: soft dissolve plate.
  graphic.rect(0, 0, node.width, node.height).fill({ color: 0x000000, alpha: progress * 0.35 });
}

function rgbaToHex(color: Rgba): number {
  return ((color.r & 0xff) << 16) | ((color.g & 0xff) << 8) | (color.b & 0xff);
}

function rgbaToHexString(color: Rgba): string {
  const toHex = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}
