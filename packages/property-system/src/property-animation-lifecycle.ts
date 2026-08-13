/** Immutable ownership helpers for property animation lifecycle operations. */
import {
  canonicalBindingKey,
  normalizePropertyAnimations,
  type AnimationCurveV1,
  type AnimationTimeDomainV2,
  type AnimationValueV2,
  type JoyProjectV1,
  type PropertyAnimationV2,
  type PropertyBindingV2,
} from '@joy-media/project-schema';
import {
  sampleAnimationValue,
  sampleCurve,
  sampleCurveSnapshots,
  sampleDiscreteKeys,
} from '@joy-media/motion-core';

export interface PropertyAnimationOwner {
  readonly ownerKind: PropertyBindingV2['ownerKind'];
  readonly ownerId: string;
}

export interface PropertyAnimationOwnerClone {
  readonly source: PropertyAnimationOwner;
  readonly target: PropertyAnimationOwner;
  /** Rebase clip-local/caption-local keys after a split at this local time. */
  readonly rebaseFromUs?: number;
}

const CLIP_OWNER_KINDS = ['clip', 'color-clip', 'audio-clip', 'caption-clip'] as const;

/** Owner references for every property family whose lifetime is one timeline clip. */
export function clipPropertyAnimationOwners(clipId: string): readonly PropertyAnimationOwner[] {
  return CLIP_OWNER_KINDS.map((ownerKind) => ({ ownerKind, ownerId: clipId }));
}

/** Copies all clip-owned animations for duplicate/copy-paste without rebasing their local curves. */
export function duplicateClipPropertyAnimations(
  project: JoyProjectV1,
  sourceClipId: string,
  targetClipId: string,
): JoyProjectV1 {
  return clonePropertyAnimations(
    project,
    clipPropertyAnimationOwners(sourceClipId).map((source) => ({
      source,
      target: { ...source, ownerId: targetClipId },
    })),
  );
}

/** Copies clip-owned animation to a split right-hand clip, rebasing local domains at the cut. */
export function splitClipPropertyAnimations(
  project: JoyProjectV1,
  sourceClipId: string,
  rightClipId: string,
  splitLocalUs: number,
): JoyProjectV1 {
  assertTime(splitLocalUs, 'splitLocalUs');
  return clonePropertyAnimations(
    project,
    clipPropertyAnimationOwners(sourceClipId).map((source) => ({
      source,
      target: { ...source, ownerId: rightClipId },
      rebaseFromUs: splitLocalUs,
    })),
  );
}

/** Removes every property animation owned by a deleted timeline clip. */
export function removeClipPropertyAnimations(project: JoyProjectV1, clipId: string): JoyProjectV1 {
  return removePropertyAnimations(project, clipPropertyAnimationOwners(clipId));
}

/** Clones selected owner-bound entries to new owners; source entries remain unchanged. */
export function clonePropertyAnimations(
  project: JoyProjectV1,
  clones: readonly PropertyAnimationOwnerClone[],
): JoyProjectV1 {
  if (clones.length === 0 || project.propertyAnimations === undefined) return project;
  const animations = normalized(project);
  let changed = false;
  for (const clone of clones) {
    if (clone.rebaseFromUs !== undefined) assertTime(clone.rebaseFromUs, 'rebaseFromUs');
    for (const animation of Object.values(animations)) {
      if (!ownerEqual(animation.binding, clone.source)) continue;
      const binding = { ...animation.binding, ...clone.target };
      const id = canonicalBindingKey(binding);
      if (animations[id] !== undefined) {
        throw new RangeError(`property animation target "${id}" already exists`);
      }
      animations[id] = {
        binding,
        value:
          clone.rebaseFromUs === undefined || !isClipLocalDomain(animation.binding.timeDomain)
            ? animation.value
            : rebaseAnimationValue(animation.value, clone.rebaseFromUs),
      };
      changed = true;
    }
  }
  return changed ? withAnimations(project, animations) : project;
}

