# captions-core

> **Status: WP-03.3 done.** Schemas in project-schema v1; this package owns direction resolution, editing commands, SRT/WebVTT interchange, the JOY template registry, responsive safe-area layout, and karaoke spans into Render IR.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §20.5, §2.7 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Subtitle document model (words/segments/speakers), layout, templates, animation, RTL/Persian rules.

**First built in part:** P03. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Coupling caption data to any specific speech model (§2.7).

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
