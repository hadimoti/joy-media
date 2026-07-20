# plugin-sdk

> **Status: WP-08.1 in progress.** The SDK v1 public surface now freezes API versioning, capability detection, deprecation-window mechanics, and compatibility fixtures. Package installation and execution tiers land in the following work packages.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §24, §2.8 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Versioned plugin API, manifest types, permission model, execution tiers. Contracts exist early (§2.8); public surface waits for P08.

**First built in part:** internal from P01, public P08. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Granting full access as a normal permission; deserializing executable code from project JSON.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
