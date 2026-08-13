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
  ColorGradeV2,
  ColorGradeV1,
  EffectInstanceV1,
  EffectParamValue,
  JoyProjectV1,
  VisualObjectTransformV1,
  VisualObjectV1,
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
import { mergeTransitionParams, resolveTransitionShaderId } from '@joy-media/transition-shaders';
import {
  evaluateColorGradeAtTime,
  evaluateFrameProperty,
  evaluateUniversalCameraTransform,
  sampleLegacyCurve,
} from '@joy-media/evaluator';
import { isColorLutReferenceAvailable } from '@joy-media/project-schema';

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
  readonly colorGrade?: ColorGradeV1 | ColorGradeV2 | ColorGradeIR;
  /** Per-object effect stacks from `VisualObjectV1.effects` (P16). */
  readonly effectsByObjectId?: Readonly<Record<string, readonly EffectInstanceV1[]>>;
  /** Universal property animation map used for frame-local effect sampling. */
  readonly propertyAnimations?: JoyProjectV1['propertyAnimations'];
  /** Intrinsic pixel size for image stickers when real bitmaps are available. */
  readonly imageSizesByObjectId?: Readonly<
    Record<string, { readonly width: number; readonly height: number }>
  >;
}

/**
 * Project-facing render entry point. Both browser monitor/export adapters consume
 * the resulting IR, so this is the single transform evaluation boundary.
 */
export function buildRenderFrameIRFromProject(
  project: JoyProjectV1,
  compositionId: string,
  timeUs: TimeUs,
  width: number,
  height: number,
  options: BuildRenderFrameOptions = {},
): RenderFrameIR {
  const composition = project.compositions[compositionId];
  if (composition === undefined) throw new RangeError(`unknown composition "${compositionId}"`);
  const resolvedObjects: ResolvedObject[] = Object.values(project.visualObjects).map((object) => {
    const resolved = evaluateUniversalCameraTransform(
      object.id,
      composition.activeCameraId,
      project.visualObjects,
      timeUs,
      height,
      project.propertyAnimations,
    );
    return {
      object,
      transform: resolved.transform,
      ...(resolved.diagnostics.length === 0 ? {} : { expressionDiagnostics: resolved.diagnostics }),
    };
  });
  return buildRenderFrameIR(compositionId, timeUs, width, height, resolvedObjects, {
    ...options,
    propertyAnimations: options.propertyAnimations ?? project.propertyAnimations,
    ...(options.colorGrade === undefined && project.colorGrade !== undefined
      ? {
          colorGrade:
            'version' in project.colorGrade && project.colorGrade.version === 2
              ? evaluateColorGradeAtTime(
                  project.colorGrade,
                  project.propertyAnimations,
                  { scope: 'output' },
                  { compositionTimeUs: timeUs, outputTimeUs: timeUs },
                  {
                    isLutReferenceAvailable: (reference) =>
                      reference !== undefined &&
                      isColorLutReferenceAvailable(reference, project.assets),
                  },
                )
              : project.colorGrade,
        }
      : {}),
  });
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
      timeUs,
      options.propertyAnimations,
    );
    const imageSize = options.imageSizesByObjectId?.[resolved.object.id];
    const node = visualObjectToRenderNode(resolved, effects, imageSize);
    if (node) nodes.push(node);
  }

  const clipTimes = options.clipTimes ?? EMPTY_CLIP_TIMES;
  if (options.transitions && options.transitions.length > 0) {
    const transitionNodes = options.transitions
      .filter((t) => isTransitionActive(t, timeUs, clipTimes))
      .map((t) =>
        transitionToRenderNode(t, timeUs, width, height, clipTimes, options.propertyAnimations),
      );
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
  propertyAnimations: JoyProjectV1['propertyAnimations'] | undefined,
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
    params: sampleTransitionParams(transition, timeUs, clipTimes, propertyAnimations),
  };
}

