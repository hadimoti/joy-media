# first-party plugins

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §9.2, §24 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Built-in features exercising public-like extension contracts so the SDK stays honest (§9.2).

**First built in part:** P04+. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Privileges that are not explicitly declared.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
