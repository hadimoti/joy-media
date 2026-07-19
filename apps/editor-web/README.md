# editor-web

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §6.1, §8.1, §17 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** React/Vite editor application: workspace, timeline interaction, Inspector, preview controls, command dispatch, job monitoring.

**First built in part:** P01. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Direct database writes, model-specific logic, trusted arbitrary plugin code, putting the project document into React state.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
