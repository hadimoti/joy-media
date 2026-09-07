/**
 * Living Looks audio bridge (R2 / L4).
 *
 * Maps R1's `BeatEnvelopeEstimate` (source-time RMS/peak envelope + beat
 * confidence) onto the minimal `LookAudioEnvelope` the pure `bakeAudioReactive`
 * consumes. The editor host owns the source→composition time mapping; this
 * bridge only reshapes and normalises, and never invents beats — a silent or
 * low-confidence estimate is passed through as such.
 */

import type { BeatEnvelopeEstimate } from '@joy-media/audio-core';
import {
  bakeAudioReactive,
  type BakeAudioReactiveResult,
  type LookAudioEnvelope,
  type LookAudioEnvelopeSample,
} from '@joy-media/motion-core';

export interface BeatEnvelopeBridgeOptions {
  /** Which per-frame measure to normalise into the `[0,1]` level. */
  readonly channel?: 'rms' | 'peak';
}

/**
 * @param estimate the R1 beat-envelope evidence
 * @param mapSourceUsToCompositionUs source µs -> composition µs, or `undefined`
 *   when the source time falls outside the mapped window
 */
export function beatEnvelopeToLookEnvelope(
  estimate: BeatEnvelopeEstimate,
  mapSourceUsToCompositionUs: (sourceUs: number) => number | undefined,
  options: BeatEnvelopeBridgeOptions = {},
): LookAudioEnvelope {
  const channel = options.channel ?? 'rms';
  const raw: { compositionTimeUs: number; value: number }[] = [];
  let peakValue = 0;
  for (const point of estimate.envelope) {
    const midpoint = Math.round((point.sourceStartUs + point.sourceEndUs) / 2);
    const compositionTimeUs = mapSourceUsToCompositionUs(midpoint);
    if (typeof compositionTimeUs !== 'number' || !Number.isFinite(compositionTimeUs)) continue;
    const value = channel === 'peak' ? point.peak : point.rms;
    if (!Number.isFinite(value) || value < 0) continue;
    raw.push({ compositionTimeUs, value });
    peakValue = Math.max(peakValue, value);
  }

  // Keep composition times strictly increasing (a slow source or a fold in the
  // mapping can produce ties / regressions).
  raw.sort((a, b) => a.compositionTimeUs - b.compositionTimeUs);
  const samples: LookAudioEnvelopeSample[] = [];
  for (const entry of raw) {
    if (
      samples.length > 0 &&
      entry.compositionTimeUs <= samples[samples.length - 1]!.compositionTimeUs
    ) {
      continue;
    }
    samples.push({
      compositionTimeUs: entry.compositionTimeUs,
      level: peakValue > 0 ? Math.min(1, entry.value / peakValue) : 0,
    });
  }

  return {
    evidenceVersion: estimate.algorithmVersion,
    samples,
    silent: estimate.silent || samples.length === 0,
    confidence: estimate.confidence,
  };
}

export interface LookAudioBakeRequest {
  readonly bindingId: string;
  readonly propertyMin: number;
  readonly propertyMax: number;
  readonly restValue?: number;
  readonly smoothing: number;
  readonly maxKeys: number;
}

export interface LookAudioBake {
  readonly bindingId: string;
  readonly keys: readonly { timeUs: number; value: number }[];
}

/**
 * Bake one or more property bindings from a bridged envelope. Returns
 * `{ bakes, results }` — `bakes` is the compiler-ready shape for
 * `LookCompileInput.audioBakes`; `results` carries the per-binding
 * approximation error and diagnostics for display.
 */
export function bakeLookAudio(
  envelope: LookAudioEnvelope,
  requests: readonly LookAudioBakeRequest[],
): {
  readonly bakes: readonly LookAudioBake[];
  readonly results: readonly BakeAudioReactiveResult[];
} {
  const bakes: LookAudioBake[] = [];
  const results: BakeAudioReactiveResult[] = [];
  for (const request of requests) {
    const result = bakeAudioReactive({
      envelope,
      bindingId: request.bindingId,
      propertyMin: request.propertyMin,
      propertyMax: request.propertyMax,
      ...(request.restValue === undefined ? {} : { restValue: request.restValue }),
      smoothing: request.smoothing,
      maxKeys: request.maxKeys,
    });
    results.push(result);
    if (result.ok) bakes.push({ bindingId: request.bindingId, keys: result.keys });
  }
  return { bakes, results };
}
