# timeline-engine

> **Status: WP-02.1 started.** Pure timeline coordinate conversion and pixel-threshold snapping are implemented; rendering stays in the editor app.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §19 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Editing semantics: intervals, trim/slip/slide/roll/ripple, snapping, linked clips, virtualization models. Owns semantics, not drawing.

**First built in part:** P01–P02. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Rendering/DOM concerns; O(project size) work on interactive paths.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
