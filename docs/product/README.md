# product docs

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §47–§49 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Product decisions, workflow definitions, beta-workflow specs (§49), metrics definitions (§47).

**First built in part:** P01+. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**UI typography (2026-07-25):** editor Eng/Fa/Arabic chrome uses Fontiran **Modam Pro** — see [`DESIGN.md`](../../DESIGN.md) §4f and decision **D-UI-FONT** in [`plan/DECISIONS.md`](../../plan/DECISIONS.md). License note: [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

**Must not:** Scattering product decisions across chat logs (§48).

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
