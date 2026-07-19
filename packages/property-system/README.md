# property-system

> **Status: WP-02.3 started.** Visual object contracts and reusable transform/opacity/rotation/crop Inspector descriptors are implemented.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §18 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Schema-driven Inspector descriptors, property bindings, multi-edit policies, keyframe integration points.

**First built in part:** P01. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Custom one-off forms per object type.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
