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
import type { RenderNode, RenderFrameIR, Rgba, Transform2D, TransitionNode } from '@joy-media/render-ir';
import type { TimeUs, TransitionV1 } from '@joy-media/project-schema';

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
 *
 * If transitions are provided, they are converted to transition render nodes
 * and included in the node list.
 */
export function buildRenderFrameIR(
  compositionId: string,
  timeUs: TimeUs,
  width: number,
  height: number,
  resolvedObjects: readonly ResolvedObject[],
  transitions?: readonly TransitionV1[],
): RenderFrameIR {
  const nodes: RenderNode[] = [];
  for (const resolved of resolvedObjects) {
    const node = visualObjectToRenderNode(resolved);
    if (node) nodes.push(node);
  }

  // Add transition nodes if transitions are provided and active at this time
  if (transitions && transitions.length > 0) {
    const transitionNodes = transitions
      .filter((t) => isTransitionActive(t, timeUs))
      .map((t) => transitionToRenderNode(t, timeUs, width, height));
    nodes.push(...transitionNodes);
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

/** Check if a transition is active at the given time. */
function isTransitionActive(transition: TransitionV1, timeUs: TimeUs): boolean {
  // We need to find the right clip's start time to know when the transition starts
  // For now, we'll assume the transition starts at the right clip's startUs - durationUs
  // This is a simplification; a full implementation would look up the clips
  return true; // Placeholder - full implementation needs clip timing
}

/** Convert a TransitionV1 to a RenderNode for the renderer. */
function transitionToRenderNode(
  transition: TransitionV1,
  timeUs: TimeUs,
  width: number,
  height: number,
): RenderNode {
  // Calculate progress through transition (0 to 1)
  const progress = Math.min(1, Math.max(0, timeUs / transition.durationUs));

  return {
    kind: 'transition',
    id: `transition-${transition.id}`,
    zIndex: 1000, // Render on top of normal content
    opacity: 1,
    transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
    width,
    height,
    color: { r: 0, g: 0, b: 0, a: 0 },
    transitionType: transition.type,
    progress,
    leftClipId: transition.leftClipId,
    rightClipId: transition.rightClipId,
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
