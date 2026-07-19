# provider-sdk

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §21 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** AI/media capability contracts: manifests, capability requests, normalized results, provenance.

**First built in part:** P03 minimum, P05 full. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Provider-specific fields leaking into core schemas (§2.12); providers mutating projects (§21.9).

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
