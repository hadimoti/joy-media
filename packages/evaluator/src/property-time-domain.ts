/**
 * Resolves universal-property animation keyframe time against an explicit
 * domain. Durable time remains integer microseconds throughout; callers must
 * provide the local range for any local-domain target instead of falling back
 * to a composition or output grade by accident.
 */
import type { AnimationTimeDomainV2, TimeUs } from '@joy-media/project-schema';

export interface AnimationLocalTimeRange {
  readonly startUs: TimeUs;
  readonly durationUs: TimeUs;
}

export interface PropertyAnimationTimeContext {
  /** Time in the currently evaluated composition. */
  readonly compositionTimeUs: TimeUs;
  /** Final program/output timeline time. Defaults to composition time. */
  readonly outputTimeUs?: TimeUs;
  /** Audio mixing timeline time. Defaults to composition time. */
  readonly audioTimelineTimeUs?: TimeUs;
  readonly clip?: AnimationLocalTimeRange;
  readonly transition?: AnimationLocalTimeRange;
  readonly captionClip?: AnimationLocalTimeRange;
  readonly scene?: AnimationLocalTimeRange;
}

export interface ResolvedPropertyAnimationTime {
  readonly domain: AnimationTimeDomainV2;
  /** Time to sample, expressed in the binding's own keyframe domain. */
  readonly timeUs: TimeUs;
  /** True when an inactive/outside local range had to be clamped at an edge. */
  readonly clamped: boolean;
}

/**
 * Resolves a frame time for one explicit animation time domain. Local domains
 * are rebased to zero at their owning entity's start and clamp at [0,duration]
 * so evaluating a boundary frame never extrapolates a curve.
 */
export function resolvePropertyAnimationTime(
  domain: AnimationTimeDomainV2,
  context: PropertyAnimationTimeContext,
): ResolvedPropertyAnimationTime {
  assertTime(context.compositionTimeUs, 'compositionTimeUs');
  switch (domain) {
    case 'composition':
      return { domain, timeUs: context.compositionTimeUs, clamped: false };
    case 'output': {
      const timeUs = context.outputTimeUs ?? context.compositionTimeUs;
      assertTime(timeUs, 'outputTimeUs');
      return { domain, timeUs, clamped: false };
    }
    case 'audio-timeline': {
      const timeUs = context.audioTimelineTimeUs ?? context.compositionTimeUs;
      assertTime(timeUs, 'audioTimelineTimeUs');
      return { domain, timeUs, clamped: false };
    }
    case 'clip-local':
      return resolveLocal(domain, context.compositionTimeUs, context.clip, 'clip');
    case 'transition-local':
      return resolveLocal(domain, context.compositionTimeUs, context.transition, 'transition');
    case 'caption-clip-local':
      return resolveLocal(domain, context.compositionTimeUs, context.captionClip, 'caption clip');
    case 'scene-local':
      return resolveLocal(domain, context.compositionTimeUs, context.scene, 'scene');
  }
}

function resolveLocal(
  domain: AnimationTimeDomainV2,
  compositionTimeUs: TimeUs,
  range: AnimationLocalTimeRange | undefined,
  label: string,
): ResolvedPropertyAnimationTime {
  if (range === undefined) {
    throw new RangeError(`${domain} requires a ${label} time range`);
  }
  assertTime(range.startUs, `${label}.startUs`);
  assertTime(range.durationUs, `${label}.durationUs`);
  const endUs = range.startUs + range.durationUs;
  if (!Number.isSafeInteger(endUs)) {
    throw new RangeError(`${label} time range exceeds the safe integer range`);
  }

  const clampedCompositionTimeUs = Math.min(Math.max(compositionTimeUs, range.startUs), endUs);
  return {
    domain,
    timeUs: clampedCompositionTimeUs - range.startUs,
    clamped: clampedCompositionTimeUs !== compositionTimeUs,
  };
}

function assertTime(value: number, label: string): asserts value is TimeUs {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}
