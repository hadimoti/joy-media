# desktop

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §7.1, §8.4 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Thin desktop shell (Tauri or equivalent): durable FS permissions, secret storage, Worker lifecycle, signed updates. Creative logic stays in shared packages.

**First built in part:** P02. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Becoming thick — no creative logic in the shell.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
