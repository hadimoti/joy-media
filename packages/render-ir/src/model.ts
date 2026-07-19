/**
 * Minimal, evaluated render intermediate representation for WP-00.3.
 *
 * This is deliberately ephemeral and renderer-neutral: it carries evaluated
 * pixels/geometry for one frame, never project-model objects or renderer
 * instances. The full node taxonomy and property evaluator land in P01.
 */

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/** Already-evaluated affine subset used by this spike. */
export interface Transform2D {
  readonly translateX: number;
  readonly translateY: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

interface RenderNodeBase {
  readonly id: string;
  /** Higher values render later (on top). */
  readonly zIndex: number;
  readonly opacity: number;
  readonly transform: Transform2D;
}

/** A resolved still-image surface. The source URI/decoder is intentionally absent. */
export interface SpriteNode extends RenderNodeBase {
  readonly kind: 'sprite';
  readonly width: number;
  readonly height: number;
  readonly color: Rgba;
}

/** A resolved video frame. Decoding has happened before this boundary. */
export interface VideoFrameNode extends RenderNodeBase {
  readonly kind: 'video-frame';
  readonly width: number;
  readonly height: number;
  readonly sourceTimeUs: number;
  readonly color: Rgba;
}

/** A text run rendered with the spike's pinned bitmap glyph set. */
export interface TextNode extends RenderNodeBase {
  readonly kind: 'text';
  readonly text: string;
  readonly color: Rgba;
}

export type RenderNode = SpriteNode | VideoFrameNode | TextNode;

export interface RenderFrameIR {
  readonly version: 0;
  readonly compositionId: string;
  readonly timeUs: number;
  readonly viewport: Viewport;
  readonly background: Rgba;
  readonly nodes: readonly RenderNode[];
}

/** Fails fast at the execution boundary rather than allowing a renderer-specific crash. */
export function validateRenderFrameIR(frame: RenderFrameIR): void {
  if (!Number.isSafeInteger(frame.timeUs) || frame.timeUs < 0) {
    throw new RangeError(`timeUs must be a non-negative safe integer, got ${frame.timeUs}`);
  }
  if (
    !Number.isSafeInteger(frame.viewport.width) ||
    !Number.isSafeInteger(frame.viewport.height) ||
    frame.viewport.width <= 0 ||
    frame.viewport.height <= 0 ||
    !Number.isFinite(frame.viewport.dpr) ||
    frame.viewport.dpr <= 0
  ) {
    throw new RangeError('viewport must have positive finite dimensions and dpr');
  }
  const ids = new Set<string>();
  for (const node of frame.nodes) {
    if (node.id.length === 0 || ids.has(node.id)) {
      throw new RangeError(`render node ids must be non-empty and unique; got "${node.id}"`);
    }
    ids.add(node.id);
    if (!Number.isFinite(node.opacity) || node.opacity < 0 || node.opacity > 1) {
      throw new RangeError(`node "${node.id}" opacity must be in [0, 1]`);
    }
    if (
      !Number.isFinite(node.transform.translateX) ||
      !Number.isFinite(node.transform.translateY) ||
      !Number.isFinite(node.transform.scaleX) ||
      !Number.isFinite(node.transform.scaleY) ||
      node.transform.scaleX <= 0 ||
      node.transform.scaleY <= 0
    ) {
      throw new RangeError(`node "${node.id}" transform must be finite with positive scales`);
    }
    if (node.kind === 'sprite' || node.kind === 'video-frame') {
      if (
        !Number.isFinite(node.width) ||
        !Number.isFinite(node.height) ||
        node.width <= 0 ||
        node.height <= 0
      ) {
        throw new RangeError(`node "${node.id}" dimensions must be positive`);
      }
    }
    assertRgba(node.color, `node "${node.id}" color`);
  }
  assertRgba(frame.background, 'background');
}

function assertRgba(color: Rgba, label: string): void {
  for (const [channel, value] of Object.entries(color)) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new RangeError(`${label}.${channel} must be an integer in [0, 255]`);
    }
  }
}
