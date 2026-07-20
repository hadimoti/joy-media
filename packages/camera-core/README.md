# camera-core

> **Status: WP-10.1 built.** Depth-only 2.5D camera projection.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §20.3 · [`ADR-0015`](../../docs/adr/0015-p10-scope-camera-and-expressions.md) · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** A pure, depth-only perspective camera on top of `@joy-media/motion-core`'s
parent-chain composition. A `kind: 'camera'` visual object (position/roll on its
ordinary transform, plus a vertical field of view) projects depth-offset
(`positionZ`) layers into the exact `VisualObjectTransformV1` shape the renderer
already consumes — translate + uniform scale + 2D rotation. No renderer, Render
IR, or export-pipeline change is needed.

**What it owns**

- `projection.ts` — `focalLengthPx` and `projectThroughCamera`: pure perspective
  math (dolly/track/roll/zoom). No yaw/pitch, no per-layer 3D tilt (ADR-0015) —
  a layer stays a flat plane; only its depth position changes its projected
  scale, producing dolly-zoom and parallax across a depth-offset layer stack.
- `scene.ts` — `worldDepth` (additive `positionZ` composition down the parent
  chain, mirroring motion-core's `composeTransforms`), `resolveCameraParams`,
  and `resolveObjectTransformThroughCamera` — the composed entry point:
  identical to `resolveWorldTransform` when no camera is supplied, so a
  composition without an `activeCameraId` is byte-for-byte unaffected.

**Must not:** Camera yaw/pitch, per-layer 3D tilt/oriented planes, Render IR
changes, expressions, wall-clock/randomness, any renderer or I/O. Dependency
points inward (§9.1): camera-core → motion-core → project-schema.
