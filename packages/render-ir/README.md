# render-ir

> **Status: minimal frame IR implemented (WP-00.3)** — an evaluated, renderer-neutral frame contract backs the preview/export parity spike. This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §14.2 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Ephemeral, versioned renderer-independent scene description shared by preview and export.

**First built in part:** P00 (spike) then P01. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Renderer-specific fields; being persisted as project state.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
