import type { JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
import { flattenRenderNodes, type RenderFrameIR, type Transform2D } from '@joy-media/render-ir';
import { evaluateCameraExpressionTransform } from '@joy-media/evaluator';
import { clipIdToObjectId, isCaptionNodeId } from './monitor-ids.js';
import type { MonitorElement } from './monitor-selection.js';
import {
  boxGeometry,
  parentSpaceInvertible,
  type LocalTransform,
  type ParentTransform,
  type TransformBoxGeometry,
} from './monitor-transform-maths.js';

/**
 * What the transform box can edit (ADR-0046 section 5 and review B4, T-M05a):
 * one target per drawn node of a selected clip, with the document object it
 * writes, the box the renderer drew, the parent the values are local to, and,
 * for each gesture, why it is not allowed when it is not.
 */

export type MonitorTransformGestureKind = 'move' | 'scale' | 'rotate';

export type TransformBlockReason =
  | 'agent-preview'
  | 'no-object'
  | 'locked'
  | 'camera'
  | 'parent-zero-scale'
  | 'expression'
  | 'animated';

/** The tooltip of a greyed handle, in plain words. */
export const TRANSFORM_BLOCK_MESSAGES: Readonly<Record<TransformBlockReason, string>> = {
  'agent-preview': 'An agent preview is on screen. Keep or discard it before editing.',
  'no-object': 'This element is not placed by a transform (captions follow their style).',
  locked: 'The track is locked.',
  camera: 'The camera places this element. Change the camera instead.',
  'parent-zero-scale': 'The parent has no size, so this element cannot be moved or scaled here.',
  expression: 'An expression sets this value. Edit the expression in the Inspector.',
  animated: 'This value is animated. Change it with keyframes in the Inspector for now.',
};

/** The document values each gesture writes. */
export const GESTURE_CHANNELS: Readonly<
  Record<MonitorTransformGestureKind, readonly (keyof LocalTransform)[]>
> = {
  move: ['x', 'y'],
  scale: ['x', 'y', 'scaleX', 'scaleY'],
  rotate: ['rotationDeg'],
};

export interface MonitorTransformTarget {
  /** The drawn node (as in `RenderFrameIR` and `nodeBounds`). */
  readonly nodeId: string;
  /** The timeline clip that is selected. */
  readonly clipId: string;
  /** The visual object the gesture writes, when there is one. */
  readonly objectId?: string;
  /** The box as drawn. */
  readonly geometry: TransformBoxGeometry;
  /** The object's own (document) values, local to its parent. */
  readonly local: LocalTransform;
  /** The parent's world values, when the object has a parent. */
  readonly parent?: ParentTransform;
  /** Why a gesture is not allowed, per gesture. */
  readonly blocked: Readonly<Partial<Record<MonitorTransformGestureKind, TransformBlockReason>>>;
}

export interface MonitorTransformTargetsInput {
  /** The drawn elements (`buildMonitorElements`). */
  readonly elements: readonly MonitorElement[];
  /** The frame they were drawn from. */
  readonly frame: RenderFrameIR;
  /** The visual project that was drawn. */
  readonly project: JoyProjectV1;
  /** The selected clips (the shared timeline selection). */
  readonly selectedClipIds: readonly string[];
  /** The playhead (for the parent's world values). */
  readonly timeUs: number;
  /** True while an agent's staged preview is on screen: nothing can be edited. */
  readonly agentPreviewOnScreen: boolean;
}

/** The object a drawn node belongs to: its own id, or a video clip's bound object. */
export function objectIdForNode(
  project: JoyProjectV1,
  nodeId: string,
  clipId: string,
): string | undefined {
  if (isCaptionNodeId(nodeId)) return undefined;
  if (project.visualObjects[nodeId] !== undefined) return nodeId;
  return nodeId === clipId ? clipIdToObjectId(project, clipId) : undefined;
}

function parentWorld(
  project: JoyProjectV1,
  object: VisualObjectV1,
  timeUs: number,
  height: number,
): ParentTransform | undefined {
  if (object.parentId === undefined || project.visualObjects[object.parentId] === undefined)
    return undefined;
  const world = evaluateCameraExpressionTransform(
    object.parentId,
    undefined,
    project.visualObjects as Readonly<Record<string, VisualObjectV1>>,
    timeUs,
    height,
  ).transform;
  return {
    x: world.x,
    y: world.y,
    scaleX: world.scaleX,
    scaleY: world.scaleY,
    rotationDeg: world.rotationDeg,
  };
}

function channelReason(
  object: VisualObjectV1,
  channels: readonly (keyof LocalTransform)[],
): TransformBlockReason | undefined {
  if (channels.some((channel) => object.expressions?.[channel] !== undefined)) return 'expression';
  if (channels.some((channel) => object.animations?.[channel] !== undefined)) return 'animated';
  return undefined;
}

function blockedGestures(
  reasonForAll: TransformBlockReason | undefined,
  object: VisualObjectV1 | undefined,
  parent: ParentTransform | undefined,
): MonitorTransformTarget['blocked'] {
  const blocked: Partial<Record<MonitorTransformGestureKind, TransformBlockReason>> = {};
  for (const gesture of ['move', 'scale', 'rotate'] as const) {
    let reason = reasonForAll;
    if (reason === undefined && gesture !== 'rotate' && !parentSpaceInvertible(parent))
      reason = 'parent-zero-scale';
    if (reason === undefined && object !== undefined)
      reason = channelReason(object, GESTURE_CHANNELS[gesture]);
    if (reason !== undefined) blocked[gesture] = reason;
  }
  return blocked;
}

/**
 * The targets of the selected clips that are drawn on this frame, topmost
 * first (the order of `elements`). A hidden element is not drawn and has no
 * target.
 */
export function buildTransformTargets(
  input: MonitorTransformTargetsInput,
): readonly MonitorTransformTarget[] {
  const selected = new Set(input.selectedClipIds);
  if (selected.size === 0) return [];
  const transforms = new Map<string, Transform2D>(
    flattenRenderNodes(input.frame.nodes).map((node) => [node.id, node.transform]),
  );
  const composition = input.project.compositions[input.project.rootCompositionId];
  const height = composition?.height ?? input.frame.viewport.height;
  const camera = composition?.activeCameraId !== undefined;
  const targets: MonitorTransformTarget[] = [];
  for (const element of input.elements) {
    if (!selected.has(element.clipId) || element.hidden === true) continue;
    const transform = transforms.get(element.id);
    if (transform === undefined) continue;
    const objectId = objectIdForNode(input.project, element.id, element.clipId);
    const object = objectId === undefined ? undefined : input.project.visualObjects[objectId];
    const parent =
      object === undefined ? undefined : parentWorld(input.project, object, input.timeUs, height);
    const reasonForAll: TransformBlockReason | undefined = input.agentPreviewOnScreen
      ? 'agent-preview'
      : object === undefined
        ? 'no-object'
        : element.locked === true
          ? 'locked'
          : camera
            ? 'camera'
            : undefined;
    const local: LocalTransform =
      object === undefined
        ? { x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0 }
        : {
            x: object.transform.x,
            y: object.transform.y,
            scaleX: object.transform.scaleX,
            scaleY: object.transform.scaleY,
            rotationDeg: object.transform.rotationDeg,
          };
    targets.push({
      nodeId: element.id,
      clipId: element.clipId,
      ...(objectId === undefined ? {} : { objectId }),
      geometry: boxGeometry(element.bounds, transform),
      local,
      ...(parent === undefined ? {} : { parent }),
      blocked: blockedGestures(reasonForAll, object, parent),
    });
  }
  return targets;
}

/** Why a gesture cannot run on these targets (the first reason found), or `undefined`. */
export function gestureBlockReason(
  targets: readonly MonitorTransformTarget[],
  gesture: MonitorTransformGestureKind,
): TransformBlockReason | undefined {
  if (targets.length === 0) return undefined;
  for (const target of targets) {
    const reason = target.blocked[gesture];
    if (reason !== undefined) return reason;
  }
  return undefined;
}
