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

import type {
  VisualObjectV1,
  VisualObjectTransformV1,
  ColorGradeV1,
  EffectInstanceV1,
} from '@joy-media/project-schema';
import type {
  RenderNode,
  RenderFrameIR,
  Rgba,
  Transform2D,
  EffectInstanceIR,
  ColorGradeIR,
} from '@joy-media/render-ir';
import type { TimeUs, TransitionV1 } from '@joy-media/project-schema';
import { resolveTransitionShaderId } from '@joy-media/transition-shaders';

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

/** Clip id → timeline start for transition window math. */
export type ClipTimingLookup = ReadonlyMap<string, { readonly startUs: TimeUs }>;

export interface BuildRenderFrameOptions {
  readonly transitions?: readonly TransitionV1[];
  /** Right-clip start times used to activate transitions at the junction. */
  readonly clipTimes?: ClipTimingLookup;
  readonly colorGrade?: ColorGradeV1 | ColorGradeIR;
  /** Per-object effect stacks from `VisualObjectV1.effects` (P16). */
  readonly effectsByObjectId?: Readonly<Record<string, readonly EffectInstanceV1[]>>;
  /** Intrinsic pixel size for image stickers when real bitmaps are available. */
  readonly imageSizesByObjectId?: Readonly<
    Record<string, { readonly width: number; readonly height: number }>
  >;
}

/**
 * Convert a single resolved object to its render node(s).
 *
 * - `image` → `video-frame` when size known (real RGBA arrives via bitmap map), else placeholder sprite
 * - `text`  → `text` node
 * - `shape` → `sprite` node tinted per shape
 * - `null` / `camera` → **undefined** (controllers render nothing)
 *
 * The transform is already resolved through parenting and camera projection by
 * the evaluator; this function only maps the kind to node type + content.
 */
export function visualObjectToRenderNode(
  resolved: ResolvedObject,
  effects?: readonly EffectInstanceIR[],
  imageSize?: { readonly width: number; readonly height: number },
  frameSize?: { readonly width: number; readonly height: number },
): RenderNode | undefined {
  const { object, transform } = resolved;
  if (object.kind === 'null' || object.kind === 'camera') return undefined;

  const renderTransform: Transform2D = transformToRenderTransform(transform);
  const opacity = transform.opacity;
  const effectList = effects && effects.length > 0 ? effects : undefined;

  if (object.kind === 'text') {
    return {
      kind: 'text',
      id: object.id,
      zIndex: 0,
      opacity,
      transform: renderTransform,
      text: object.text ?? '',
      color: WHITE,
      ...(effectList ? { effects: effectList } : {}),
    };
  }

  if (object.kind === 'html-scene') {
    // RGBA pixels arrive out-of-band via Pixi videoBitmaps keyed by object id.
    const viewport = imageSize ?? frameSize ?? { width: 1080, height: 1920 };
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
      ...(effectList ? { effects: effectList } : {}),
    };
  }

  if (object.kind === 'image' && imageSize !== undefined) {
    return {
      kind: 'video-frame',
      id: object.id,
      zIndex: 10,
      opacity,
      transform: renderTransform,
      width: imageSize.width,
      height: imageSize.height,
      sourceTimeUs: 0,
      color: { r: 0, g: 0, b: 0, a: 0 },
      ...(effectList ? { effects: effectList } : {}),
    };
  }

  // shape (or image without pixels) → sprite placeholder
  const color = shapeColor(object.kind === 'image' ? 'image' : 'shape', object.shape);
  return {
    kind: 'sprite',
    id: object.id,
    zIndex: 0,
    opacity,
    transform: renderTransform,
    width: 100,
    height: 100,
    color,
    ...(effectList ? { effects: effectList } : {}),
  };
}

/**
 * Convert a flat list of resolved objects (already sorted by z/draw order)
 * into a RenderFrameIR ready for renderer-pixi or renderer-headless.
 *
 * If transitions are provided, they are converted to transition render nodes
 * and included in the node list when active at `timeUs`.
 */
