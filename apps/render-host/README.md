# render-host

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §14.4, §16, §20.4 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Deterministic headless render page/runtime (pinned Chromium) driven by the Worker for final export and golden tests.

**First built in part:** P00 (spike) then P01. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Wall-clock time, uncontrolled network, unseeded randomness during export.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
