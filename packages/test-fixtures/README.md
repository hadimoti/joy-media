# test-fixtures

> **Status: spike builders implemented (WP-00.2)** — reusable P00 spike-project and clip builders support command/evaluator tests. This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §32.2, §30.3 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Golden projects, redistributable media fixtures, plugin/provider fixtures, benchmark datasets.

**First built in part:** P00 onward. Redistributable media, plugin/provider fixtures, and benchmark datasets land with their respective spikes.

**Must not:** Copyrighted/non-redistributable media; production user data.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
