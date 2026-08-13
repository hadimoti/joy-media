/**
 * Lazy bridge for pre-WP34 visual-object/effect curves.
 *
 * Reading a legacy curve never changes a document. The first V2 mutation for
 * that exact binding may call `migrateLegacyPropertyOnFirstV2Edit`, which moves
 * only the addressed curve to `propertyAnimations`; all unrelated legacy data
 * stays byte-for-byte referentially untouched.
 */
import { sampleCurve } from '@joy-media/motion-core';
import {
  canonicalBindingKey,
  type AnimationCurveV1,
  type AnimatablePropertyV1,
  type JoyProjectV1,
  type PropertyAnimationV2,
  type PropertyBindingV2,
  type TimeUs,
} from '@joy-media/project-schema';

export type LegacyPropertyAnimation =
  | {
      readonly kind: 'visual-object';
      readonly objectId: string;
      readonly curve: AnimationCurveV1;
      /** Original record preserves property order for byte-stable undo serialization. */
      readonly animations: NonNullable<JoyProjectV1['visualObjects'][string]['animations']>;
    }
  | {
      readonly kind: 'object-effect';
      readonly objectId: string;
      readonly effectId: string;
      readonly curve: AnimationCurveV1;
      /** Original record preserves property order for byte-stable undo serialization. */
      readonly animations: NonNullable<
        NonNullable<JoyProjectV1['visualObjects'][string]['effects']>[number]['animations']
      >;
    };

export interface LegacyPropertyAnimationAdapter {
  readonly sample: (timeUs: TimeUs) => number;
}

export interface LegacyPropertyMigration {
  readonly project: JoyProjectV1;
  readonly legacy?: LegacyPropertyAnimation;
}

/** Returns a read-only sampler for a supported legacy curve, if one exists. */
export function legacyPropertyAnimationAdapter(
  project: JoyProjectV1,
  binding: PropertyBindingV2,
): LegacyPropertyAnimationAdapter | undefined {
  const legacy = readLegacyPropertyAnimation(project, binding);
  return legacy === undefined
    ? undefined
    : { sample: (timeUs) => sampleCurve(legacy.curve, timeUs) };
}

/** Reads one supported legacy curve without modifying project serialization. */
export function readLegacyPropertyAnimation(
  project: JoyProjectV1,
  binding: PropertyBindingV2,
): LegacyPropertyAnimation | undefined {
  if (binding.timeDomain !== 'composition') return undefined;
  if (binding.ownerKind === 'visual-object') {
    const object = project.visualObjects[binding.ownerId];
    if (object === undefined) return undefined;
    const curve = object.animations?.[binding.propertyId as AnimatablePropertyV1];
    return curve === undefined || object.animations === undefined
      ? undefined
      : { kind: 'visual-object', objectId: object.id, curve, animations: object.animations };
  }
  if (binding.ownerKind !== 'object-effect') return undefined;

  const owner = findEffectOwner(project, binding.ownerId);
  if (owner === undefined) return undefined;
  const curve = owner.effect.animations?.[binding.propertyId];
  return curve === undefined || owner.effect.animations === undefined
    ? undefined
    : {
        kind: 'object-effect',
        objectId: owner.objectId,
        effectId: owner.effect.id,
        curve,
        animations: owner.effect.animations,
      };
}

/**
 * Moves only this binding's legacy curve to V2. Existing V2 data always wins,
 * so a repeat edit does not re-migrate or disturb a previously converted curve.
 */
export function migrateLegacyPropertyOnFirstV2Edit(
  project: JoyProjectV1,
  binding: PropertyBindingV2,
): LegacyPropertyMigration {
  const id = canonicalBindingKey(binding);
  if (project.propertyAnimations?.[id] !== undefined) return { project };
  const legacy = readLegacyPropertyAnimation(project, binding);
  if (legacy === undefined) return { project };

  const withoutLegacy = writeLegacyPropertyAnimation(project, binding, undefined);
  const animation: PropertyAnimationV2 = {
    binding,
    value: {
      kind:
        binding.ownerKind === 'visual-object' && binding.propertyId === 'rotationDeg'
          ? 'angle'
          : 'scalar',
      curve: legacy.curve,
    },
  };
  return {
    project: {
      ...withoutLegacy,
      propertyAnimations: { ...(withoutLegacy.propertyAnimations ?? {}), [id]: animation },
    },
    legacy,
  };
}

