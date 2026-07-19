# golden-render

> **Status: scaffolded (WP-00.0)** — contracts land with this package's spike WP. This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §16.6, §32.2 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Golden-frame/golden-audio comparison harness for preview/export parity.

**First built in part:** P00. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Tolerances loosened to make failures pass without an ADR.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
