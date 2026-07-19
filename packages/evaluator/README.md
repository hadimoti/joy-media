# evaluator

> **Status: scaffolded (WP-00.0)** — contracts land with this package's spike WP. This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §14 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Time-based document evaluation into Render IR. Pure: no Pixi, DOM, FFmpeg, providers, or DB.

**Status:** P01.3 adds active-interval queries and static property evaluation. The package remains pure; renderer/host objects are excluded.

**Must not:** Any I/O or renderer imports.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
