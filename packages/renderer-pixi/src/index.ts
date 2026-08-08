/**
 * WP-00.3 test-mode Pixi preview adapter.
 *
 * The production adapter will map these draw calls onto retained Pixi objects.
 * This deterministic software surface is deliberately used only for parity
 * testing in Node: it proves that the Pixi-facing adapter consumes Render IR,
 * not project data, DOM nodes, or decoder state.
 *
 * Browser consumers should import the real Pixi.js preview from
 * `@joy-media/renderer-pixi/browser` (resolved via the package's `browser`
 * subpath export). Type-only re-exports of the browser surface are exposed
 * below so editor code can reference the same types from either entry.
 */

import type {
  EditorOverlayIR,
  EffectInstanceIR,
  RenderFrameIR,
  Rgba,
  TransitionNode,
  VisualRenderNode,
} from '@joy-media/render-ir';
import { flattenRenderNodes, textPlateBounds, validateRenderFrameIR } from '@joy-media/render-ir';
import {
  applyColorGradeToPixels,
  applyCpuEffectsToColor,
  applyVignetteToPixels,
} from './effects-cpu.js';

export const PACKAGE_NAME = '@joy-media/renderer-pixi' as const;

export interface PreviewDrawCall {
  readonly nodeId: string;
  readonly kind: VisualRenderNode['kind'];
}

export interface PreviewFrame {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly drawCalls: readonly PreviewDrawCall[];
}

/** Editor-only metadata is carried alongside preview pixels, never merged into RenderFrameIR. */
export interface EditorPreviewFrame extends PreviewFrame {
  readonly overlay: EditorOverlayIR;
}

/** Renders a fixed-setting preview surface from IR; no browser or GPU dependency. */
export function renderPixiPreview(frame: RenderFrameIR): PreviewFrame {
  validateRenderFrameIR(frame);
  const { width, height } = frame.viewport;
  const pixels = createSurface(width, height, frame.background);
  const drawCalls: PreviewDrawCall[] = [];
  const nodes = flattenRenderNodes(frame.nodes)
    .map((node, index) => ({ node, index }))
    .sort((a, b) => a.node.zIndex - b.node.zIndex || a.index - b.index);

  let maxVignette = 0;
  for (const { node } of nodes) {
    drawCalls.push({ nodeId: node.id, kind: node.kind });
    if (node.kind === 'transition') {
      paintTransition(pixels, width, height, node);
      continue;
    }
    const effects =
      node.kind === 'sprite' || node.kind === 'video-frame' || node.kind === 'text'
        ? node.effects
        : undefined;
    maxVignette = Math.max(maxVignette, enabledVignetteAmount(effects));
    if (node.kind === 'text') {
      paintText(pixels, width, height, node, effects);
    } else {
      paintRect(pixels, width, height, node, effects);
    }
  }
  applyColorGradeToPixels(pixels, frame.colorGrade);
  if (maxVignette > 0) applyVignetteToPixels(pixels, width, height, maxVignette);
  return { width, height, pixels, drawCalls };
}

/**
 * Minimal render-host boundary: overlays may guide editing but cannot affect the
 * content pixels consumed by export/golden renderers.
 */
export function renderPixiEditorPreview(
  frame: RenderFrameIR,
  overlay: EditorOverlayIR,
): EditorPreviewFrame {
  if (overlay.version !== 1)
    throw new RangeError(`unsupported editor overlay version ${overlay.version}`);
  return { ...renderPixiPreview(frame), overlay };
}

function createSurface(width: number, height: number, color: Rgba): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = color.r;
    pixels[offset + 1] = color.g;
    pixels[offset + 2] = color.b;
    pixels[offset + 3] = color.a;
  }
  return pixels;
}

function paintRect(
  pixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  node: Exclude<VisualRenderNode, { kind: 'text' | 'transition' }>,
  effects: readonly EffectInstanceIR[] | undefined,
): void {
  forEachLocalPixel(pixels, frameWidth, frameHeight, node, (localX, localY) => {
    if (localX < 0 || localX >= node.width || localY < 0 || localY >= node.height) return null;
    return applyCpuEffectsToColor(node.color, effects, localX, localY);
  });
}

