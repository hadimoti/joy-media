# motion-core

> **Status: WP-04.1 built.** Universal keyframe motion engine.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §20.3 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Keyframes, curves, easing, spatial paths, and value scaling on top of the
durable §20.3 animation schema (`AnimationCurveV1` / `KeyframeV1`) that lives in
`@joy-media/project-schema`. Pure functions only.

**What it owns**

- Temporal interpolation — `hold` / `linear` / `eased` / `bezier` with a CSS-style
  cubic-bezier solver (`interpolation.ts`).
- Curve editing — `sampleCurve`, `setKeyframe`, `removeKeyframe`, value scaling,
  and time-relative copy/paste (`curve.ts`).
- Spatial interpolation — a 2D motion-path sampler with Bezier tangents
  (`spatial.ts`); durable path storage + graph editor are WP-04.2.
- Effective-transform resolution — `resolveAnimatedTransform` samples animated
  channels and falls back to static values (`transform.ts`).
- The durable `object.replaceAnimation` command with a pre-state inverse
  (`commands.ts`), routed through `@joy-media/property-system` onto the shared
  v1 history for undo/redo and persistence.

**Must not:** Expressions (deferred, §20.3); wall-clock or randomness; any renderer
or I/O. Dependency points inward (§9.1): motion-core → project-schema only.
