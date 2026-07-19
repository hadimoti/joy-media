# project-schema

> **Status: scaffolded (WP-00.0)** — contracts land with this package's spike WP. This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §9.1, §10, §12.5 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Versioned creative document schema and migrations. The innermost package.

**First built in part:** P00 (spike) then P01. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Importing React, PixiJS, Dockview, FFmpeg wrappers, DB clients, provider SDKs, or anything from apps/*.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
