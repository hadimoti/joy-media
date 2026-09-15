/**
 * Audio-reactive motion baking (R2 / L4).
 *
 * Pure, deterministic, no I/O. Turns a bounded audio envelope (already mapped
 * to composition time by the host from R1's beat-envelope evidence) into
 * ordinary keyframes on one declared property binding, with:
 *  - a hard `maxKeys` ceiling and a reported `approximationError` when it
 *    decimates;
 *  - smoothing that can never overshoot the declared `[propertyMin,
 *    propertyMax]` range, because it averages already-clamped values;
 *  - a flat, constant curve for silence or low-confidence evidence — it never
 *    invents downbeats;
 *  - a `restValue` the curve returns to between events.
 *
 * Human edits to a generated key and "reanalysis proposes a diff, not an
 * overwrite" are host concerns (`LookInstance.overriddenBindingIds` and the
 * prepare/approve path); this function only bakes.
 */

export const LOOK_AUDIO_REACTIVE_VERSION = 'joy-look-audio-reactive-v1' as const;

/** Below this heuristic regularity confidence the bake is flat — no invented beats. */
export const LOOK_AUDIO_MIN_CONFIDENCE = 0.15;

export interface LookAudioEnvelopeSample {
  readonly compositionTimeUs: number;
  /** Normalised local level in `[0, 1]`; not a loudness value. */
  readonly level: number;
}

export interface LookAudioEnvelope {
  /** e.g. `joy-beat-envelope-v1` — changing speed/remap must produce a new envelope. */
  readonly evidenceVersion: string;
  readonly samples: readonly LookAudioEnvelopeSample[];
  readonly silent: boolean;
  /** Heuristic regularity confidence in `[0, 1]`, never model comprehension. */
  readonly confidence: number;
}

export interface BakeAudioReactiveInput {
  readonly envelope: LookAudioEnvelope;
  readonly bindingId: string;
  readonly propertyMin: number;
  readonly propertyMax: number;
  /** Value the property holds where the envelope level is 0. Defaults to `propertyMin`. */
  readonly restValue?: number;
  /** Moving-average window as a fraction of the sample count, `[0, 1]`. */
  readonly smoothing: number;
  /** Hard ceiling on the emitted key count. Must be >= 2. */
  readonly maxKeys: number;
}

export interface BakedKey {
  readonly timeUs: number;
  readonly value: number;
}

export interface BakeAudioReactiveResult {
  readonly ok: boolean;
  readonly version: typeof LOOK_AUDIO_REACTIVE_VERSION;
  readonly bindingId: string;
  readonly keys: readonly BakedKey[];
  /** Max absolute value error (property units) introduced by decimation; 0 if not decimated. */
  readonly approximationError: number;
  readonly decimated: boolean;
  /** True when the curve is a flat rest line — silence or low confidence. */
  readonly flat: boolean;
  readonly diagnostics: readonly string[];
}

function clampToRange(value: number, a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.min(hi, Math.max(lo, value));
}

function fail(bindingId: string, diagnostics: readonly string[]): BakeAudioReactiveResult {
  return {
    ok: false,
    version: LOOK_AUDIO_REACTIVE_VERSION,
    bindingId,
    keys: [],
    approximationError: 0,
    decimated: false,
    flat: false,
    diagnostics,
  };
}

