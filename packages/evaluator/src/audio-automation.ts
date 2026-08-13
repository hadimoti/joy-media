/**
 * Pure audio automation evaluation.
 *
 * This produces resolved static mixer values and block-endpoints. Audio hosts
 * own the actual sample processing, but preview and export receive the same
 * timing/value contract and can de-zipper continuous controls consistently.
 */
import { sampleAnimationValue } from '@joy-media/motion-core';
import {
  audioAutomationDescriptor,
  audioBusPropertyBinding,
  audioClipPropertyBinding,
  canonicalBindingKey,
  type AudioBusPropertyId,
  type AudioClipPropertyId,
  type NormalizedPropertyAnimationsV2,
  type ProjectAudioBusV1,
  type ProjectAudioClipV1,
  type ProjectAudioV1,
} from '@joy-media/project-schema';
import type { PropertyAnimationTimeContext } from './property-time-domain.js';
import { resolvePropertyAnimationTime } from './property-time-domain.js';

export interface AudioAutomationBlockRange {
  readonly startUs: number;
  readonly endUs: number;
}

export interface AudioScalarRamp {
  readonly start: number;
  readonly end: number;
  readonly smoothingUs: number;
}

export interface EvaluatedAudioBlock {
  readonly clips: Readonly<
    Record<
      string,
      {
        readonly gain: AudioScalarRamp;
        readonly pan: AudioScalarRamp;
        /** Mute is a hold channel sampled at the block's first sample. */
        readonly mute: boolean;
      }
    >
  >;
  readonly buses: Readonly<
    Record<
      string,
      {
        readonly gain: AudioScalarRamp;
        readonly pan: AudioScalarRamp;
        readonly mute: boolean;
      }
    >
  >;
}

export function evaluateAudioClipAtTime(
  clip: ProjectAudioClipV1,
  clipId: string,
  animations: NormalizedPropertyAnimationsV2 | undefined,
  time: PropertyAnimationTimeContext,
): ProjectAudioClipV1 {
  return {
    ...clip,
    gain: Math.max(
      0,
      sampleNumber(animations, audioClipPropertyBinding(clipId, 'gain'), time, clip.gain),
    ),
    pan: clamp(
      sampleNumber(animations, audioClipPropertyBinding(clipId, 'pan'), time, clip.pan),
      -1,
      1,
    ),
    mute: sampleBoolean(animations, audioClipPropertyBinding(clipId, 'mute'), time, clip.mute),
  };
}

export function evaluateAudioBusAtTime(
  bus: ProjectAudioBusV1,
  animations: NormalizedPropertyAnimationsV2 | undefined,
  time: PropertyAnimationTimeContext,
): ProjectAudioBusV1 {
  return {
    ...bus,
    gain: Math.max(
      0,
      sampleNumber(animations, audioBusPropertyBinding(bus.id, 'gain'), time, bus.gain),
    ),
    pan: clamp(
      sampleNumber(animations, audioBusPropertyBinding(bus.id, 'pan'), time, bus.pan),
      -1,
      1,
    ),
    mute: sampleBoolean(animations, audioBusPropertyBinding(bus.id, 'mute'), time, bus.mute),
  };
}

/** Samples every animatable mixer value at one audio-timeline time. */
export function evaluateProjectAudioAtTime(
  audio: ProjectAudioV1,
  animations: NormalizedPropertyAnimationsV2 | undefined,
  time: PropertyAnimationTimeContext,
): ProjectAudioV1 {
  return {
    ...audio,
    clips: Object.fromEntries(
      Object.entries(audio.clips).map(([clipId, clip]) => [
        clipId,
        evaluateAudioClipAtTime(clip, clipId, animations, time),
      ]),
    ),
    buses: audio.buses.map((bus) => evaluateAudioBusAtTime(bus, animations, time)),
  };
}

/**
 * Resolves each block's continuous controls at both endpoints. Consumers
 * interpolate these values across exactly this block; smoothingUs is reserved
 * for live changes that land between blocks. Hold channels deliberately use
 * their start value and do not crossfade.
 */