/** Resolve declared numeric uniforms against the transition-local clock. */
export function sampleTransitionParams(
  transition: TransitionV1,
  timeUs: TimeUs,
  clipTimes: ClipTimingLookup,
  propertyAnimations: JoyProjectV1['propertyAnimations'] | undefined,
): Readonly<Record<string, number>> {
  const right = clipTimes.get(transition.rightClipId);
  const defaults = mergeTransitionParams(transition.type, transition.params);
  if (right === undefined) return numericParams(defaults);
  const range = {
    startUs: right.startUs - transition.durationUs,
    durationUs: transition.durationUs,
  };
  const params: Record<string, number> = {};
  for (const [propertyId, staticValue] of Object.entries(defaults)) {
    if (typeof staticValue !== 'number') continue;
    const binding = {
      ownerKind: 'transition' as const,
      ownerId: transition.id,
      propertyId,
      timeDomain: 'transition-local' as const,
    };
    const evaluated = evaluateFrameProperty<number>({
      binding,
      staticValue,
      ...(propertyAnimations === undefined ? {} : { animations: propertyAnimations }),
      time: { compositionTimeUs: timeUs, transition: range },
      normalize: (value) =>
        typeof value === 'number' && Number.isFinite(value) ? value : staticValue,
    });
    params[propertyId] = evaluated.value;
  }
  return params;
}

function numericParams(
  params: Readonly<Record<string, number | readonly number[]>>,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(params).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
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
  timeUs: TimeUs,
  propertyAnimations: JoyProjectV1['propertyAnimations'] | undefined,
): readonly EffectInstanceIR[] | undefined {
  if (!instances?.length) return undefined;
  return instances.map((e): EffectInstanceIR => ({
    id: e.id,
    kind: e.effectId as EffectInstanceIR['kind'],
    enabled: e.enabled,
    params: mapParamsToNumbers(sampleEffectParams(e, timeUs, propertyAnimations)),
  }));
}

/** Samples each legacy scalar effect curve at the RenderFrameIR composition time. */
export function sampleEffectParams(
  effect: EffectInstanceV1,
  timeUs: TimeUs,
  propertyAnimations?: JoyProjectV1['propertyAnimations'],
): Readonly<Record<string, EffectParamValue>> {
  const params = { ...effect.params };
  for (const [key, value] of Object.entries(effect.params)) {
    if (typeof value !== 'number') continue;
    const binding = {
      ownerKind: 'object-effect' as const,
      ownerId: effect.id,
      propertyId: key,
      timeDomain: 'composition' as const,
    };
    const legacyCurve = effect.animations?.[key];
    const evaluated = evaluateFrameProperty<number>({
      binding,
      staticValue: value,
      ...(propertyAnimations === undefined ? {} : { animations: propertyAnimations }),
      ...(legacyCurve === undefined
        ? {}
        : {
            legacy: {
              sample: (sampleTimeUs: TimeUs) => sampleLegacyCurve(legacyCurve, sampleTimeUs),
            },
          }),
      time: { compositionTimeUs: timeUs },
      normalize: (next) => (typeof next === 'number' ? next : value),
    });
    params[key] = evaluated.value;
  }
  return params;
}

function mapParamsToNumbers(
  params: Readonly<Record<string, EffectParamValue>>,
): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'number') {
      out[key] = value;
    }
  }
  return out;
}

export function normalizeColorGrade(
  grade: ColorGradeV1 | ColorGradeV2 | ColorGradeIR,
): ColorGradeIR {
  if ('version' in grade && grade.version === 2) {
    const adjust = grade.adjust;
    const wheels = grade.wheels;
    return {
      version: 2,
      ...(grade.enabled === undefined ? {} : { enabled: grade.enabled }),
      lift: wheels?.lift.master ?? 0,
      gamma: 1 + (wheels?.gamma.master ?? 0),
      gain: 1 + (wheels?.gain.master ?? 0),
      saturation: adjust?.saturation ?? grade.saturation ?? 1,
      ...(adjust === undefined ? {} : { adjust }),
      ...(wheels === undefined ? {} : { wheels }),
      ...(grade.curves === undefined ? {} : { curves: grade.curves }),
      ...(grade.hsl === undefined ? {} : { hsl: grade.hsl }),
      ...(grade.lut === undefined ? {} : { lut: grade.lut }),
      ...(grade.outputSafety === undefined ? {} : { outputSafety: grade.outputSafety }),
    };
  }
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
