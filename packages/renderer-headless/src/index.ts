/**
 * WP-00.3 deterministic reference path. It has no preview/GPU dependency and
 * consumes the same evaluated Render IR as the Pixi adapter.
 *
 * P16: CPU-side effect pass applied per-node before compositing into the frame.
 */

import type {
  RenderFrameIR,
  Rgba,
  TransitionNode,
  VisualRenderNode,
  EffectInstanceIR,
} from '@joy-media/render-ir';
import { flattenRenderNodes, validateRenderFrameIR } from '@joy-media/render-ir';
import { applyCreativeEffect } from './creative-effects.js';

export const PACKAGE_NAME = '@joy-media/renderer-headless' as const;

export interface HeadlessFrame {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export interface EffectDiagnostic {
  readonly instanceId: string;
  readonly effectId: string;
  readonly status: 'applied' | 'bypassed' | 'unsupported' | 'error';
}

interface EffectSeedContext {
  readonly compositionId: string;
  readonly timeUs: number;
  readonly nodeId: string;
}

export function renderHeadlessFrame(frame: RenderFrameIR): HeadlessFrame {
  validateRenderFrameIR(frame);
  const width = frame.viewport.width;
  const height = frame.viewport.height;
  const pixels = fillBackground(width, height, frame.background);
  const orderedNodes = flattenRenderNodes(frame.nodes)
    .map((node, position) => ({ node, position }))
    .sort((left, right) => left.node.zIndex - right.node.zIndex || left.position - right.position);

  for (const { node } of orderedNodes) {
    const nodePixels = new Uint8Array(width * height * 4);
    if (node.kind === 'transition') drawTransitionRaw(nodePixels, width, height, node);
    else if (node.kind === 'text') drawTextRaw(nodePixels, width, height, node);
    else drawSurfaceRaw(nodePixels, width, height, node);
    if ('effects' in node && node.effects && node.effects.length > 0) {
      applyHeadlessEffects(nodePixels, width, height, node.effects, {
        compositionId: frame.compositionId,
        timeUs: frame.timeUs,
        nodeId: node.id,
      });
    }
    compositeNode(pixels, nodePixels, width, height, node.opacity);
  }
  return { width, height, pixels };
}

function compositeNode(
  dest: Uint8Array,
  src: Uint8Array,
  width: number,
  height: number,
  opacity: number,
): void {
  for (let i = 0; i < width * height; i++) {
    const base = i * 4;
    composite(
      dest,
      base,
      {
        r: src[base]!,
        g: src[base + 1]!,
        b: src[base + 2]!,
        a: src[base + 3]!,
      },
      opacity,
    );
  }
}

function fillBackground(width: number, height: number, background: Rgba): Uint8Array {
  const result = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const base = pixel * 4;
    result[base] = background.r;
    result[base + 1] = background.g;
    result[base + 2] = background.b;
    result[base + 3] = background.a;
  }
  return result;
}

function drawTransitionRaw(
  pixels: Uint8Array,
  width: number,
  height: number,
  node: TransitionNode,
): void {
  const progress = Math.min(1, Math.max(0, node.progress));
  const left = colorFromClipId(node.leftClipId);
  const right = colorFromClipId(node.rightClipId);
  const color = {
    r: mix(left.r, right.r, progress),
    g: mix(left.g, right.g, progress),
    b: mix(left.b, right.b, progress),
    a: 255,
  };
  rasterizeRaw(pixels, width, height, node, (u, v) =>
    u >= 0 && u < node.width && v >= 0 && v < node.height ? color : undefined,
  );
}

function drawSurfaceRaw(
  pixels: Uint8Array,
  width: number,
  height: number,
  node: Exclude<VisualRenderNode, { kind: 'text' }>,
): void {
  rasterizeRaw(pixels, width, height, node, (u, v) =>
    u >= 0 && u < node.width && v >= 0 && v < node.height ? node.color : undefined,
  );
}

function drawTextRaw(
  pixels: Uint8Array,
  width: number,
  height: number,
  node: Extract<VisualRenderNode, { kind: 'text' }>,
): void {
  rasterizeRaw(pixels, width, height, node, (u, v) => {
    const glyphColumn = Math.floor(u) % 4;
    const characterIndex = Math.floor(Math.floor(u) / 4);
    return bitmap(node.text[characterIndex] ?? ' ', glyphColumn, Math.floor(v))
      ? node.color
      : undefined;
  });
}

function colorFromClipId(clipId: string): Rgba {
  const hash = hash32(`transition:${clipId}`);
  return {
    r: 64 + (hash & 0x7f),
    g: 64 + ((hash >>> 8) & 0x7f),
    b: 64 + ((hash >>> 16) & 0x7f),
    a: 255,
  };
}

