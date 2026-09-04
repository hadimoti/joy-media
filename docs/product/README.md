# product docs

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §47–§49 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Product decisions, workflow definitions, beta-workflow specs (§49), metrics definitions (§47).

**First built in part:** P01+. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**UI typography (2026-09-05):** editor Eng/Fa/Arabic chrome uses pinned, self-hosted Fontsource OFL faces — see [`DESIGN.md`](../../DESIGN.md) §4f and decision **D-UI-FONT** in [`plan/DECISIONS.md`](../../plan/DECISIONS.md). License note: [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

**UI copy policy (2026-07-27):** visible titles and controls stay English;
explainers, guidance, empty states, live status, and placeholders are Persian.
Persian copy is centered and layout-neutral (`lang="fa"`, no forced RTL/LTR)
with technical tokens isolated inline. The visible application header is
**JOY Studio** only; JOY Media remains the product, repository, API, storage,
package, and domain identity. See [`persian-explainer-copy.md`](persian-explainer-copy.md)
and [`DESIGN.md`](../../DESIGN.md) §4d.

**Must not:** Scattering product decisions across chat logs (§48).

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
