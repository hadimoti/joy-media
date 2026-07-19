# renderer-pixi

> **Status: P01.3 minimal preview host implemented.** A fixed-setting, software test mode consumes Render IR, flattens groups, and keeps editor overlays separate from content pixels; retained PixiJS object management lands in P02. This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §15, §2.1 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Interactive preview adapter mapping Render IR to a retained Pixi scene graph.

**First built in part:** P00 (spike) then P02. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Becoming the project model, timeline model, or export engine (§2.1).

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
