/**
 * Pure frame-local property evaluation for the universal animation model.
 *
 * The precedence is deliberate and shared by every property family:
 * static value -> matching V2 animation (or legacy adapter) -> expression ->
 * property normalizer. Project data is read only; callers receive a resolved
 * snapshot and diagnostics for a safe expression fallback.
 */
import { sampleAnimationValue, type SampledAnimationValueV2 } from '@joy-media/motion-core';
import {
  canonicalBindingKey,
  type PropertyAnimationV2,
  type PropertyBindingV2,
} from '@joy-media/project-schema';
import type { TimeUs } from '@joy-media/project-schema';
import {
  resolvePropertyAnimationTime,
  type PropertyAnimationTimeContext,
  type ResolvedPropertyAnimationTime,
} from './property-time-domain.js';

export type FramePropertyValue = SampledAnimationValueV2;

export interface LegacyPropertyAnimationAdapter {
  readonly sample: (timeUs: TimeUs) => FramePropertyValue;
}

export interface FramePropertyExpression<T> {
  readonly evaluate: (baseValue: FramePropertyValue, timeUs: TimeUs) => T;
}

export interface FramePropertyEvaluatorRequest<T> {
  readonly binding: PropertyBindingV2;
  readonly staticValue: FramePropertyValue;
  /** Normalized V2 entries, keyed by canonical binding key. */
  readonly animations?: Readonly<Record<string, PropertyAnimationV2>>;
  /** Read-only adapter used only while this property has no V2 entry. */
  readonly legacy?: LegacyPropertyAnimationAdapter;
  readonly expression?: FramePropertyExpression<FramePropertyValue>;
  readonly time: PropertyAnimationTimeContext;
  /** Applies family-specific bounds/canonicalization to the final frame value. */
  readonly normalize: (value: FramePropertyValue) => T;
}

export type FramePropertySource = 'static' | 'v2' | 'legacy' | 'expression';

export interface FramePropertyDiagnostic {
  readonly code: 'PROPERTY_EXPRESSION_FAILED';
  readonly message: string;
}

export interface EvaluatedFrameProperty<T> {
  readonly binding: PropertyBindingV2;
  readonly value: T;
  readonly source: FramePropertySource;
  readonly time: ResolvedPropertyAnimationTime;
  readonly diagnostics: readonly FramePropertyDiagnostic[];
}

/** Evaluates one binding without mutating animation maps, adapters, or input values. */
export function evaluateFrameProperty<T>(
  request: FramePropertyEvaluatorRequest<T>,
): EvaluatedFrameProperty<T> {
  const time = resolvePropertyAnimationTime(request.binding.timeDomain, request.time);
  const animation = request.animations?.[canonicalBindingKey(request.binding)];
  let value = request.staticValue;
  let source: FramePropertySource = 'static';

  if (animation !== undefined && bindingsEqual(animation.binding, request.binding)) {
    value = sampleAnimationValue(animation.value, time.timeUs);
    source = 'v2';
  } else if (request.legacy !== undefined) {
    value = request.legacy.sample(time.timeUs);
    source = 'legacy';
  }

  const diagnostics: FramePropertyDiagnostic[] = [];
  if (request.expression !== undefined) {
    try {
      value = request.expression.evaluate(value, time.timeUs);
      source = 'expression';
    } catch (error) {
      diagnostics.push({
        code: 'PROPERTY_EXPRESSION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    binding: request.binding,
    value: request.normalize(value),
    source,
    time,
    diagnostics,
  };
}

function bindingsEqual(left: PropertyBindingV2, right: PropertyBindingV2): boolean {
  return (
    left.ownerKind === right.ownerKind &&
    left.ownerId === right.ownerId &&
    left.propertyId === right.propertyId &&
    left.timeDomain === right.timeDomain
  );
}
