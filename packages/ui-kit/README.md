# ui-kit

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §17, §33 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** JOY visual language and accessible primitives (theme, density, focus, RTL-ready controls).

**First built in part:** P01. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Creative-document knowledge; panel-specific logic.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
