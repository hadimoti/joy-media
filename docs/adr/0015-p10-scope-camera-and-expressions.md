# ADR-0015: P10 scope — bounded 2.5D camera and restricted expressions

Status: Accepted
Date: 2026-07-20

## Context

P10 (`plan/P10-advanced.md`, master plan §36 Phase 10) is an intentional parking
lot of ten unrelated advanced capabilities: cameras/2.5D/3D, restricted
expressions, multicam, advanced color/HDR, advanced raster/vector paint tools,
advanced audio restoration/multichannel, broad interchange formats, render-farm
optimization, publishing integrations, and enterprise governance. The plan text
is explicit that nothing in this list may be opened without an ADR, and no work
packages existed yet.

The owner selected **cameras/3D + expressions** as the first P10 capability area
to scope, extending P04's motion system (§20.3 "later motion system": safe
expressions, cameras and 2.5D layers, 3D transforms).

## Decision

Open P10 with exactly two bounded capabilities; every other parked item stays
closed and untouched:

1. **2.5D depth camera.** A composition may declare an `activeCameraId`. Camera
   objects (`kind: 'camera'`) carry position/roll via the existing transform
   (`x`, `y`, `positionZ`, `rotationDeg`) plus a vertical field of view. Ordinary
   layers gain an optional `positionZ` depth. Projection is a **depth-only**
   perspective (dolly/track/roll/zoom across a stack of depth-offset flat
   layers) — there is deliberately **no camera yaw/pitch and no per-layer 3D
   tilt** in this scope. A projected layer still reduces to the exact
   `VisualObjectTransformV1` shape the renderer already consumes (translate +
   uniform scale + 2D rotation), so **Render IR, renderer-pixi, and
   renderer-headless need zero changes** — projection is an additional pure
   composition step alongside P04's parenting, not a new rendering primitive.
   True oriented 3D planes/quads would require a Render IR shape change (a
   core-invariant change) and stay explicitly out of scope until a dedicated
   ADR; "full 3D scene authoring" remains a standing non-goal (§5.2).
   Compositions without an `activeCameraId` are byte-for-byte unaffected —
   this is additive and cannot regress any P00–P09 render or golden.
2. **Restricted expressions.** A future WP will add a sandboxed, non-Turing-complete
   expression language bound to specific animatable channels, following the
   §20.3 expression policy verbatim: no DOM/network/filesystem/process/wall-clock
   access, seeded random + JOY time APIs only, bounded evaluation (no
   loops/user-defined functions — arithmetic + an allowlisted function set +
   explicit references to other channels), cycle-checked dependencies, cached
   pure results, and per-property diagnostics instead of thrown exceptions
   (matching the coded-diagnostic pattern already used by project-schema and
   html-scene-runtime). It must run in-browser (editor-web) as well as
   headless, so it cannot reuse P00.4's Node `vm` sandbox; it is a small
   hand-written parser/interpreter, not an `eval`/`Function`-based sandbox.

Everything else in the P10 list (multicam, HDR/color, paint/vector tools, audio
restoration, interchange formats, render-farm, publishing integrations,
enterprise governance) remains **not-scoped**. If any P0–P9 task appears to
need one of those, that is still a §46.3 stop condition.

## Alternatives considered

- **Full 3D camera (yaw/pitch/tilt, oriented layer planes).** Rejected for this
  opening scope: it requires extending Render IR's `Transform2D` (currently
  translate/scale only, no rotation field) into a true 3D/quad representation
  and touches every renderer adapter — a core-invariant change that deserves
  its own ADR and gate, not folded into the first P10 work package.
- **Unrestricted (arbitrary JS) expressions.** Explicitly a standing non-goal
  (§5.2 "unrestricted expressions or arbitrary native plugins") — determinism,
  security, and dependency-cycle risk rule it out regardless of P10 gating.

## Consequences

WP-10.1 can add the camera schema, pure projection/composition math, evaluator
wiring, and undoable commands now. WP-10.3+ can add the expression engine on
the same footing. Neither implies scope for the other eight parked P10 items,
and neither implies the later, harder 3D/yaw-pitch camera extension — that
stays a separate future decision.

## Validation and rollback

`positionZ`, `camera`, and `activeCameraId` are additive optional fields;
existing v1 projects validate and render unchanged. Rollback is deleting the
new package/fields — no migration or destructive schema change is involved.

## Related contracts/tests

`packages/project-schema/src/v1.ts`, new `packages/camera-core`,
`packages/evaluator/src/properties.ts`, `packages/property-system/src/index.ts`,
`plan/P10-advanced.md`.