export function buildAudioAutomationBlock(
  audio: ProjectAudioV1,
  animations: NormalizedPropertyAnimationsV2 | undefined,
  time: PropertyAnimationTimeContext,
  range: AudioAutomationBlockRange,
): EvaluatedAudioBlock {
  assertRange(range);
  const start = atAudioTime(time, range.startUs);
  const end = atAudioTime(time, range.endUs);
  const clipBlock = (clip: ProjectAudioClipV1, clipId: string) => ({
    gain: ramp(
      evaluateAudioClipAtTime(clip, clipId, animations, start).gain,
      evaluateAudioClipAtTime(clip, clipId, animations, end).gain,
      'audio-clip',
      'gain',
    ),
    pan: ramp(
      evaluateAudioClipAtTime(clip, clipId, animations, start).pan,
      evaluateAudioClipAtTime(clip, clipId, animations, end).pan,
      'audio-clip',
      'pan',
    ),
    mute: evaluateAudioClipAtTime(clip, clipId, animations, start).mute,
  });
  const busBlock = (bus: ProjectAudioBusV1) => ({
    gain: ramp(
      evaluateAudioBusAtTime(bus, animations, start).gain,
      evaluateAudioBusAtTime(bus, animations, end).gain,
      'audio-bus',
      'gain',
    ),
    pan: ramp(
      evaluateAudioBusAtTime(bus, animations, start).pan,
      evaluateAudioBusAtTime(bus, animations, end).pan,
      'audio-bus',
      'pan',
    ),
    mute: evaluateAudioBusAtTime(bus, animations, start).mute,
  });
  return {
    clips: Object.fromEntries(
      Object.entries(audio.clips).map(([clipId, clip]) => [clipId, clipBlock(clip, clipId)]),
    ),
    buses: Object.fromEntries(audio.buses.map((bus) => [bus.id, busBlock(bus)])),
  };
}

function sampleNumber(
  animations: NormalizedPropertyAnimationsV2 | undefined,
  binding: ReturnType<typeof audioClipPropertyBinding> | ReturnType<typeof audioBusPropertyBinding>,
  time: PropertyAnimationTimeContext,
  fallback: number,
): number {
  const animation = animations?.[canonicalBindingKey(binding)];
  if (animation === undefined) return fallback;
  const resolved = resolvePropertyAnimationTime(animation.binding.timeDomain, time);
  const value = sampleAnimationValue(animation.value, resolved.timeUs);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sampleBoolean(
  animations: NormalizedPropertyAnimationsV2 | undefined,
  binding: ReturnType<typeof audioClipPropertyBinding> | ReturnType<typeof audioBusPropertyBinding>,
  time: PropertyAnimationTimeContext,
  fallback: boolean,
): boolean {
  const animation = animations?.[canonicalBindingKey(binding)];
  if (animation === undefined) return fallback;
  const resolved = resolvePropertyAnimationTime(animation.binding.timeDomain, time);
  const value = sampleAnimationValue(animation.value, resolved.timeUs);
  return typeof value === 'boolean' ? value : fallback;
}

function ramp(
  start: number,
  end: number,
  ownerKind: 'audio-clip' | 'audio-bus',
  propertyId: AudioClipPropertyId | AudioBusPropertyId,
): AudioScalarRamp {
  const descriptor = audioAutomationDescriptor(ownerKind, propertyId);
  if (descriptor?.interpolation !== 'linear-ramp') {
    throw new RangeError('missing continuous audio descriptor for ' + ownerKind + '.' + propertyId);
  }
  return { start, end, smoothingUs: descriptor.smoothingUs };
}

function atAudioTime(
  time: PropertyAnimationTimeContext,
  audioTimelineTimeUs: number,
): PropertyAnimationTimeContext {
  return { ...time, audioTimelineTimeUs };
}

function assertRange(range: AudioAutomationBlockRange): void {
  if (
    !Number.isSafeInteger(range.startUs) ||
    !Number.isSafeInteger(range.endUs) ||
    range.startUs < 0 ||
    range.endUs < range.startUs
  )
    throw new RangeError('audio automation block range must be ordered safe integer microseconds');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
