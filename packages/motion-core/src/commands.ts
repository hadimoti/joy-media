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

export type MotionCommand = ReplaceAnimationCommand;

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

/** Applies a motion command to the durable v1 project, capturing a pre-state inverse. */
export function applyMotionProjectCommand(
  project: JoyProjectV1,
  command: MotionCommand,
): MotionApplyResult {
  const { objectId, property, curve } = command.payload;
  const object = project.visualObjects[objectId];
  if (object === undefined) throw new MotionCommandError(`unknown visual object ${objectId}`);
  if (curve !== undefined) {
    const diagnostics: ProjectDiagnostic[] = [];
    validateAnimationCurve(curve, `${objectId}.animations.${property}`, diagnostics);
    if (diagnostics.length > 0) throw new MotionCommandError(diagnostics[0]!.message, diagnostics);
  }
  const previous = object.animations?.[property];
  const nextObject = replaceChannel(object, property, curve);
  const inverse: MotionCommand = {
    type: 'object.replaceAnimation',
    payload:
      previous === undefined ? { objectId, property } : { objectId, property, curve: previous },
  };
  return {
    project: {
      ...project,
      visualObjects: { ...project.visualObjects, [objectId]: nextObject },
    },
    inverse,
  };
}
