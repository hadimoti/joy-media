# audio-core

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §20.6 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Audio graph model, preview contracts, loudness analysis contracts.

**First built in part:** P02 baseline, P05 full. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Destructive audio changes without a visible command.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
