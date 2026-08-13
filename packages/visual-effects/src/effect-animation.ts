import type { EffectDescriptor, EffectParamDescriptor } from './types.js';

/** The closed universal animation shape that each declared effect parameter maps to. */
export type EffectAnimationValueKind = 'scalar' | 'vector' | 'color' | 'boolean' | 'string';

export type EffectAnimationClassification =
  | {
      readonly classification: 'creative';
      readonly valueKind: EffectAnimationValueKind;
      readonly interpolation: 'smooth' | 'hold';
    }
  | { readonly classification: 'static-with-reason'; readonly reason: string };

/**
 * A descriptor-derived registry entry. It is intentionally immutable and
 * project-agnostic: the property-system later binds it to a concrete effect
 * instance id and composition time domain.
 */
export interface EffectAnimationDescriptorEntry {
  readonly id: string;
  readonly effectId: string;
  readonly paramKey: string;
  readonly label: string;
  readonly classification: EffectAnimationClassification;
}

function classificationFor(param: EffectParamDescriptor): EffectAnimationClassification {
  if (!param.animatable) {
    return {
      classification: 'static-with-reason',
      reason:
        'This first-party descriptor marks the parameter static for its current renderer contract.',
    };
  }
  switch (param.type) {
    case 'number':
      return { classification: 'creative', valueKind: 'scalar', interpolation: 'smooth' };
    case 'vector2':
      return { classification: 'creative', valueKind: 'vector', interpolation: 'smooth' };
    case 'color':
      return { classification: 'creative', valueKind: 'color', interpolation: 'smooth' };
    case 'boolean':
      return { classification: 'creative', valueKind: 'boolean', interpolation: 'hold' };
    case 'enum':
      return { classification: 'creative', valueKind: 'string', interpolation: 'hold' };
  }
}

/**
 * Classifies every parameter in every supplied effect descriptor. Duplicate
 * effect ids or parameter keys are rejected even when callers bypass the
 * runtime EffectRegistry, keeping the animation address space unambiguous.
 */
export function buildEffectAnimationDescriptorRegistry(
  descriptors: readonly EffectDescriptor[],
): readonly EffectAnimationDescriptorEntry[] {
  const effectIds = new Set<string>();
  const entries: EffectAnimationDescriptorEntry[] = [];
  for (const descriptor of descriptors) {
    if (effectIds.has(descriptor.id))
      throw new RangeError(`duplicate effect id "${descriptor.id}" in animation registry`);
    effectIds.add(descriptor.id);
    const parameterKeys = new Set<string>();
    for (const param of descriptor.params) {
      if (parameterKeys.has(param.key))
        throw new RangeError(
          `duplicate parameter key "${param.key}" in effect "${descriptor.id}" animation registry`,
        );
      parameterKeys.add(param.key);
      entries.push({
        id: `object-effect.${descriptor.id}.${param.key}`,
        effectId: descriptor.id,
        paramKey: param.key,
        label: `${descriptor.label} — ${param.label}`,
        classification: classificationFor(param),
      });
    }
  }
  return entries;
}

/** Throws when a registry no longer covers exactly the descriptor catalog. */
export function assertEffectAnimationDescriptorCoverage(
  descriptors: readonly EffectDescriptor[],
  entries: readonly EffectAnimationDescriptorEntry[],
): void {
  const expected = new Set(
    descriptors.flatMap((effect) => effect.params.map((param) => `${effect.id}\0${param.key}`)),
  );
  const actual = new Set(entries.map((entry) => `${entry.effectId}\0${entry.paramKey}`));
  if (expected.size !== actual.size || [...expected].some((key) => !actual.has(key))) {
    throw new RangeError('effect animation registry does not exactly cover the descriptor catalog');
  }
  for (const entry of entries) {
    const descriptor = descriptors.find((candidate) => candidate.id === entry.effectId);
    const param = descriptor?.params.find((candidate) => candidate.key === entry.paramKey);
    if (param === undefined)
      throw new RangeError(`effect animation entry "${entry.id}" has no descriptor parameter`);
    const expectedClassification = classificationFor(param);
    if (JSON.stringify(entry.classification) !== JSON.stringify(expectedClassification))
      throw new RangeError(
        `effect animation entry "${entry.id}" disagrees with its descriptor policy`,
      );
  }
}