/** Removes only entries owned by the supplied objects, effects, or clips. */
export function removePropertyAnimations(
  project: JoyProjectV1,
  owners: readonly PropertyAnimationOwner[],
): JoyProjectV1 {
  if (owners.length === 0 || project.propertyAnimations === undefined) return project;
  const ownerSet = new Set(owners.map(ownerKey));
  const animations = normalized(project);
  let changed = false;
  for (const [id, animation] of Object.entries(animations)) {
    if (!ownerSet.has(ownerKey(animation.binding))) continue;
    delete animations[id];
    changed = true;
  }
  return changed ? withAnimations(project, animations) : project;
}

function rebaseAnimationValue(value: AnimationValueV2, offsetUs: number): AnimationValueV2 {
  switch (value.kind) {
    case 'scalar':
    case 'angle':
    case 'hue': {
      const sampled = sampleAnimationValue(value, offsetUs);
      if (typeof sampled !== 'number')
        throw new RangeError('numeric property animation sampled non-numeric');
      return { ...value, curve: rebaseCurve(value.curve, offsetUs, sampled) };
    }
    case 'vector':
    case 'color': {
      const sampled = sampleAnimationValue(value, offsetUs);
      if (typeof sampled !== 'object' || Array.isArray(sampled))
        throw new RangeError('compound property animation sampled invalid value');
      return {
        ...value,
        curve: Object.fromEntries(
          Object.entries(value.curve).map(([name, curve]) => [
            name,
            rebaseCurve(curve, offsetUs, Number(sampled[name])),
          ]),
        ),
      };
    }
    case 'boolean':
    case 'string': {
      const sampled = sampleDiscreteKeys(value.keys, offsetUs);
      const keys = value.keys
        .filter((key) => key.timeUs > offsetUs)
        .map((key) => ({ ...key, timeUs: key.timeUs - offsetUs }));
      return {
        ...value,
        keys: [{ timeUs: 0, value: sampled }, ...keys],
      } as AnimationValueV2;
    }
    case 'curve-snapshot': {
      const sampled = sampleCurveSnapshots(value.samples, offsetUs);
      const left = [...value.samples].reverse().find((sample) => sample.timeUs <= offsetUs);
      const samples = value.samples
        .filter((sample) => sample.timeUs > offsetUs)
        .map((sample) => ({ ...sample, timeUs: sample.timeUs - offsetUs }));
      return {
        ...value,
        samples: [
          { timeUs: 0, channels: sampled, interpolation: left?.interpolation ?? 'linear' },
          ...samples,
        ],
      };
    }
  }
}

function rebaseCurve(curve: AnimationCurveV1, offsetUs: number, sampled: number): AnimationCurveV1 {
  const exact = curve.keyframes.find((key) => key.timeUs === offsetUs);
  const left = [...curve.keyframes].reverse().find((key) => key.timeUs <= offsetUs);
  return {
    keyframes: [
      exact === undefined
        ? { timeUs: 0, value: sampled, interpolation: left?.interpolation ?? 'linear' }
        : { ...exact, timeUs: 0 },
      ...curve.keyframes
        .filter((key) => key.timeUs > offsetUs)
        .map((key) => ({ ...key, timeUs: key.timeUs - offsetUs })),
    ],
  };
}

function isClipLocalDomain(domain: AnimationTimeDomainV2): boolean {
  return domain === 'clip-local' || domain === 'caption-clip-local';
}

function normalized(project: JoyProjectV1): Record<string, PropertyAnimationV2> {
  const result = normalizePropertyAnimations(project.propertyAnimations);
  if (result.diagnostics.length > 0) throw new RangeError(result.diagnostics[0]!.message);
  return { ...result.animations };
}

function withAnimations(
  project: JoyProjectV1,
  animations: Record<string, PropertyAnimationV2>,
): JoyProjectV1 {
  const next = { ...project };
  if (Object.keys(animations).length === 0) delete next.propertyAnimations;
  else next.propertyAnimations = animations;
  return next;
}

function ownerEqual(binding: PropertyBindingV2, owner: PropertyAnimationOwner): boolean {
  return binding.ownerKind === owner.ownerKind && binding.ownerId === owner.ownerId;
}

function ownerKey(owner: PropertyAnimationOwner): string {
  return `${owner.ownerKind}\u0000${owner.ownerId}`;
}

function assertTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}