export function bakeAudioReactive(input: BakeAudioReactiveInput): BakeAudioReactiveResult {
  const { envelope, bindingId } = input;
  const diagnostics: string[] = [];

  if (!Number.isFinite(input.propertyMin) || !Number.isFinite(input.propertyMax)) {
    return fail(bindingId, ['propertyMin/propertyMax must be finite']);
  }
  if (input.propertyMin === input.propertyMax) {
    return fail(bindingId, ['propertyMin and propertyMax must differ']);
  }
  if (!Number.isInteger(input.maxKeys) || input.maxKeys < 2) {
    return fail(bindingId, ['maxKeys must be an integer >= 2']);
  }
  if (!Number.isFinite(input.smoothing) || input.smoothing < 0 || input.smoothing > 1) {
    return fail(bindingId, ['smoothing must be in [0,1]']);
  }
  if (!Number.isFinite(envelope.confidence) || envelope.confidence < 0 || envelope.confidence > 1) {
    return fail(bindingId, ['envelope.confidence must be in [0,1]']);
  }
  if (envelope.samples.length < 2) {
    return fail(bindingId, ['envelope must have at least two samples']);
  }
  for (let i = 0; i < envelope.samples.length; i += 1) {
    const s = envelope.samples[i]!;
    if (
      !Number.isFinite(s.compositionTimeUs) ||
      !Number.isFinite(s.level) ||
      s.level < 0 ||
      s.level > 1
    ) {
      return fail(bindingId, [`sample ${i} is out of range`]);
    }
    if (i > 0 && s.compositionTimeUs <= envelope.samples[i - 1]!.compositionTimeUs) {
      return fail(bindingId, ['envelope samples must be strictly time-ordered']);
    }
  }

  const restValue = clampToRange(
    input.restValue ?? input.propertyMin,
    input.propertyMin,
    input.propertyMax,
  );
  const first = envelope.samples[0]!.compositionTimeUs;
  const last = envelope.samples[envelope.samples.length - 1]!.compositionTimeUs;

  // Silence or low confidence -> a flat rest line. Two keys, no invented events.
  if (envelope.silent || envelope.confidence < LOOK_AUDIO_MIN_CONFIDENCE) {
    if (envelope.confidence < LOOK_AUDIO_MIN_CONFIDENCE && !envelope.silent) {
      diagnostics.push(
        `beat confidence ${envelope.confidence.toFixed(2)} below ${LOOK_AUDIO_MIN_CONFIDENCE}; baked a flat curve`,
      );
    }
    return {
      ok: true,
      version: LOOK_AUDIO_REACTIVE_VERSION,
      bindingId,
      keys: [
        { timeUs: first, value: restValue },
        { timeUs: last, value: restValue },
      ],
      approximationError: 0,
      decimated: false,
      flat: true,
      diagnostics,
    };
  }

  // Map level -> property value, then clamp. rest at level 0, full excursion at level 1.
  const mapped = envelope.samples.map((s) => ({
    timeUs: s.compositionTimeUs,
    value: clampToRange(
      restValue + s.level * (input.propertyMax - restValue),
      input.propertyMin,
      input.propertyMax,
    ),
  }));

  // Moving-average smoothing. An average of values already inside the range is
  // still inside the range, so this can never overshoot the declared limits.
  const window = Math.max(1, Math.round(input.smoothing * mapped.length));
  const smoothed = mapped.map((_, i) => {
    const lo = Math.max(0, i - Math.floor(window / 2));
    const hi = Math.min(mapped.length - 1, i + Math.floor(window / 2));
    let sum = 0;
    for (let j = lo; j <= hi; j += 1) sum += mapped[j]!.value;
    return { timeUs: mapped[i]!.timeUs, value: sum / (hi - lo + 1) };
  });

  // Decimate to maxKeys, keeping the endpoints and the largest-error points.
  let keys: BakedKey[] = smoothed;
  let approximationError = 0;
  let decimated = false;
  if (smoothed.length > input.maxKeys) {
    decimated = true;
    const result = decimateToMax(smoothed, input.maxKeys);
    keys = result.keys;
    approximationError = result.error;
    diagnostics.push(
      `decimated ${smoothed.length} -> ${keys.length} keys, max error ${approximationError.toFixed(4)}`,
    );
  }

  return {
    ok: true,
    version: LOOK_AUDIO_REACTIVE_VERSION,
    bindingId,
    keys,
    approximationError,
    decimated,
    flat: false,
    diagnostics,
  };
}

/**
 * Keep both endpoints, then repeatedly insert the point of maximum vertical
 * error against the current polyline until the budget is spent. Reports the
 * remaining maximum error.
 */
function decimateToMax(
  points: readonly BakedKey[],
  maxKeys: number,
): { keys: BakedKey[]; error: number } {
  const kept = new Set<number>([0, points.length - 1]);
  while (kept.size < maxKeys) {
    const sorted = [...kept].sort((a, b) => a - b);
    let worstIndex = -1;
    let worstError = 0;
    for (let s = 0; s < sorted.length - 1; s += 1) {
      const a = points[sorted[s]!]!;
      const b = points[sorted[s + 1]!]!;
      for (let i = sorted[s]! + 1; i < sorted[s + 1]!; i += 1) {
        const p = points[i]!;
        const t = (p.timeUs - a.timeUs) / (b.timeUs - a.timeUs);
        const interpolated = a.value + t * (b.value - a.value);
        const err = Math.abs(p.value - interpolated);
        if (err > worstError) {
          worstError = err;
          worstIndex = i;
        }
      }
    }
    if (worstIndex < 0) break;
    kept.add(worstIndex);
  }

  // Final error: the max deviation of any dropped point from the kept polyline.
  const sorted = [...kept].sort((a, b) => a - b);
  let error = 0;
  for (let s = 0; s < sorted.length - 1; s += 1) {
    const a = points[sorted[s]!]!;
    const b = points[sorted[s + 1]!]!;
    for (let i = sorted[s]! + 1; i < sorted[s + 1]!; i += 1) {
      const p = points[i]!;
      const t = (p.timeUs - a.timeUs) / (b.timeUs - a.timeUs);
      error = Math.max(error, Math.abs(p.value - (a.value + t * (b.value - a.value))));
    }
  }
  return { keys: sorted.map((i) => points[i]!), error };
}