function mix(left: number, right: number, progress: number): number {
  return Math.round(left * (1 - progress) + right * progress);
}

function rasterizeRaw(
  pixels: Uint8Array,
  width: number,
  height: number,
  node: VisualRenderNode,
  lookup: (u: number, v: number) => Rgba | undefined,
): void {
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const u = (column + 0.5 - node.transform.translateX) / node.transform.scaleX;
      const v = (row + 0.5 - node.transform.translateY) / node.transform.scaleY;
      const color = lookup(u, v);
      if (color !== undefined) composite(pixels, (row * width + column) * 4, color, 1);
    }
  }
}

function composite(buffer: Uint8Array, base: number, source: Rgba, opacity: number): void {
  const sourceAlpha = (source.a * opacity) / 255;
  const destinationAlpha = buffer[base + 3]! / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outputAlpha === 0) {
    buffer[base] = 0;
    buffer[base + 1] = 0;
    buffer[base + 2] = 0;
    buffer[base + 3] = 0;
    return;
  }
  const sourceChannels = [source.r, source.g, source.b];
  for (let component = 0; component < 3; component++) {
    const destination = buffer[base + component]!;
    buffer[base + component] = Math.round(
      (sourceChannels[component]! * sourceAlpha +
        destination * destinationAlpha * (1 - sourceAlpha)) /
        outputAlpha,
    );
  }
  buffer[base + 3] = Math.round(outputAlpha * 255);
}

/** Apply CPU-side effects to pixel data. Returns diagnostics for unsupported effects. */
export function applyHeadlessEffects(
  pixels: Uint8Array,
  width: number,
  height: number,
  effects: readonly EffectInstanceIR[] | undefined,
  seedContext?: EffectSeedContext,
): EffectDiagnostic[] {
  if (!effects || effects.length === 0) return [];
  const diagnostics: EffectDiagnostic[] = [];

  for (const effect of effects) {
    if (!effect.enabled) {
      diagnostics.push({ instanceId: effect.id, effectId: effect.kind, status: 'bypassed' });
      continue;
    }
    switch (effect.kind) {
      case 'brightness-contrast': {
        const brightness = (effect.params.brightness ?? 0) * 255;
        const contrast = (effect.params.contrast ?? 0) + 1;
        pixelOp(pixels, (r, g, b) => [
          clamp((r - 128) * contrast + 128 + brightness),
          clamp((g - 128) * contrast + 128 + brightness),
          clamp((b - 128) * contrast + 128 + brightness),
        ]);
        diagnostics.push({ instanceId: effect.id, effectId: effect.kind, status: 'applied' });
        break;
      }
      case 'sepia': {
        const amount = effect.params.amount ?? 0.5;
        pixelOp(pixels, (r, g, b) => {
          const tr = clamp(r * (1 - 0.607 * amount) + g * 0.769 * amount + b * 0.189 * amount);
          const tg = clamp(r * 0.349 * amount + g * (1 - 0.314 * amount) + b * 0.168 * amount);
          const tb = clamp(r * 0.272 * amount + g * 0.534 * amount + b * (1 - 0.869 * amount));
          return [tr, tg, tb];
        });
        diagnostics.push({ instanceId: effect.id, effectId: effect.kind, status: 'applied' });
        break;
      }
      case 'gaussian-blur':
      case 'blur': {
        const amount = effect.params.amount ?? 4;
        boxBlur(pixels, width, height, Math.max(1, Math.round(amount)));
        diagnostics.push({ instanceId: effect.id, effectId: effect.kind, status: 'applied' });
        break;
      }
      case 'noise':
      case 'grain': {
        const amount = effect.params.amount ?? 0.2;
        const n = Math.round(amount * 255);
        const seed = hash32(effectSeed(seedContext, effect));
        pixelOp(pixels, (r, g, b, pixelIndex) => {
          const noise = (seededUnit(seed, pixelIndex) - 0.5) * 2 * n;
          return [clamp(r + noise), clamp(g + noise), clamp(b + noise)];
        });
        diagnostics.push({ instanceId: effect.id, effectId: effect.kind, status: 'applied' });
        break;
      }
      case 'posterize': {
        const levels = Math.max(2, effect.params.levels ?? 8);
        const factor = 255 / (levels - 1);
        pixelOp(pixels, (r, g, b) => [
          Math.round(Math.round(r / factor) * factor),
          Math.round(Math.round(g / factor) * factor),
          Math.round(Math.round(b / factor) * factor),
        ]);
        diagnostics.push({ instanceId: effect.id, effectId: effect.kind, status: 'applied' });
        break;
      }
      case 'vibrance': {
        const amount = effect.params.amount ?? 0;
        const satFactor = 1 + amount * 0.5;
        pixelOp(pixels, (r, g, b) => {
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;
          return [
            clamp(gray + (r - gray) * satFactor),
            clamp(gray + (g - gray) * satFactor),
            clamp(gray + (b - gray) * satFactor),
          ];
        });
        diagnostics.push({ instanceId: effect.id, effectId: effect.kind, status: 'applied' });
        break;
      }
      case 'hue-saturation': {
        const hueShift = effect.params.hue ?? 0;
        const satAmount = (effect.params.saturation ?? 0) + 1;
        pixelOp(pixels, (r, g, b) => {
          if (satAmount !== 1 || hueShift !== 0) {
            return applyHueSaturation(r, g, b, hueShift, satAmount);
          }
          return [r, g, b];
        });
        diagnostics.push({ instanceId: effect.id, effectId: effect.kind, status: 'applied' });
        break;
      }
      default:
        diagnostics.push({
          instanceId: effect.id,
          effectId: effect.kind,
          status: applyCreativeEffect(pixels, width, height, effect.kind, effect.params)
            ? 'applied'
            : 'unsupported',
        });
    }
  }
  return diagnostics;
}

