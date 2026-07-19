# job-protocol

> **Status: P00.5 Worker protocol spike implemented.** Outbound pairing, capability reports, and a local-only thumbnail lifecycle are verified in memory; durable transport, leases, and process execution hardening land in P01/X01. This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §26.3–26.7, §27.6–27.7 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** VPS/Worker protocol: handshake, job envelopes, leases, events, progress, capability reports.

**First built in part:** P00 (spike) then P01. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Untyped payloads; job types that duplicate provider capability IDs (§26.7).

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
