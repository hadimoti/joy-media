/**
 * WP-00.3 test-mode Pixi preview adapter.
 *
 * The production adapter will map these draw calls onto retained Pixi objects.
 * This deterministic software surface is deliberately used only for parity
 * testing in Node: it proves that the Pixi-facing adapter consumes Render IR,
 * not project data, DOM nodes, or decoder state.
 */

import type { RenderFrameIR, RenderNode, Rgba } from '@joy-media/render-ir';
import { validateRenderFrameIR } from '@joy-media/render-ir';

export const PACKAGE_NAME = '@joy-media/renderer-pixi' as const;

export interface PreviewDrawCall {
  readonly nodeId: string;
  readonly kind: RenderNode['kind'];
}

export interface PreviewFrame {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly drawCalls: readonly PreviewDrawCall[];
}

/** Renders a fixed-setting preview surface from IR; no browser or GPU dependency. */
export function renderPixiPreview(frame: RenderFrameIR): PreviewFrame {
  validateRenderFrameIR(frame);
  const { width, height } = frame.viewport;
  const pixels = createSurface(width, height, frame.background);
  const drawCalls: PreviewDrawCall[] = [];
  const nodes = frame.nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => a.node.zIndex - b.node.zIndex || a.index - b.index);

  for (const { node } of nodes) {
    drawCalls.push({ nodeId: node.id, kind: node.kind });
    if (node.kind === 'text') {
      paintText(pixels, width, height, node);
    } else {
      paintRect(pixels, width, height, node);
    }
  }
  return { width, height, pixels, drawCalls };
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
  node: Exclude<RenderNode, { kind: 'text' }>,
): void {
  forEachLocalPixel(pixels, frameWidth, frameHeight, node, (localX, localY) =>
    localX >= 0 && localX < node.width && localY >= 0 && localY < node.height ? node.color : null,
  );
}

function paintText(
  pixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  node: Extract<RenderNode, { kind: 'text' }>,
): void {
  forEachLocalPixel(pixels, frameWidth, frameHeight, node, (localX, localY) => {
    const x = Math.floor(localX);
    const y = Math.floor(localY);
    const character = Math.floor(x / 4);
    const glyphX = x % 4;
    return glyph(node.text[character] ?? ' ', glyphX, y) ? node.color : null;
  });
}

function forEachLocalPixel(
  pixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  node: RenderNode,
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

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  J: ['011', '001', '001', '101', '010'],
  O: ['010', '101', '101', '101', '010'],
  Y: ['101', '101', '010', '010', '010'],
};

function glyph(character: string, x: number, y: number): boolean {
  return GLYPHS[character]?.[y]?.[x] === '1';
}
