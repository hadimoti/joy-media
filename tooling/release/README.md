# release

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §32.7, §35.4 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Build pinning, signing, packaging, release-gate checks.

**First built in part:** P02+. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Shipping when §32.7 release gates fail.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
