/**
 * Living Looks audio-reactive bake (R2 / L4, GAP 2).
 *
 * Ties decoded composition audio to a Look's keyframe bindings:
 *   decoded PCM  → `extractAudioObservationWindow` → `buildBeatEnvelope`
 *   (R1 evidence) → `beatEnvelopeToLookEnvelope` (source→composition time map)
 *   → `bakeLookAudio` (one bounded keyframe track per driven binding).
 *
 * The result feeds `LookCompileInput.audioBakes`, where the baked keys replace
 * the slider drive on that binding verbatim. Silence or a low-confidence
 * estimate is passed through honestly — the baker flattens it to a rest line and
 * this module reports it rather than inventing a beat.
 *
 * The `AudioContext.decodeAudioData` call itself stays in the caller (it needs a
 * real browser AudioContext); this module is a pure function of the decoded
 * channel data and the clip placement, so it is unit-testable with synthetic
 * PCM.
 */

import {
  buildBeatEnvelope,
  extractAudioObservationWindow,
  type AudioCompositionTimeMapping,
} from '@joy-media/audio-core';
import {
  resolveLookAudioBakeTargets,
  type LookAudioBakeInput,
  type LookDefinition,
} from '@joy-media/motion-core';
import {
  beatEnvelopeToLookEnvelope,
  bakeLookAudio,
  type LookAudioBakeRequest,
} from './joy-agent/look-audio-bridge.js';

/** Max keyframes per baked binding — a hard ceiling on one bake track. */
export const MAX_LOOK_AUDIO_BAKE_KEYS = 96;
/** Envelope smoothing (fraction of the range that one step may move). */
const DEFAULT_BAKE_SMOOTHING = 0.35;
/** Bounded PCM visit budget for one bake pass. */
const MAX_BAKE_SAMPLE_VISITS = 4_000_000;

export interface DecodedCompositionAudio {
  readonly sampleRate: number;
  /** One or two planar channels of Float32 PCM. */
  readonly channels: readonly Float32Array[];
  /** Source time of sample index zero (usually 0 for a whole decoded clip). */
  readonly sourceOffsetUs: number;
}

export interface LookAudioClipPlacement {
  /** Composition time the audio clip starts at. */
  readonly compositionStartUs: number;
  /** Composition-visible duration of the clip (end-exclusive). */
  readonly compositionDurationUs: number;
  /** Source time visible at the clip's start (its in-point). */
  readonly sourceAnchorUs: number;
  /**
   * Source µs consumed per composition µs, as a ratio. `{ numerator: 1,
   * denominator: 1 }` is a normal-speed clip; a 2× speed clip is
   * `{ numerator: 2, denominator: 1 }`. A change here re-derives the timing, so
   * a later speed/remap edit invalidates a stale bake.
   */
  readonly sourcePerComposition: { readonly numerator: number; readonly denominator: number };
}

export interface BakeLookFromAudioInput {
  readonly definition: LookDefinition;
  readonly controlValues: Readonly<Record<string, number | string | boolean>>;
  readonly audio: DecodedCompositionAudio;
  readonly clip: LookAudioClipPlacement;
  /** RMS (loudness envelope) or peak (transient) — default RMS. */
  readonly channel?: 'rms' | 'peak';
}

export interface BakeLookFromAudioResult {
  /** Compiler-ready bakes; empty when the Look has no numeric keyframe drive. */
  readonly audioBakes: readonly LookAudioBakeInput[];
  /** True when the source is silent / the estimate has no usable level. */
  readonly silent: boolean;
  /** R1 beat-grid regularity confidence in [0, 1] — never model comprehension. */
  readonly confidence: number;
  /** Worst per-binding approximation error across the emitted tracks. */
  readonly maxApproximationError: number;
  /** Human-readable notes (per-binding compile diagnostics), for the panel. */
  readonly diagnostics: readonly string[];
}

