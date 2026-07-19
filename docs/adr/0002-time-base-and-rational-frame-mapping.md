# ADR-0002: Project time base and rational frame mapping

Status: Accepted
Date: 2026-07-19

## Context

Master plan §4.4/§10.5 mandate integer time and rational frame rates but leave the exact mapping rule, rounding direction, and where the primitives live to implementation. WP-00.1 (time/evaluation spike) had to fix these before anything else could be built. This is required early ADR #1 from §41.1.

## Decision

1. **Durable time is integer microseconds** (`TimeUs`), stored as JS `number` restricted to safe non-negative integers, validated at construction/conversion. No float seconds ever enter durable state.
2. **`TimeUs` is a plain alias, not a branded type, for now.** Branding (§45.2 "where useful") is deferred until schema v1 (WP-01.1) when we see how commands consume time values; validators enforce integrality in the meantime.
3. **Frame mapping rule** for a rate `num/den` (frames per second):
   - frame `i` starts at `frameStartUs(i) = ceil(i · 10⁶ · den / num)`;
   - time `t` belongs to frame `frameIndexAtUs(t) = floor(t · num / (10⁶ · den))`.
     The ceil/floor pairing guarantees the exact round-trip `frameIndexAtUs(frameStartUs(i)) === i` for every rate below 10⁶ fps (proven by test across integer and NTSC rates including 30000/1001, 24000/1001, 60000/1001, 120000/1001).
4. **All conversions compute in BigInt internally** and return checked safe integers, so large frame indices and long timelines stay exact.
5. **Ranges are end-exclusive** `[startUs, startUs + durationUs)`. Touching ranges do not intersect. Clips require `durationUs > 0` (§10.5 v1.1); zero-duration ranges are markers.
6. **Time primitives live in `@joy-media/project-schema`** (the innermost package) rather than a separate primitives package; the evaluator and everything else import from there. Split out only if a real cycle appears.
7. Snapping (`snapUsToFrame`) floors to the containing frame's start and is idempotent.

## Alternatives considered

- **Float seconds** — rejected outright by §4.4 (drift, non-determinism).
- **Integer frame counts as the time base** — rejected: mixed-rate compositions and audio need sub-frame time; frames become a projection of time, not the base.
- **Nanoseconds** — rejected: exceeds safe-integer range in ~104 days of media time; microseconds give ~285 years.
- **round() instead of ceil/floor pairing** — rejected: breaks the exact round-trip at NTSC rates (frame 1 at 30000/1001 rounds to 33367 but a floor-based index maps 33366 → 0 and round-tripping floor(round()) misassigns boundary microseconds).
- **Full branded types now** — deferred; cost to spike ergonomics outweighs safety before commands exist.

## Consequences

- Every future package converts through these functions; hand-rolled `t * fps / 1e6` math is a review-blocker (§44).
- Audio sample mapping (WP-00.7) must define its own explicit rounding rule against this base.
- Drop-frame timecode remains display-only (§10.5); it never changes the base.

## Validation and rollback

`packages/project-schema/src/time.test.ts` proves round-trips, boundary ownership, monotonicity, integer-only outputs, and end-exclusive semantics. Changing the mapping rule later requires a superseding ADR plus a schema migration for any persisted frame-derived values.

## Related contracts/tests

`packages/project-schema/src/time.ts` · `time.test.ts` · `packages/evaluator/src/evaluate.test.ts` (exact NTSC frame evaluation) · master plan §4.4, §10.5, §14.4.
