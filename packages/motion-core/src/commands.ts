/**
 * Durable motion commands. A keyframe edit replaces one channel's whole curve
 * atomically, so the inverse is simply the prior curve (or its absence). This
 * mirrors the caption `replaceDocument` shape and lets keyframe edits ride the
 * shared v1 command history for undo/redo and persistence.
 */

import type {
  AnimatablePropertyV1,
  AnimationCurveV1,
  JoyProjectV1,
  ProjectDiagnostic,
  VisualObjectV1,
} from '@joy-media/project-schema';
import { validateAnimationCurve } from '@joy-media/project-schema';
import type { ObjectAnimations } from './transform.js';

export interface ReplaceAnimationCommand {
  readonly type: 'object.replaceAnimation';
  readonly payload: {
    readonly objectId: string;
    readonly property: AnimatablePropertyV1;
    /** The channel's new curve, or `undefined` to remove the channel. */
    readonly curve?: AnimationCurveV1;
  };
}

export interface SetParentCommand {
  readonly type: 'object.setParent';
  readonly payload: {
    readonly objectId: string;
    /** The new parent id, or `undefined` to unparent. */
    readonly parentId?: string;
  };
}

export type MotionCommand = ReplaceAnimationCommand | SetParentCommand;

export interface MotionApplyResult {
  readonly project: JoyProjectV1;
  readonly inverse: MotionCommand;
}

export class MotionCommandError extends Error {
  constructor(
    message: string,
    readonly diagnostics: readonly ProjectDiagnostic[] = [],
  ) {
    super(message);
    this.name = 'MotionCommandError';
  }
}

function replaceChannel(
  object: VisualObjectV1,
  property: AnimatablePropertyV1,
  curve: AnimationCurveV1 | undefined,
): VisualObjectV1 {
  const next: Record<string, AnimationCurveV1> = { ...(object.animations ?? {}) };
  if (curve === undefined) delete next[property];
  else next[property] = curve;
  const cleaned = { ...object };
  if (Object.keys(next).length === 0) delete cleaned.animations;
  else cleaned.animations = next as ObjectAnimations;
  return cleaned;
}

function withParent(object: VisualObjectV1, parentId: string | undefined): VisualObjectV1 {
  const cleaned = { ...object };
  if (parentId === undefined) delete cleaned.parentId;
  else cleaned.parentId = parentId;
  return cleaned;
}

/** True when making `parentId` the parent of `objectId` would close a cycle. */
function wouldCycle(
  objectId: string,
  parentId: string,
  visualObjects: Readonly<Record<string, VisualObjectV1>>,
): boolean {
  let current: string | undefined = parentId;
  const seen = new Set<string>();
  while (current !== undefined) {
    if (current === objectId) return true;
    if (seen.has(current)) return false; // pre-existing cycle, not ours to judge here
    seen.add(current);
    current = visualObjects[current]?.parentId;
  }
  return false;
}

function commit(
  project: JoyProjectV1,
  objectId: string,
  nextObject: VisualObjectV1,
  inverse: MotionCommand,
): MotionApplyResult {
  return {
    project: {
      ...project,
      visualObjects: { ...project.visualObjects, [objectId]: nextObject },
    },
    inverse,
  };
}

/** Applies a motion command to the durable v1 project, capturing a pre-state inverse. */
export function applyMotionProjectCommand(
  project: JoyProjectV1,
  command: MotionCommand,
): MotionApplyResult {
  const { objectId } = command.payload;
  const object = project.visualObjects[objectId];
  if (object === undefined) throw new MotionCommandError(`unknown visual object ${objectId}`);

  if (command.type === 'object.setParent') {
    const parentId = command.payload.parentId;
    if (parentId !== undefined) {
      if (parentId === objectId) throw new MotionCommandError('an object cannot be its own parent');
      if (project.visualObjects[parentId] === undefined)
        throw new MotionCommandError(`unknown parent object ${parentId}`);
      if (wouldCycle(objectId, parentId, project.visualObjects))
        throw new MotionCommandError('parenting would create a cycle');
    }
    const previous = object.parentId;
    const inverse: MotionCommand = {
      type: 'object.setParent',
      payload: previous === undefined ? { objectId } : { objectId, parentId: previous },
    };
    return commit(project, objectId, withParent(object, parentId), inverse);
  }

  const { property, curve } = command.payload;
  if (curve !== undefined) {
    const diagnostics: ProjectDiagnostic[] = [];
    validateAnimationCurve(curve, `${objectId}.animations.${property}`, diagnostics);
    if (diagnostics.length > 0) throw new MotionCommandError(diagnostics[0]!.message, diagnostics);
  }
  const previous = object.animations?.[property];
  const inverse: MotionCommand = {
    type: 'object.replaceAnimation',
    payload:
      previous === undefined ? { objectId, property } : { objectId, property, curve: previous },
  };
  return commit(project, objectId, replaceChannel(object, property, curve), inverse);
}
