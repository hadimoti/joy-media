# agent-tools

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §22, §11.7 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Safe editor tools generated from command definitions plus semantic query tools for the agent.

**First built in part:** P06. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Tools that bypass the command bus or return unstable entity references.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
