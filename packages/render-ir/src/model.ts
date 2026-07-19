/**
 * Versioned, evaluated render intermediate representation.
 *
 * This is deliberately ephemeral and renderer-neutral: it carries evaluated
 * pixels/geometry for one frame, never project-model objects or renderer
 * instances. Editor-only overlays travel on a separate contract and cannot
 * accidentally be rendered by export adapters.
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

/** A transform/opacity container. Its children remain evaluated visual nodes. */
export interface GroupNode extends RenderNodeBase {
  readonly kind: 'group';
  readonly children: readonly RenderNode[];
}

export type RenderNode = SpriteNode | VideoFrameNode | TextNode | GroupNode;
export type VisualRenderNode = Exclude<RenderNode, GroupNode>;

export interface RenderFrameIR {
  readonly version: 1;
  readonly compositionId: string;
  readonly timeUs: number;
  readonly viewport: Viewport;
  readonly background: Rgba;
  readonly nodes: readonly RenderNode[];
}

/** Editor-only affordances; deliberately excluded from RenderFrameIR/export. */
export interface EditorOverlayIR {
  readonly version: 1;
  readonly selections: readonly {
    readonly nodeId: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }[];
}

/** Fails fast at the execution boundary rather than allowing a renderer-specific crash. */
export function validateRenderFrameIR(frame: RenderFrameIR): void {
  if (frame.version !== 1)
    throw new RangeError(`unsupported RenderFrameIR version ${frame.version}`);
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
  validateNodes(frame.nodes, new Set<string>());
  assertRgba(frame.background, 'background');
}

/** Resolves group transforms and opacity into adapter-ready, draw-ordered visual nodes. */
export function flattenRenderNodes(nodes: readonly RenderNode[]): readonly VisualRenderNode[] {
  return nodes.flatMap((node) => flattenNode(node, IDENTITY_TRANSFORM, 1));
}

function validateNodes(nodes: readonly RenderNode[], ids: Set<string>): void {
  for (const node of nodes) {
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
    if (node.kind === 'group') {
      validateNodes(node.children, ids);
    } else {
      assertRgba(node.color, `node "${node.id}" color`);
    }
  }
}

const IDENTITY_TRANSFORM: Transform2D = {
  translateX: 0,
  translateY: 0,
  scaleX: 1,
  scaleY: 1,
};

function flattenNode(
  node: RenderNode,
  parentTransform: Transform2D,
  parentOpacity: number,
): readonly VisualRenderNode[] {
  const transform = composeTransform(parentTransform, node.transform);
  const opacity = parentOpacity * node.opacity;
  if (node.kind === 'group') {
    return node.children.flatMap((child) => flattenNode(child, transform, opacity));
  }
  return [{ ...node, transform, opacity }];
}

function composeTransform(parent: Transform2D, child: Transform2D): Transform2D {
  return {
    translateX: parent.translateX + child.translateX * parent.scaleX,
    translateY: parent.translateY + child.translateY * parent.scaleY,
    scaleX: parent.scaleX * child.scaleX,
    scaleY: parent.scaleY * child.scaleY,
  };
}

function assertRgba(color: Rgba, label: string): void {
  for (const [channel, value] of Object.entries(color)) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new RangeError(`${label}.${channel} must be an integer in [0, 255]`);
    }
  }
}
