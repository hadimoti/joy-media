# docs

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §45.5, §24.8 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Developer and SDK documentation site. Reference docs are generated from contracts (§45.5); guides are written.

**First built in part:** P08. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Hand-maintained API docs that drift from contracts.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
