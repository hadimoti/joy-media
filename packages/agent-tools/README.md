# agent-tools

> **Status: active — deterministic editor tooling is shipped.** This package now holds the plan/execution path behind Joy Code timeline intents, approval/dry-run envelopes, atomic command application, async Worker job adapters, and specialist review helpers. Free-form LLM chat is still outside this package's scope.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §22, §11.7 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Safe editor tools generated from command definitions plus semantic query tools for the agent.

**Landed.** Timeline edit tools, atomic plan execution, approval modes, specialist scaffolds, and Worker-backed async job plumbing all exist under `src/` with tests. The package is no longer a placeholder.

**Boundary.** This package proposes and applies structured edits through the shared command bus. Live model transport, chat UX, and product gating still belong to the editor/app layers.

**Must not:** Tools that bypass the command bus or return unstable entity references.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
