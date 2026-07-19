# motion-core

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §20.3 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Keyframes, curves, easing, parenting, interpolation.

**First built in part:** P04. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Expressions (deferred, §20.3); wall-clock dependence.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
