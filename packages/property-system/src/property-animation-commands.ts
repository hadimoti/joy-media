import {
  canonicalBindingKey,
  normalizePropertyAnimations,
  type AnimationValueV2,
  type JoyProjectV1,
  type KeyframeV1,
  type PropertyAnimationV2,
  type PropertyBindingV2,
} from '@joy-media/project-schema';

export type PropertyAnimationKey =
  | { readonly kind: 'scalar' | 'angle' | 'hue'; readonly keyframe: KeyframeV1 }
  | {
      readonly kind: 'vector' | 'color';
      readonly timeUs: number;
      readonly channels: Readonly<Record<string, KeyframeV1>>;
    }
  | {
      readonly kind: 'boolean' | 'string';
      readonly timeUs: number;
      readonly value: boolean | string;
    }
  | {
      readonly kind: 'curve-snapshot';
      readonly timeUs: number;
      readonly channels: Readonly<Record<string, readonly number[]>>;
      readonly interpolation: string;
    };

export type PropertyAnimationCommand =
  | {
      readonly type: 'propertyAnimation.replace';
      readonly payload: { readonly binding: PropertyBindingV2; readonly value?: AnimationValueV2 };
    }
  | {
      readonly type: 'propertyAnimation.enable';
      readonly payload: { readonly animation: PropertyAnimationV2 };
    }
  | {
      readonly type: 'propertyAnimation.disable';
      readonly payload: { readonly binding: PropertyBindingV2 };
    }
  | {
      readonly type: 'propertyAnimation.setKey';
      readonly payload: { readonly binding: PropertyBindingV2; readonly key: PropertyAnimationKey };
    }
  | {
      readonly type: 'propertyAnimation.removeKey';
      readonly payload: { readonly binding: PropertyBindingV2; readonly timeUs: number };
    };

export interface PropertyAnimationApplyResult {
  readonly project: JoyProjectV1;
  readonly inverse: PropertyAnimationCommand;
}

/** Applies a normalized immutable animation command with a semantic inverse. */
export function applyPropertyAnimationCommand(
  project: JoyProjectV1,
  command: PropertyAnimationCommand,
): PropertyAnimationApplyResult {
  const current = normalized(project);
  const binding =
    command.type === 'propertyAnimation.enable'
      ? command.payload.animation.binding
      : command.payload.binding;
  const id = canonicalBindingKey(binding);
  const previous = current[id];
  let next: PropertyAnimationV2 | undefined;
  switch (command.type) {
    case 'propertyAnimation.replace':
      next =
        command.payload.value === undefined ? undefined : { binding, value: command.payload.value };
      break;
    case 'propertyAnimation.enable':
      next = command.payload.animation;
      break;
    case 'propertyAnimation.disable':
      next = undefined;
      break;
    case 'propertyAnimation.setKey':
      if (previous === undefined) throw new RangeError('cannot set a key on a disabled animation');
      next = { binding, value: setKey(previous.value, command.payload.key) };
      break;
    case 'propertyAnimation.removeKey':
      if (previous === undefined)
        throw new RangeError('cannot remove a key from a disabled animation');
      next = removeKey(previous, command.payload.timeUs);
      break;
  }
  if (next !== undefined) assertValid(next);
  const animations = { ...current };
  if (next === undefined) delete animations[id];
  else animations[id] = next;
  const nextProject: { -readonly [K in keyof JoyProjectV1]: JoyProjectV1[K] } = { ...project };
  if (Object.keys(animations).length === 0) delete nextProject.propertyAnimations;
  else nextProject.propertyAnimations = animations;
  return {
    project: nextProject,
    inverse:
      previous === undefined
        ? { type: 'propertyAnimation.disable', payload: { binding } }
        : { type: 'propertyAnimation.replace', payload: { binding, value: previous.value } },
  };
}

function normalized(project: JoyProjectV1): Record<string, PropertyAnimationV2> {
  const result = normalizePropertyAnimations(project.propertyAnimations);
  if (result.diagnostics.length > 0) throw new RangeError(result.diagnostics[0]!.message);
  return { ...result.animations };
}

