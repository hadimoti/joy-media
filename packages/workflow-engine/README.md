# workflow-engine

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §23 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Deterministic automation graphs: typed nodes/edges, checkpoints, idempotent runs, approval nodes.

**First built in part:** P07. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Depending on free-form agent conversation for production automation (§2.10).

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