export function buildRenderFrameIR(
  compositionId: string,
  timeUs: TimeUs,
  width: number,
  height: number,
  resolvedObjects: readonly ResolvedObject[],
  transitionsOrOptions?: readonly TransitionV1[] | BuildRenderFrameOptions,
): RenderFrameIR {
  const options = resolveBuildOptions(transitionsOrOptions);

  const nodes: RenderNode[] = [];
  for (const resolved of resolvedObjects) {
    const effects = normalizeEffects(
      options.effectsByObjectId?.[resolved.object.id] ?? resolved.object.effects,
    );
    const imageSize = options.imageSizesByObjectId?.[resolved.object.id];
    const node = visualObjectToRenderNode(resolved, effects, imageSize, { width, height });
    if (node) nodes.push(node);
  }

  const clipTimes = options.clipTimes ?? EMPTY_CLIP_TIMES;
  if (options.transitions && options.transitions.length > 0) {
    const transitionNodes = options.transitions
      .filter((t) => isTransitionActive(t, timeUs, clipTimes))
      .map((t) => transitionToRenderNode(t, timeUs, width, height, clipTimes));
    nodes.push(...transitionNodes);
  }

  const colorGrade = options.colorGrade ? normalizeColorGrade(options.colorGrade) : undefined;

  return {
    version: 1,
    compositionId,
    timeUs,
    viewport: { width, height, dpr: 1 },
    background: DARK_BG,
    nodes,
    ...(colorGrade ? { colorGrade } : {}),
  };
}

function resolveBuildOptions(
  transitionsOrOptions?: readonly TransitionV1[] | BuildRenderFrameOptions,
): BuildRenderFrameOptions {
  if (transitionsOrOptions === undefined) return {};
  if (isTransitionList(transitionsOrOptions)) {
    return { transitions: transitionsOrOptions };
  }
  return transitionsOrOptions;
}

function isTransitionList(
  value: readonly TransitionV1[] | BuildRenderFrameOptions,
): value is readonly TransitionV1[] {
  return Array.isArray(value);
}

/** Build a clip-id → startUs map from composition tracks. */
export function clipTimesFromTracks(
  tracks: readonly {
    readonly clips: readonly { readonly id: string; readonly startUs: TimeUs }[];
  }[],
): ClipTimingLookup {
  const map = new Map<string, { readonly startUs: TimeUs }>();
  for (const track of tracks) {
    for (const clip of track.clips) {
      map.set(clip.id, { startUs: clip.startUs });
    }
  }
  return map;
}

/** Transition window: [right.startUs - durationUs, right.startUs). */
export function isTransitionActive(
  transition: TransitionV1,
  timeUs: TimeUs,
  clipTimes: ClipTimingLookup,
): boolean {
  const right = clipTimes.get(transition.rightClipId);
  if (!right) return false;
  const windowStart = right.startUs - transition.durationUs;
  const windowEnd = right.startUs;
  return timeUs >= windowStart && timeUs < windowEnd;
}

/** Progress 0..1 relative to the right-clip junction window. */
export function transitionProgress(
  transition: TransitionV1,
  timeUs: TimeUs,
  clipTimes: ClipTimingLookup,
): number {
  const right = clipTimes.get(transition.rightClipId);
  if (!right || transition.durationUs <= 0) return 0;
  const windowStart = right.startUs - transition.durationUs;
  return Math.min(1, Math.max(0, (timeUs - windowStart) / transition.durationUs));
}

/** Convert a TransitionV1 to a RenderNode for the renderer. */
function transitionToRenderNode(
  transition: TransitionV1,
  timeUs: TimeUs,
  width: number,
  height: number,
  clipTimes: ClipTimingLookup,
): RenderNode {
  const shaderId = resolveTransitionShaderId(transition.type);
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
    shaderId,
    progress: transitionProgress(transition, timeUs, clipTimes),
    leftClipId: transition.leftClipId,
    rightClipId: transition.rightClipId,
    ...(transition.params !== undefined ? { params: transition.params } : {}),
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

function normalizeEffects(
  instances: readonly EffectInstanceV1[] | undefined,
): readonly EffectInstanceIR[] | undefined {
  if (!instances?.length) return undefined;
  return instances.map((e): EffectInstanceIR => ({
    id: e.id,
    kind: e.effectId as EffectInstanceIR['kind'],
    enabled: e.enabled,
    params: mapParamsToNumbers(e.params),
  }));
}

function mapParamsToNumbers(
  params: Readonly<Record<string, import('@joy-media/project-schema').EffectParamValue>>,
): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'number') {
      out[key] = value;
    }
  }
  return out;
}

function isEffectKind(kind: string): kind is EffectInstanceIR['kind'] {
  return true;
}

function normalizeColorGrade(grade: ColorGradeV1 | ColorGradeIR): ColorGradeIR {
  return {
    lift: grade.lift,
    gamma: grade.gamma,
    gain: grade.gain,
    saturation: grade.saturation,
    ...(grade.lutId !== undefined ? { lutId: grade.lutId } : {}),
  };
}

// ---- palette ----
const WHITE: Rgba = Object.freeze({ r: 255, g: 255, b: 255, a: 255 });
const DARK_BG: Rgba = Object.freeze({ r: 12, g: 16, b: 28, a: 255 });
const EMPTY_CLIP_TIMES: ClipTimingLookup = new Map();

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