/** Restores one original legacy curve and removes the matching V2 entry. */
export function restoreLegacyPropertyAnimation(
  project: JoyProjectV1,
  binding: PropertyBindingV2,
  legacy: LegacyPropertyAnimation | undefined,
): JoyProjectV1 {
  const id = canonicalBindingKey(binding);
  const animations = { ...(project.propertyAnimations ?? {}) };
  delete animations[id];
  const withoutV2 = { ...project };
  if (Object.keys(animations).length === 0) delete withoutV2.propertyAnimations;
  else withoutV2.propertyAnimations = animations;
  return writeLegacyPropertyAnimation(withoutV2, binding, legacy);
}

/** Writes or clears the supported legacy source for exactly one binding. */
export function writeLegacyPropertyAnimation(
  project: JoyProjectV1,
  binding: PropertyBindingV2,
  legacy: LegacyPropertyAnimation | undefined,
): JoyProjectV1 {
  if (binding.timeDomain !== 'composition') return project;
  if (binding.ownerKind === 'visual-object') {
    const object = project.visualObjects[binding.ownerId];
    if (object === undefined) throw new RangeError(`unknown visual object "${binding.ownerId}"`);
    if (
      legacy !== undefined &&
      (legacy.kind !== 'visual-object' || legacy.objectId !== object.id)
    ) {
      throw new RangeError('legacy visual-object backup does not match its binding');
    }
    const animations = { ...(object.animations ?? {}) };
    if (legacy === undefined) delete animations[binding.propertyId as AnimatablePropertyV1];
    const nextObject = { ...object };
    if (legacy !== undefined) nextObject.animations = legacy.animations;
    else if (Object.keys(animations).length === 0) delete nextObject.animations;
    else nextObject.animations = animations;
    return {
      ...project,
      visualObjects: { ...project.visualObjects, [object.id]: nextObject },
    };
  }
  if (binding.ownerKind !== 'object-effect') return project;

  const owner = findEffectOwner(project, binding.ownerId);
  if (owner === undefined) throw new RangeError(`unknown object effect "${binding.ownerId}"`);
  if (
    legacy !== undefined &&
    (legacy.kind !== 'object-effect' ||
      legacy.objectId !== owner.objectId ||
      legacy.effectId !== owner.effect.id)
  ) {
    throw new RangeError('legacy effect backup does not match its binding');
  }
  const animations = { ...(owner.effect.animations ?? {}) };
  if (legacy === undefined) delete animations[binding.propertyId];
  const nextEffect = { ...owner.effect };
  if (legacy !== undefined) nextEffect.animations = legacy.animations;
  else if (Object.keys(animations).length === 0) delete nextEffect.animations;
  else nextEffect.animations = animations;
  const nextEffects = owner.object.effects!.map((effect) =>
    effect.id === owner.effect.id ? nextEffect : effect,
  );
  return {
    ...project,
    visualObjects: {
      ...project.visualObjects,
      [owner.objectId]: { ...owner.object, effects: nextEffects },
    },
  };
}

function findEffectOwner(
  project: JoyProjectV1,
  effectId: string,
):
  | {
      readonly objectId: string;
      readonly object: NonNullable<JoyProjectV1['visualObjects'][string]>;
      readonly effect: NonNullable<JoyProjectV1['visualObjects'][string]['effects']>[number];
    }
  | undefined {
  let found:
    | {
        readonly objectId: string;
        readonly object: NonNullable<JoyProjectV1['visualObjects'][string]>;
        readonly effect: NonNullable<JoyProjectV1['visualObjects'][string]['effects']>[number];
      }
    | undefined;
  for (const object of Object.values(project.visualObjects)) {
    const effect = object.effects?.find((candidate) => candidate.id === effectId);
    if (effect === undefined) continue;
    if (found !== undefined) throw new RangeError(`duplicate object effect id "${effectId}"`);
    found = { objectId: object.id, object, effect };
  }
  return found;
}
