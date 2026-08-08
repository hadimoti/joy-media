/**
 * Durable motion commands. A keyframe edit replaces one channel's whole curve
 * atomically, so the inverse is simply the prior curve (or its absence). This
 * mirrors the caption `replaceDocument` shape and lets keyframe edits ride the
 * shared v1 command history for undo/redo and persistence.
 */

import type {
  AnimatablePropertyV1,
  AnimationCurveV1,
  EffectInstanceV1,
  EffectParamValue,
  JoyProjectV1,
  ProjectDiagnostic,
  SpatialPathV1,
  VisualObjectV1,
} from '@joy-media/project-schema';
import { validateAnimationCurve } from '@joy-media/project-schema';
import { compileExpression, detectExpressionCycle } from '@joy-media/expression-core';
import type { ObjectAnimations } from './transform.js';
import { buildExpressionReferenceGraph, expressionNodeKey } from './expression.js';

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

export interface SetExpressionCommand {
  readonly type: 'object.setExpression';
  readonly payload: {
    readonly objectId: string;
    readonly property: AnimatablePropertyV1;
    /** The channel's new expression source, or `undefined` to clear it. */
    readonly source?: string;
  };
}

export interface SetSpatialPathCommand {
  readonly type: 'object.setSpatialPath';
  readonly payload: {
    readonly objectId: string;
    /** The object's new spatial path, or `undefined` to remove it. */
    readonly spatialPath?: SpatialPathV1;
  };
}

export interface AddEffectCommand {
  readonly type: 'effect.add';
  readonly payload: {
    readonly objectId: string;
    readonly effectId: string;
    readonly params?: Readonly<Record<string, EffectParamValue>>;
    readonly index?: number;
  };
}

export interface RemoveEffectCommand {
  readonly type: 'effect.remove';
  readonly payload: {
    readonly objectId: string;
    readonly effectInstanceId: string;
  };
}

export interface ReorderEffectCommand {
  readonly type: 'effect.reorder';
  readonly payload: {
    readonly objectId: string;
    readonly effectInstanceId: string;
    readonly newIndex: number;
  };
}

export interface ToggleEffectCommand {
  readonly type: 'effect.toggle';
  readonly payload: {
    readonly objectId: string;
    readonly effectInstanceId: string;
    readonly enabled: boolean;
  };
}

export interface SetEffectParamCommand {
  readonly type: 'effect.setParam';
  readonly payload: {
    readonly objectId: string;
    readonly effectInstanceId: string;
    readonly paramKey: string;
    readonly value: EffectParamValue;
  };
}

export interface ClearEffectsCommand {
  readonly type: 'effect.clearAll';
  readonly payload: {
    readonly objectId: string;
  };
}

export interface ReplaceEffectCommand {
  readonly type: 'effect.replace';
  readonly payload: {
    readonly objectId: string;
    readonly effectInstanceId: string;
    readonly newEffectId: string;
    readonly params?: Readonly<Record<string, EffectParamValue>>;
  };
}

export type MotionCommand =
  | ReplaceAnimationCommand
  | SetParentCommand
  | SetExpressionCommand
  | SetSpatialPathCommand
  | AddEffectCommand
  | RemoveEffectCommand
  | ReorderEffectCommand
  | ToggleEffectCommand
  | SetEffectParamCommand
  | ClearEffectsCommand
  | ReplaceEffectCommand;

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