function mappingFor(clip: LookAudioClipPlacement): AudioCompositionTimeMapping {
  return {
    compositionStartUs: clip.compositionStartUs,
    compositionDurationUs: clip.compositionDurationUs,
    sourceAnchorUs: clip.sourceAnchorUs,
    direction: 'forward',
    sourcePerComposition: {
      numerator: clip.sourcePerComposition.numerator,
      denominator: clip.sourcePerComposition.denominator,
    },
  };
}

export function bakeLookFromAudio(input: BakeLookFromAudioInput): BakeLookFromAudioResult {
  const targets = resolveLookAudioBakeTargets(input.definition, input.controlValues);
  if (targets.length === 0) {
    return {
      audioBakes: [],
      silent: false,
      confidence: 0,
      maxApproximationError: 0,
      diagnostics: ['This Look has no numeric keyframe drive to bake from audio.'],
    };
  }

  const mapping = mappingFor(input.clip);
  // The source window matches the clip's visible source span.
  const sourceSpanUs = Math.max(
    1,
    Math.round(
      (input.clip.compositionDurationUs * input.clip.sourcePerComposition.numerator) /
        input.clip.sourcePerComposition.denominator,
    ),
  );
  const window = extractAudioObservationWindow(
    {
      sampleRate: input.audio.sampleRate,
      channelData: input.audio.channels.map((c) => new Float32Array(c)),
      sourceOffsetUs: input.audio.sourceOffsetUs,
    },
    {
      sourceStartUs: input.clip.sourceAnchorUs,
      durationUs: sourceSpanUs,
      maxSampleVisits: MAX_BAKE_SAMPLE_VISITS,
      mapping,
    },
  );

  // One envelope point per ~composition frame-ish; `buildBeatEnvelope` caps at
  // 512 points internally.
  const framesPerPoint = Math.max(1, Math.ceil(window.sampleCount / 512));
  const estimate = buildBeatEnvelope(window, {
    frameSizeSamples: framesPerPoint,
    hopSamples: framesPerPoint,
  });

  const envelope = beatEnvelopeToLookEnvelope(
    estimate,
    (sourceUs) => {
      const t = mapSourceToComposition(sourceUs, mapping);
      return t;
    },
    { channel: input.channel ?? 'rms' },
  );

  const requests: LookAudioBakeRequest[] = targets.map((target) => ({
    bindingId: target.bindingId,
    propertyMin: Math.min(target.restValue, target.peakValue),
    propertyMax: Math.max(target.restValue, target.peakValue),
    restValue: target.restValue,
    smoothing: DEFAULT_BAKE_SMOOTHING,
    maxKeys: MAX_LOOK_AUDIO_BAKE_KEYS,
  }));

  const { bakes, results } = bakeLookAudio(envelope, requests);
  const audioBakes: LookAudioBakeInput[] = bakes.map((bake) => ({
    bindingId: bake.bindingId,
    keys: bake.keys.map((k) => ({ timeUs: k.timeUs, value: k.value })),
    interpolation: 'linear',
  }));

  const diagnostics = results.flatMap((result) =>
    result.diagnostics.map((note) => `${result.bindingId}: ${note}`),
  );
  const maxApproximationError = results.reduce(
    (worst, result) => Math.max(worst, result.approximationError),
    0,
  );

  return {
    audioBakes,
    silent: envelope.silent,
    confidence: envelope.confidence,
    maxApproximationError,
    diagnostics,
  };
}

/** Local copy of the source→composition map so this module needs no re-export. */
function mapSourceToComposition(
  sourceUs: number,
  mapping: AudioCompositionTimeMapping,
): number | undefined {
  if (!Number.isFinite(sourceUs) || sourceUs < 0) return undefined;
  const deltaUs = sourceUs - mapping.sourceAnchorUs;
  if (deltaUs < 0) return undefined;
  const compositionOffsetUs =
    (deltaUs * mapping.sourcePerComposition.denominator) / mapping.sourcePerComposition.numerator;
  if (compositionOffsetUs >= mapping.compositionDurationUs) return undefined;
  return mapping.compositionStartUs + compositionOffsetUs;
}
