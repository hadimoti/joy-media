# ADRs

> **Status: active.** ADR-0001 through ADR-0010 are accepted; this README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §41 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Architecture Decision Records. Template in 0000-template.md; required early ADRs listed in §41.1.

**First built in part:** P00. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Changing core invariants without an ADR.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.

Accepted through **ADR-0028** (applying change sets — compound transactions so one Undo reverts a document change and its record together).
