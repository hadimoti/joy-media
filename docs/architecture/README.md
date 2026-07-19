# architecture docs

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §0, §50 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Deep-dive architecture notes that supplement the master plan; diagrams, boundary write-ups.

**First built in part:** P01+. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Contradicting the master plan without a version bump there.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
