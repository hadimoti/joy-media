/**
 * Shared builders for the R2 Look packs (L3). Each pack is still authored
 * as explicit typed data — these helpers only remove the mechanical repetition
 * in binding-target and constraint shapes so the pack files read as intent.
 */

import type { AnimationTimeDomainV2, PropertyOwnerKindV2 } from '@joy-media/project-schema';
import type {
  LookBindingTarget,
  LookConstraints,
  LookFormatConstraints,
  LookVerificationPredicate,
} from '../types.js';

/** A `visual-object` keyframe binding on a real animatable property. */
export function keyframeBinding(
  bindingId: string,
  ownerSlotId: string,
  propertyId: 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotationDeg' | 'opacity' | 'positionZ',
  ownerKind: PropertyOwnerKindV2 = 'visual-object',
  timeDomain: AnimationTimeDomainV2 = 'composition',
): LookBindingTarget {
  return { bindingId, channel: 'keyframe', ownerSlotId, ownerKind, propertyId, timeDomain };
}

export function textTemplateBinding(bindingId: string, ownerSlotId: string): LookBindingTarget {
  return {
    bindingId,
    channel: 'text-template',
    ownerSlotId,
    ownerKind: 'visual-object',
    propertyId: 'text-template',
    timeDomain: 'composition',
  };
}

export function captionTemplateBinding(bindingId: string, ownerSlotId: string): LookBindingTarget {
  return {
    bindingId,
    channel: 'caption-template',
    ownerSlotId,
    ownerKind: 'caption-clip',
    propertyId: 'caption-template',
    timeDomain: 'caption-clip-local',
  };
}

export function constraints(
  portrait: LookFormatConstraints,
  landscape: LookFormatConstraints,
): LookConstraints {
  return { portrait, landscape };
}

export function structuralCheck(id: string, summary: string): LookVerificationPredicate {
  return { id, method: 'structural', summary };
}

export const JOY_PROVENANCE = {
  author: 'JOY Studio',
  license: 'OFL-1.1 (fonts) · JOY internal (pack data)',
} as const;
