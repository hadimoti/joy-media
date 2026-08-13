import {
  canonicalBindingKey,
  normalizePropertyAnimations,
  PROPERTY_OWNER_KINDS,
  PROPERTY_TIME_DOMAINS,
  type AnimationValueV2,
  type PropertyAnimationV2,
  type PropertyBindingV2,
} from '@joy-media/project-schema';

export type AgentPropertyAnimationOperation =
  | { readonly type: 'enable'; readonly animation: PropertyAnimationV2 }
  | { readonly type: 'disable'; readonly binding: PropertyBindingV2 }
  | {
      readonly type: 'replace';
      readonly binding: PropertyBindingV2;
      readonly value?: AnimationValueV2;
    }
  | { readonly type: 'removeKey'; readonly binding: PropertyBindingV2; readonly timeUs: number };

export interface PropertyAnimationOperationValidation {
  readonly operation?: AgentPropertyAnimationOperation;
  readonly errors: readonly string[];
}

/**
 * Validates an agent-supplied animation operation without accepting JSON paths.
 * The result is deliberately command-shaped so UI and agent bridges can share
 * this boundary before either side writes project state.
 */
export function validatePropertyAnimationOperation(
  value: unknown,
): PropertyAnimationOperationValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { errors: ['operation must be an object'] };
  if ('path' in value || 'jsonPath' in value)
    errors.push('raw JSON paths are not accepted; use a typed binding');
  if (
    typeof value.type !== 'string' ||
    !['enable', 'disable', 'replace', 'removeKey'].includes(value.type)
  )
    errors.push('type must be enable, disable, replace, or removeKey');

  const bindingValue =
    value.type === 'enable' && isRecord(value.animation) ? value.animation.binding : value.binding;
  const binding = parseBinding(bindingValue, errors);
  if (value.type === 'enable') {
    if (!isRecord(value.animation)) errors.push('enable requires animation');
    else if (binding !== undefined) {
      const animation = { binding, value: value.animation.value } as PropertyAnimationV2;
      const normalized = normalizePropertyAnimations({ [canonicalBindingKey(binding)]: animation });
      errors.push(...normalized.diagnostics.map((diagnostic) => diagnostic.message));
      if (errors.length === 0) return { operation: { type: 'enable', animation }, errors };
    }
  } else if (binding !== undefined && (value.type === 'disable' || value.type === 'replace')) {
    if (value.type === 'disable') return { operation: { type: 'disable', binding }, errors };
    if (value.value === undefined) return { operation: { type: 'replace', binding }, errors };
    const normalized = normalizePropertyAnimations({
      [canonicalBindingKey(binding)]: { binding, value: value.value },
    });
    errors.push(...normalized.diagnostics.map((diagnostic) => diagnostic.message));
    if (errors.length === 0)
      return {
        operation: { type: 'replace', binding, value: value.value as AnimationValueV2 },
        errors,
      };
  } else if (binding !== undefined && value.type === 'removeKey') {
    const timeUs = value.timeUs;
    const validTimeUs =
      typeof timeUs === 'number' && Number.isSafeInteger(timeUs) && timeUs >= 0
        ? timeUs
        : undefined;
    if (validTimeUs === undefined)
      errors.push('removeKey timeUs must be a non-negative safe integer');
    if (validTimeUs !== undefined && errors.length === 0)
      return { operation: { type: 'removeKey', binding, timeUs: validTimeUs }, errors };
  }
  return { errors };
}

function parseBinding(value: unknown, errors: string[]): PropertyBindingV2 | undefined {
  if (!isRecord(value)) {
    errors.push('typed binding is required');
    return undefined;
  }
  if (!PROPERTY_OWNER_KINDS.includes(value.ownerKind as never)) errors.push('unknown owner kind');
  if (!PROPERTY_TIME_DOMAINS.includes(value.timeDomain as never))
    errors.push('unknown time domain');
  if (typeof value.ownerId !== 'string' || value.ownerId.length === 0)
    errors.push('ownerId is required');
  if (typeof value.propertyId !== 'string' || value.propertyId.length === 0)
    errors.push('propertyId is required');
  if (errors.length > 0) return undefined;
  return {
    ownerKind: value.ownerKind as PropertyBindingV2['ownerKind'],
    ownerId: value.ownerId as string,
    propertyId: value.propertyId as string,
    timeDomain: value.timeDomain as PropertyBindingV2['timeDomain'],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
