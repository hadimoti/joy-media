# media-core

> **Status: P00.6 local-first asset spike implemented.** The trusted local bridge registers selected files as opaque Worker locations and creates local thumbnail/proxy derivatives without exposing originals to project or control-plane records. This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §13 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Asset identity/location model, media descriptors, proxy profiles, relink scoring, conform rules.

**First built in part:** P02. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Using paths/URLs as identity; silent fuzzy relink.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
