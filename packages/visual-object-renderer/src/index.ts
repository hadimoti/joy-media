/**
 * VisualObjectV1 → RenderNode conversion bridge.
 *
 * The missing link documented in P10's gate review: no function anywhere
 * converted VisualObjectV1 into RenderNode/RenderFrameIR. This closes that gap.
 *
 * Every object kind maps to one or more RenderNodes. `kind: 'null'` and
 * `kind: 'camera'` render nothing (controllers) but their children inherit the
 * resolved transform. All other kinds produce visual nodes — their actual pixel
 * content is abstract (color-fills for now, resolved assets later).
 */

import type { VisualObjectV1, VisualObjectTransformV1 } from '@joy-media/project-schema';
import type { RenderNode, RenderFrameIR, Rgba, Transform2D } from '@joy-media/render-ir';
import type { TimeUs } from '@joy-media/project-schema';

export interface ResolvedObject {
  readonly object: VisualObjectV1;
  /** World transform after parenting + camera projection (if any). */
  readonly transform: VisualObjectTransformV1;
  /** Expression diagnostics from the evaluation pass, if any. */
  readonly expressionDiagnostics?: readonly {
    readonly channel: string;
    readonly message: string;
  }[];
}

/**
 * Convert a single resolved object to its render node(s).
 *
 * - `image` → `sprite` node (placeholder color until asset resolution lands)
 * - `text`  → `text` node
 * - `shape` → `sprite` node tinted per shape
 * - `null` / `camera` → **undefined** (controllers render nothing)
 *
 * The transform is already resolved through parenting and camera projection by
 * the evaluator; this function only maps the kind to node type + content.
 */
export function visualObjectToRenderNode(resolved: ResolvedObject): RenderNode | undefined {
  const { object, transform } = resolved;
  if (object.kind === 'null' || object.kind === 'camera') return undefined;

  const renderTransform: Transform2D = transformToRenderTransform(transform);
  const opacity = transform.opacity;

  if (object.kind === 'text') {
    return {
      kind: 'text',
      id: object.id,
      zIndex: 0,
      opacity,
      transform: renderTransform,
      text: object.text ?? '',
      color: WHITE,
    };
  }

  if (object.kind === 'html-scene') {
    // RGBA pixels arrive out-of-band via Pixi videoBitmaps keyed by object id.
    const viewport = { width: 1080, height: 1920 };
    return {
      kind: 'video-frame',
      id: object.id,
      zIndex: 0,
      opacity,
      transform: renderTransform,
      width: viewport.width,
      height: viewport.height,
      sourceTimeUs: 0,
      color: { r: 0, g: 0, b: 0, a: 0 },
    };
  }

  // image / shape → sprite node
  const color = shapeColor(object.kind, object.shape);
  return {
    kind: 'sprite',
    id: object.id,
    zIndex: 0,
    opacity,
    transform: renderTransform,
    width: 100, // placeholder — real asset resolution will replace
    height: 100, // placeholder
    color,
  };
}

/**
 * Convert a flat list of resolved objects (already sorted by z/draw order)
 * into a RenderFrameIR ready for renderer-pixi or renderer-headless.
 */
export function buildRenderFrameIR(
  compositionId: string,
  timeUs: TimeUs,
  width: number,
  height: number,
  resolvedObjects: readonly ResolvedObject[],
): RenderFrameIR {
  const nodes: RenderNode[] = [];
  for (const resolved of resolvedObjects) {
    const node = visualObjectToRenderNode(resolved);
    if (node) nodes.push(node);
  }
  return {
    version: 1,
    compositionId,
    timeUs,
    viewport: { width, height, dpr: 1 },
    background: DARK_BG,
    nodes,
  };
}

/** Convert VisualObjectTransformV1 → render-ir Transform2D. */
export function transformToRenderTransform(t: VisualObjectTransformV1): Transform2D {
  return {
    translateX: t.x,
    translateY: t.y,
    scaleX: t.scaleX,
    scaleY: t.scaleY,
  };
}

// ---- palette ----
const WHITE: Rgba = Object.freeze({ r: 255, g: 255, b: 255, a: 255 });
const DARK_BG: Rgba = Object.freeze({ r: 12, g: 16, b: 28, a: 255 });

function shapeColor(
  kind: 'image' | 'text' | 'shape' | 'null' | 'camera' | 'html-scene',
  shape?: 'rectangle' | 'ellipse',
): Rgba {
  switch (kind) {
    case 'shape':
      return shape === 'rectangle'
        ? { r: 247, g: 185, b: 40, a: 255 }
        : { r: 67, g: 137, b: 255, a: 255 };
    case 'image':
      return { r: 180, g: 180, b: 180, a: 255 }; // placeholder gray
    default:
      return WHITE;
  }
}
