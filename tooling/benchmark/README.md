# benchmark

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §30, §32.6 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Versioned benchmark fixtures and runners; phase-gate before/after reports.

**First built in part:** P02. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Unversioned datasets; benchmarks on unpinned hardware profiles.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
