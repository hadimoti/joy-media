/**
 * WP-00.3 deterministic reference path. It has no preview/GPU dependency and
 * consumes the same evaluated Render IR as the Pixi adapter.
 */

import type { RenderFrameIR, RenderNode, Rgba } from '@joy-media/render-ir';
import { validateRenderFrameIR } from '@joy-media/render-ir';

export const PACKAGE_NAME = '@joy-media/renderer-headless' as const;

export interface HeadlessFrame {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** Renders the spike's sprite, video-frame, and bitmap-text nodes in a pinned software path. */
export function renderHeadlessFrame(frame: RenderFrameIR): HeadlessFrame {
  validateRenderFrameIR(frame);
  const width = frame.viewport.width;
  const height = frame.viewport.height;
  const pixels = fillBackground(width, height, frame.background);
  const orderedNodes = frame.nodes
    .map((node, position) => ({ node, position }))
    .sort((left, right) => left.node.zIndex - right.node.zIndex || left.position - right.position);

  for (const { node } of orderedNodes) {
    if (node.kind === 'text') drawText(pixels, width, height, node);
    else drawSurface(pixels, width, height, node);
  }
  return { width, height, pixels };
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

function drawSurface(
  pixels: Uint8Array,
  width: number,
  height: number,
  node: Exclude<RenderNode, { kind: 'text' }>,
): void {
  rasterize(pixels, width, height, node, (u, v) =>
    u >= 0 && u < node.width && v >= 0 && v < node.height ? node.color : undefined,
  );
}

function drawText(
  pixels: Uint8Array,
  width: number,
  height: number,
  node: Extract<RenderNode, { kind: 'text' }>,
): void {
  rasterize(pixels, width, height, node, (u, v) => {
    const glyphColumn = Math.floor(u) % 4;
    const characterIndex = Math.floor(Math.floor(u) / 4);
    return bitmap(node.text[characterIndex] ?? ' ', glyphColumn, Math.floor(v))
      ? node.color
      : undefined;
  });
}

function rasterize(
  pixels: Uint8Array,
  width: number,
  height: number,
  node: RenderNode,
  lookup: (u: number, v: number) => Rgba | undefined,
): void {
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const u = (column + 0.5 - node.transform.translateX) / node.transform.scaleX;
      const v = (row + 0.5 - node.transform.translateY) / node.transform.scaleY;
      const color = lookup(u, v);
      if (color !== undefined) composite(pixels, (row * width + column) * 4, color, node.opacity);
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

const BITMAP: Readonly<Record<string, readonly string[]>> = {
  J: ['011', '001', '001', '101', '010'],
  O: ['010', '101', '101', '101', '010'],
  Y: ['101', '101', '010', '010', '010'],
};

function bitmap(character: string, column: number, row: number): boolean {
  return BITMAP[character]?.[row]?.[column] === '1';
}
