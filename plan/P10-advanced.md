# P10 — Advanced Professional Systems (Optional / LATER)

**Status:** in-progress · **Gate to enter:** P09-era, owner approval per capability (ADR-0015) · **Master plan:** §36 Phase 10, §20.3
**Goal:** Open exactly the P10 capabilities the owner selects, one ADR at a time; everything else in the parking lot stays closed.

**Scope opened 2026-07-20 (ADR-0015):** a bounded 2.5D depth camera and a restricted/sandboxed expression language. Both extend P04's motion system (§20.3 "later motion system").

## Work packages

- [x] **WP-10.1 — Camera core** _(done 2026-07-20)_. `positionZ` depth joins `VisualObjectTransformV1` and the animatable-property set (keyframeable via the existing curve engine, no expression engine needed); `kind: 'camera'` objects carry a vertical field of view; compositions may declare an `activeCameraId`. New `camera-core` package composes parent-chain depth and a pure depth-only perspective projection (dolly/track/roll/zoom; **no yaw/pitch, no per-layer 3D tilt** — ADR-0015) that reduces to the existing `VisualObjectTransformV1` shape, so Render IR and every renderer adapter are untouched. The evaluator exposes `evaluateCameraTransform`; the undoable `composition.setActiveCamera` command rides the shared v1 history. No active camera ⇒ byte-for-byte identical output to pre-P10 projects.
- [x] **WP-10.2 — Camera UI** _(done 2026-07-20)_. Undoable `camera.create`/`camera.remove` (removal rejected while still an active camera or a parent — a foreign-key guard, not cascade logic) and `camera.setFieldOfView` commands round out the camera command surface. A new Camera panel creates/selects camera objects (its own local selection, since cameras carry no timeline clip), edits position/depth/roll/FOV/parent, and picks the active camera per composition. Verified live: create → activate → dolly the depth field → undo three times (value, active-camera, creation itself all cleanly reverse) → redo three times (all restore) → reload (state persists through the durable command log). **Known gap, not this WP's to close:** editor-web has no live pixel-preview canvas at all yet (`monitor` is a label-only placeholder across every P00–P09 session) — parallax correctness is proven by camera-core/evaluator's tests calling the real projection function, not by an on-screen rendered comparison.
- [ ] **WP-10.3 — Restricted expression engine.** A hand-written, non-Turing-complete expression parser/interpreter (no `eval`/`Function`, must run in-browser and headless) bound to animatable channels: arithmetic, comparisons, ternary, an allowlisted math/easing function set, explicit references to other channels/objects, seeded random, JOY time — no DOM/network/filesystem/process/wall-clock. Bounded evaluation (AST size limits, no user-defined functions/loops). Dependency cycle detection. Per-property diagnostics, never a thrown exception into the evaluator.
- [ ] **WP-10.4 — Expression schema + evaluator + UI.** Durable per-channel expression storage (alternative to, or layered with, a keyframe curve) on `VisualObjectV1`; evaluator wiring with memoized pure evaluation; undoable `object.setExpression` command; per-property expression input + inline error display in the Inspector.
- [ ] **WP-10.5 — Gate review.** Combined evidence: a reel using a moving 2.5D camera across depth-offset layers plus at least one restricted expression, rendered through the real export path; forbidden-expression-capability tests (no DOM/network/wall-clock reachable); cycle detection rejects a self-referential expression; a composition with no active camera renders identically to its pre-P10 output (regression guard).

## Exit criteria (bounded scope only — ADR-0015)

- [ ] A composition with a keyframed/dollying 2.5D camera renders correct parallax across depth-offset layers through the real render/export path.
- [x] A composition with no `activeCameraId` is byte-for-byte unaffected (no regression to any P00–P09 render or golden) — proven by `evaluateCameraTransform`/`resolveObjectTransformThroughCamera` test parity with the pre-P10 parenting-only resolver.
- [ ] Restricted expressions cannot reach DOM/network/filesystem/process/wall-clock; a runaway or cyclic expression fails as a per-property diagnostic, never a crash or hang.
- [ ] Expression and camera edits are undoable/redoable and survive reopen through the durable command log.

## Still parked (no ADR yet — §46.3 stop condition if any P0–P9 task appears to need one)

multicam · advanced color/HDR pipeline · advanced raster paint/vector tools ·
advanced audio restoration/multichannel · broad interchange formats
(EDL/AAF/PSD round-trip) · render-farm optimization/render-graph partitioning ·
publishing integrations · enterprise governance. A true 3D camera (yaw/pitch,
oriented layer planes) is also explicitly deferred past this scope — see
ADR-0015 alternatives.
