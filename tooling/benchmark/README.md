# benchmark

> **Status: WP-02.6 first pass implemented.** The runner uses a versioned,
> scaled-down §30.3 fixture in CI; run the full profile only on named reference
> hardware and record its measured timings outside unit-test assertions.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §30, §32.6 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Versioned benchmark fixtures and runners; phase-gate before/after reports.

**First built in part:** P02.

**Must not:** Unversioned datasets; benchmarks on unpinned hardware profiles.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