function paintText(
  pixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  node: Extract<VisualRenderNode, { kind: 'text' }>,
  effects: readonly EffectInstanceIR[] | undefined,
): void {
  const textWidth = node.text.length * 4;
  const textBounds = textPlateBounds(textWidth, 5, node.align);
  const plateBounds = textPlateBounds(textWidth, 5, node.align, 1);
  forEachLocalPixel(pixels, frameWidth, frameHeight, node, (localX, localY) => {
    const x = Math.floor(localX - textBounds.x);
    const y = Math.floor(localY);
    const character = Math.floor(x / 4);
    const glyphX = x % 4;
    if (glyph(node.text[character] ?? ' ', glyphX, y)) {
      return applyCpuEffectsToColor(node.color, effects, localX, localY);
    }
    if (
      node.background !== undefined &&
      localX >= plateBounds.x &&
      localX < plateBounds.x + plateBounds.width &&
      localY >= plateBounds.y &&
      localY < plateBounds.y + plateBounds.height
    ) {
      return applyCpuEffectsToColor(node.background, effects, localX, localY);
    }
    return null;
  });
}

function paintTransition(
  pixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  node: TransitionNode,
): void {
  // CPU path keeps lightweight approximations; browser/Pixi owns real gl-transitions.
  const progress = Math.min(1, Math.max(0, node.progress));
  const kind = node.shaderId || node.transitionType;
  for (let y = 0; y < frameHeight; y++) {
    for (let x = 0; x < frameWidth; x++) {
      let cover = false;
      let alpha = progress;
      if (kind === 'wipe' || kind === 'gl:wipeLeft' || kind.includes('wipe')) {
        cover = x < frameWidth * progress;
        alpha = progress;
      } else if (kind === 'slide' || kind === 'gl:Directional' || kind.includes('slide')) {
        cover = x >= frameWidth * (1 - progress);
        alpha = progress;
      } else {
        // dissolve / fade / unknown gl:* — soft plate
        cover = true;
        alpha = progress;
      }
      if (!cover || alpha <= 0) continue;
      const color: Rgba = {
        r: node.color.r,
        g: node.color.g,
        b: node.color.b,
        a: Math.round(255 * alpha),
      };
      blendPixel(pixels, (y * frameWidth + x) * 4, color, node.opacity);
    }
  }
}

function forEachLocalPixel(
  pixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  node: VisualRenderNode,
  sample: (localX: number, localY: number) => Rgba | null,
): void {
  for (let y = 0; y < frameHeight; y++) {
    for (let x = 0; x < frameWidth; x++) {
      const localX = (x + 0.5 - node.transform.translateX) / node.transform.scaleX;
      const localY = (y + 0.5 - node.transform.translateY) / node.transform.scaleY;
      const color = sample(localX, localY);
      if (color !== null) blendPixel(pixels, (y * frameWidth + x) * 4, color, node.opacity);
    }
  }
}

function blendPixel(pixels: Uint8Array, offset: number, source: Rgba, opacity: number): void {
  const sourceAlpha = (source.a / 255) * opacity;
  const destinationAlpha = pixels[offset + 3]! / 255;
  const outAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outAlpha === 0) {
    pixels[offset] = 0;
    pixels[offset + 1] = 0;
    pixels[offset + 2] = 0;
    pixels[offset + 3] = 0;
    return;
  }
  for (const channel of [0, 1, 2] as const) {
    const destination = pixels[offset + channel]!;
    const out =
      (source[channelName(channel)] * sourceAlpha +
        destination * destinationAlpha * (1 - sourceAlpha)) /
      outAlpha;
    pixels[offset + channel] = Math.round(out);
  }
  pixels[offset + 3] = Math.round(outAlpha * 255);
}

function channelName(channel: 0 | 1 | 2): 'r' | 'g' | 'b' {
  return channel === 0 ? 'r' : channel === 1 ? 'g' : 'b';
}

function enabledVignetteAmount(effects: readonly EffectInstanceIR[] | undefined): number {
  if (effects === undefined) return 0;
  let max = 0;
  for (const effect of effects) {
    if (effect.enabled && effect.kind === 'vignette') {
      max = Math.max(max, effect.params.amount ?? 0.35);
    }
  }
  return max;
}

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  J: ['011', '001', '001', '101', '010'],
  O: ['010', '101', '101', '101', '010'],
  Y: ['101', '101', '010', '010', '010'],
};

function glyph(character: string, x: number, y: number): boolean {
  return GLYPHS[character]?.[y]?.[x] === '1';
}

/**
 * Type-only re-export of the browser Pixi surface. The runtime browser entry
 * is reached via the package's `./browser` subpath export or the `browser`
 * condition on the main export; a runtime re-export here would pull `pixi.js`
 * into Node-only test builds and break parity testing.
 */
export type {
  BrowserPixiRenderer,
  BrowserPixiRendererOptions,
  BrowserPixiRenderStats,
} from './browser.js';