function pixelOp(
  pixels: Uint8Array,
  fn: (r: number, g: number, b: number, pixelIndex: number) => [number, number, number],
): void {
  let pixelIndex = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b] = fn(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixelIndex++);
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
  }
}

function effectSeed(seedContext: EffectSeedContext | undefined, effect: EffectInstanceIR): string {
  if (seedContext === undefined) return `headless:${effect.kind}:${effect.id}`;
  return `${seedContext.compositionId}:${seedContext.timeUs}:${seedContext.nodeId}:${effect.kind}:${effect.id}`;
}

function hash32(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function seededUnit(seed: number, pixelIndex: number): number {
  let state = (seed ^ Math.imul(pixelIndex + 1, 0x9e3779b1)) >>> 0;
  state ^= state >>> 16;
  state = Math.imul(state, 0x85ebca6b) >>> 0;
  state ^= state >>> 13;
  state = Math.imul(state, 0xc2b2ae35) >>> 0;
  state ^= state >>> 16;
  return state / 0xffffffff;
}

function boxBlur(pixels: Uint8Array, width: number, height: number, radius: number): void {
  const copy = new Uint8Array(pixels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = (y * width + x) * 4;
      let sumR = 0,
        sumG = 0,
        sumB = 0,
        count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const ny = y + dy,
            nx = x + dx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            const pos = (ny * width + nx) * 4;
            sumR += copy[pos]!;
            sumG += copy[pos + 1]!;
            sumB += copy[pos + 2]!;
            count++;
          }
        }
      }
      if (count > 0) {
        pixels[base] = Math.round(sumR / count);
        pixels[base + 1] = Math.round(sumG / count);
        pixels[base + 2] = Math.round(sumB / count);
      }
    }
  }
}

function applyHueSaturation(
  r: number,
  g: number,
  b: number,
  hue: number,
  sat: number,
): [number, number, number] {
  const len = Math.sqrt(r * r + g * g + b * b);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (chroma === 0) return [clamp(r * sat), clamp(g * sat), clamp(b * sat)];

  let h = 0;
  if (max === r) h = ((g - b) / chroma + 6) % 6;
  else if (max === g) h = (b - r) / chroma + 2;
  else h = (r - g) / chroma + 4;
  h = (h * 60 + hue * 180 + 360) % 360;

  const s = sat !== 1 ? Math.min(1, (chroma / max) * sat + (1 - sat)) : chroma / max;
  const c = max * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = (len / 3) * 1.5 - c;

  let r2 = 0,
    g2 = 0,
    b2 = 0;
  if (h < 60) {
    r2 = c;
    g2 = x;
    b2 = 0;
  } else if (h < 120) {
    r2 = x;
    g2 = c;
    b2 = 0;
  } else if (h < 180) {
    r2 = 0;
    g2 = c;
    b2 = x;
  } else if (h < 240) {
    r2 = 0;
    g2 = x;
    b2 = c;
  } else if (h < 300) {
    r2 = x;
    g2 = 0;
    b2 = c;
  } else {
    r2 = c;
    g2 = 0;
    b2 = x;
  }

  return [clamp(r2 + m), clamp(g2 + m), clamp(b2 + m)];
}

function clamp(v: number): number {
  return Math.round(Math.max(0, Math.min(255, v)));
}

const BITMAP: Readonly<Record<string, readonly string[]>> = {
  J: ['011', '001', '001', '101', '010'],
  O: ['010', '101', '101', '101', '010'],
  Y: ['101', '101', '010', '010', '010'],
};

function bitmap(character: string, column: number, row: number): boolean {
  return BITMAP[character]?.[row]?.[column] === '1';
}
