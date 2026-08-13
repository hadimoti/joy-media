/**
 * Stable, project-facing audio automation descriptors.
 *
 * The coverage manifest classifies the whole editor surface. This module is
 * deliberately narrower: it is the typed contract shared by controls,
 * evaluators, preview, and export for the audio properties that can actually
 * vary over time. Topology (solo, sends, routing, and effect ordering) stays
 * out of this contract.
 */
import type { PropertyBindingV2 } from './property-animation.js';

export type AudioClipPropertyId = 'gain' | 'pan' | 'mute';
export type AudioBusPropertyId = 'gain' | 'pan' | 'mute';

export interface AudioAutomationDescriptor {
  readonly ownerKind: 'audio-clip' | 'audio-bus' | 'audio-effect';
  readonly propertyId: string;
  readonly valueKind: 'scalar' | 'boolean';
  /** Numeric channels are linearly ramped at audio-block boundaries. */
  readonly interpolation: 'linear-ramp' | 'hold';
  /**
   * A short ramp prevents a hard discontinuity when a live edit lands inside
   * a processing block. It does not change authored keyframe timing.
   */
  readonly smoothingUs: number;
}

export const AUDIO_AUTOMATION_DESCRIPTORS: readonly AudioAutomationDescriptor[] = [
  {
    ownerKind: 'audio-clip',
    propertyId: 'gain',
    valueKind: 'scalar',
    interpolation: 'linear-ramp',
    smoothingUs: 5_000,
  },
  {
    ownerKind: 'audio-clip',
    propertyId: 'pan',
    valueKind: 'scalar',
    interpolation: 'linear-ramp',
    smoothingUs: 5_000,
  },
  {
    ownerKind: 'audio-clip',
    propertyId: 'mute',
    valueKind: 'boolean',
    interpolation: 'hold',
    smoothingUs: 0,
  },
  {
    ownerKind: 'audio-bus',
    propertyId: 'gain',
    valueKind: 'scalar',
    interpolation: 'linear-ramp',
    smoothingUs: 5_000,
  },
  {
    ownerKind: 'audio-bus',
    propertyId: 'pan',
    valueKind: 'scalar',
    interpolation: 'linear-ramp',
    smoothingUs: 5_000,
  },
  {
    ownerKind: 'audio-bus',
    propertyId: 'mute',
    valueKind: 'boolean',
    interpolation: 'hold',
    smoothingUs: 0,
  },
] as const;

/** Effect params are scalar only when their first-party descriptor says so. */
export function audioEffectPropertyBinding(
  effectId: string,
  propertyId: string,
): PropertyBindingV2 {
  return {
    ownerKind: 'audio-effect',
    ownerId: effectId,
    propertyId,
    timeDomain: 'audio-timeline',
  };
}

export function audioClipPropertyBinding(
  clipId: string,
  propertyId: AudioClipPropertyId,
): PropertyBindingV2 {
  return {
    ownerKind: 'audio-clip',
    ownerId: clipId,
    propertyId,
    timeDomain: 'audio-timeline',
  };
}

export function audioBusPropertyBinding(
  busId: string,
  propertyId: AudioBusPropertyId,
): PropertyBindingV2 {
  return {
    ownerKind: 'audio-bus',
    ownerId: busId,
    propertyId,
    timeDomain: 'audio-timeline',
  };
}

export function audioAutomationDescriptor(
  ownerKind: AudioAutomationDescriptor['ownerKind'],
  propertyId: string,
): AudioAutomationDescriptor | undefined {
  return AUDIO_AUTOMATION_DESCRIPTORS.find(
    (descriptor) => descriptor.ownerKind === ownerKind && descriptor.propertyId === propertyId,
  );
}
