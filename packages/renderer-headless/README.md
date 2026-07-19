# renderer-headless

> **Status: P00.3 reference path implemented.** A pinned, deterministic software renderer consumes Render IR for the first golden-frame comparison; media decode and FFmpeg export land later. This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §16 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Deterministic export adapter for the pinned render host; golden-frame reference path.

**First built in part:** P00 (spike) then P02. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Divergence from evaluator/Render IR semantics; nondeterministic inputs.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