function assertValid(animation: PropertyAnimationV2): void {
  const result = normalizePropertyAnimations({
    [canonicalBindingKey(animation.binding)]: animation,
  });
  if (result.diagnostics.length > 0) throw new RangeError(result.diagnostics[0]!.message);
}

function setKey(value: AnimationValueV2, key: PropertyAnimationKey): AnimationValueV2 {
  switch (key.kind) {
    case 'scalar':
    case 'angle':
    case 'hue':
      if (value.kind !== key.kind)
        throw new RangeError(`key kind ${key.kind} does not match ${value.kind}`);
      return { ...value, curve: { keyframes: replace(value.curve.keyframes, key.keyframe) } };
    case 'vector':
    case 'color': {
      if (value.kind !== key.kind)
        throw new RangeError(`key kind ${key.kind} does not match ${value.kind}`);
      const names = Object.keys(value.curve).sort();
      const incoming = Object.keys(key.channels).sort();
      if (names.length !== incoming.length || names.some((name, index) => name !== incoming[index]))
        throw new RangeError('compound key channels must exactly match the animation channels');
      if (!incoming.every((name) => key.channels[name]!.timeUs === key.timeUs))
        throw new RangeError('compound key channel times must be atomic');
      return {
        ...value,
        curve: Object.fromEntries(
          names.map((name) => [
            name,
            { keyframes: replace(value.curve[name]!.keyframes, key.channels[name]!) },
          ]),
        ),
      };
    }
    case 'boolean':
    case 'string':
      if (value.kind !== key.kind || typeof key.value !== key.kind)
        throw new RangeError('discrete key value type is invalid');
      return { ...value, keys: replace(value.keys, { timeUs: key.timeUs, value: key.value }) };
    case 'curve-snapshot':
      if (value.kind !== key.kind)
        throw new RangeError(`key kind ${key.kind} does not match ${value.kind}`);
      return {
        ...value,
        samples: replace(value.samples, {
          timeUs: key.timeUs,
          channels: key.channels,
          interpolation: key.interpolation,
        }),
      };
  }
}

function removeKey(
  animation: PropertyAnimationV2,
  timeUs: number,
): PropertyAnimationV2 | undefined {
  assertTime(timeUs);
  const { value } = animation;
  if (value.kind === 'scalar' || value.kind === 'angle' || value.kind === 'hue') {
    const keyframes = value.curve.keyframes.filter((key) => key.timeUs !== timeUs);
    return keyframes.length === 0
      ? undefined
      : { ...animation, value: { ...value, curve: { keyframes } } };
  }
  if (value.kind === 'vector' || value.kind === 'color') {
    const entries = Object.entries(value.curve).map(
      ([name, curve]) => [name, curve.keyframes.filter((key) => key.timeUs !== timeUs)] as const,
    );
    if (entries.some(([, keys]) => keys.length === 0)) return undefined;
    const lengths = entries.map(([, keys]) => keys.length);
    if (new Set(lengths).size !== 1)
      throw new RangeError('compound animation keys must remain atomic');
    return {
      ...animation,
      value: {
        ...value,
        curve: Object.fromEntries(entries.map(([name, keyframes]) => [name, { keyframes }])),
      },
    };
  }
  if (value.kind === 'boolean' || value.kind === 'string') {
    const keys = value.keys.filter((key) => key.timeUs !== timeUs);
    return keys.length === 0 ? undefined : { ...animation, value: { ...value, keys } };
  }
  const samples = value.samples.filter((sample) => sample.timeUs !== timeUs);
  return samples.length === 0 ? undefined : { ...animation, value: { ...value, samples } };
}

function replace<T extends { readonly timeUs: number }>(
  values: readonly T[],
  next: T,
): readonly T[] {
  assertTime(next.timeUs);
  return [...values.filter((value) => value.timeUs !== next.timeUs), next].sort(
    (left, right) => left.timeUs - right.timeUs,
  );
}

function assertTime(timeUs: number): void {
  if (!Number.isFinite(timeUs) || !Number.isInteger(timeUs))
    throw new RangeError('key time must be a finite integer microsecond value');
}
