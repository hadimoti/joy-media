# security docs

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §29 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Threat model details, sandbox policies, consent/licensing inventories, incident runbooks.

**First built in part:** P01+. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Storing secrets or real keys in docs.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