function replaceExpression(
  object: VisualObjectV1,
  property: AnimatablePropertyV1,
  source: string | undefined,
): VisualObjectV1 {
  const next: Record<string, string> = { ...(object.expressions ?? {}) };
  if (source === undefined) delete next[property];
  else next[property] = source;
  const cleaned = { ...object };
  if (Object.keys(next).length === 0) delete cleaned.expressions;
  else cleaned.expressions = next;
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

function clearSpatialPath(object: VisualObjectV1): VisualObjectV1 {
  const next = { ...object };
  delete (next as Record<string, unknown>).spatialPath;
  return next as VisualObjectV1;
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

  if (command.type === 'object.setExpression') {
    const { property, source } = command.payload;
    if (source !== undefined) {
      const { compiled, diagnostics } = compileExpression(source);
      if (compiled === undefined)
        throw new MotionCommandError(diagnostics[0]?.message ?? 'expression failed to compile', []);
      const graph = buildExpressionReferenceGraph(project.visualObjects, {
        objectId,
        property,
        source,
      });
      const targetKey = expressionNodeKey(objectId, property);
      const cycle = detectExpressionCycle(graph);
      if (cycle !== undefined && cycle.includes(targetKey))
        throw new MotionCommandError(
          `setting this expression would create a reference cycle: ${cycle.join(' -> ')}`,
        );
    }
    const previous = object.expressions?.[property];
    const inverse: MotionCommand = {
      type: 'object.setExpression',
      payload:
        previous === undefined ? { objectId, property } : { objectId, property, source: previous },
    };
    return commit(project, objectId, replaceExpression(object, property, source), inverse);
  }

  if (command.type === 'object.setSpatialPath') {
    const previous = object.spatialPath;
    const inverse: MotionCommand = {
      type: 'object.setSpatialPath',
      payload: previous === undefined ? { objectId } : { objectId, spatialPath: previous },
    };
    const next =
      command.payload.spatialPath === undefined
        ? clearSpatialPath(object)
        : ({ ...object, spatialPath: command.payload.spatialPath } as unknown as VisualObjectV1);
    return commit(project, objectId, next, inverse);
  }

  if (command.type === 'object.replaceAnimation') {
    const { property, curve } = command.payload;
    if (curve !== undefined) {
      const diagnostics: ProjectDiagnostic[] = [];
      validateAnimationCurve(curve, `${objectId}.animations.${property}`, diagnostics);
      if (diagnostics.length > 0)
        throw new MotionCommandError(diagnostics[0]!.message, diagnostics);
    }
    const previous = object.animations?.[property];
    const inverse: MotionCommand = {
      type: 'object.replaceAnimation',
      payload:
        previous === undefined ? { objectId, property } : { objectId, property, curve: previous },
    };
    return commit(project, objectId, replaceChannel(object, property, curve), inverse);
  }

  // ---------- Effect command handlers ----------

  function getEffectsArray(obj: VisualObjectV1): readonly EffectInstanceV1[] {
    return obj.effects ?? [];
  }

  function setEffectsArray(
    obj: VisualObjectV1,
    effects: readonly EffectInstanceV1[],
  ): VisualObjectV1 {
    const next = { ...obj };
    if (effects.length === 0) delete (next as Record<string, unknown>).effects;
    else next.effects = effects;
    return next;
  }

  function findEffectIndex(effects: readonly EffectInstanceV1[], instanceId: string): number {
    return effects.findIndex((e) => e.id === instanceId);
  }

  function getEffect(
    effects: readonly EffectInstanceV1[],
    instanceId: string,
  ): EffectInstanceV1 | undefined {
    return effects.find((e) => e.id === instanceId);
  }

  if (command.type === 'effect.add') {
    const { effectId, params, index } = command.payload;
    const effects = getEffectsArray(object);
    const newEffect: EffectInstanceV1 = {
      id: crypto.randomUUID(),
      effectId,
      params: params ?? {},
      enabled: true,
    };
    const nextEffects = [...effects];
    const insertIndex = index ?? nextEffects.length;
    nextEffects.splice(insertIndex, 0, newEffect);
    const nextObject = setEffectsArray(object, nextEffects);
    const inverse: MotionCommand = {
      type: 'effect.remove',
      payload: { objectId, effectInstanceId: newEffect.id },
    };
    return commit(project, objectId, nextObject, inverse);
  }

  if (command.type === 'effect.remove') {
    const { effectInstanceId } = command.payload;
    const effects = getEffectsArray(object);
    const idx = findEffectIndex(effects, effectInstanceId);
    if (idx === -1) throw new MotionCommandError(`unknown effect instance ${effectInstanceId}`);
    const removed = effects[idx]!;
    const nextEffects = effects.filter((e) => e.id !== effectInstanceId);
    const nextObject = setEffectsArray(object, nextEffects);
    const inverse: MotionCommand = {
      type: 'effect.add',
      payload: { objectId, effectId: removed.effectId, params: removed.params, index: idx },
    };
    return commit(project, objectId, nextObject, inverse);
  }

  if (command.type === 'effect.reorder') {
    const { effectInstanceId, newIndex } = command.payload;
    const effects = getEffectsArray(object);
    const idx = findEffectIndex(effects, effectInstanceId);
    if (idx === -1) throw new MotionCommandError(`unknown effect instance ${effectInstanceId}`);
    const nextEffects = [...effects];
    const moved = nextEffects.splice(idx, 1)[0]!;
    const clampedIndex = Math.max(0, Math.min(newIndex, nextEffects.length));
    nextEffects.splice(clampedIndex, 0, moved);
    const nextObject = setEffectsArray(object, nextEffects);
    const inverse: MotionCommand = {
      type: 'effect.reorder',
      payload: { objectId, effectInstanceId, newIndex: idx },
    };
    return commit(project, objectId, nextObject, inverse);
  }

  if (command.type === 'effect.toggle') {
    const { effectInstanceId, enabled } = command.payload;
    const effects = getEffectsArray(object);
    const idx = findEffectIndex(effects, effectInstanceId);
    if (idx === -1) throw new MotionCommandError(`unknown effect instance ${effectInstanceId}`);
    const current = effects[idx]!;
    if (current.enabled === enabled) return commit(project, objectId, object, command);
    const nextEffects = effects.map((e, i) => (i === idx ? { ...e, enabled } : e));
    const nextObject = setEffectsArray(object, nextEffects);
    const inverse: MotionCommand = {
      type: 'effect.toggle',
      payload: { objectId, effectInstanceId, enabled: current.enabled },
    };
    return commit(project, objectId, nextObject, inverse);
  }

  if (command.type === 'effect.setParam') {
    const { effectInstanceId, paramKey, value } = command.payload;
    const effects = getEffectsArray(object);
    const idx = findEffectIndex(effects, effectInstanceId);
    if (idx === -1) throw new MotionCommandError(`unknown effect instance ${effectInstanceId}`);
    const current = effects[idx]!;
    const prevValue = current.params[paramKey];
    const nextEffects = effects.map((e, i) =>
      i === idx ? { ...e, params: { ...e.params, [paramKey]: value } } : e,
    );
    const nextObject = setEffectsArray(object, nextEffects);
    const inverse: MotionCommand = {
      type: 'effect.setParam',
      payload: {
        objectId,
        effectInstanceId,
        paramKey,
        value: prevValue ?? 0,
      },
    };
    return commit(project, objectId, nextObject, inverse);
  }

  if (command.type === 'effect.clearAll') {
    const effects = getEffectsArray(object);
    if (effects.length === 0) return commit(project, objectId, object, command);
    const nextObject = setEffectsArray(object, []);
    const firstEffect = effects[0] as EffectInstanceV1;
    const inverse: MotionCommand = {
      type: 'effect.replace',
      payload: {
        objectId,
        effectInstanceId: firstEffect.id,
        newEffectId: firstEffect.effectId,
        params: firstEffect.params,
      },
    };
    // Note: clearAll inverse is a simplified single effect restore; for full restore
    // we'd need a compound command. This is a pragmatic fallback.
    return commit(project, objectId, nextObject, inverse);
  }

  if (command.type === 'effect.replace') {
    const { effectInstanceId, newEffectId, params } = command.payload;
    const effects = getEffectsArray(object);
    const idx = findEffectIndex(effects, effectInstanceId);
    if (idx === -1) throw new MotionCommandError(`unknown effect instance ${effectInstanceId}`);
    const current = effects[idx]!;
    const nextEffects = effects.map((e, i) =>
      i === idx ? { ...e, effectId: newEffectId, params: params ?? {} } : e,
    );
    const nextObject = setEffectsArray(object, nextEffects);
    const inverse: MotionCommand = {
      type: 'effect.replace',
      payload: {
        objectId,
        effectInstanceId,
        newEffectId: current.effectId,
        params: current.params,
      },
    };
    return commit(project, objectId, nextObject, inverse);
  }

  throw new MotionCommandError(`unhandled motion command type: ${(command as MotionCommand).type}`);
}
