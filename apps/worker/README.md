# worker

> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §26, §8.4 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Local/GPU worker daemon: probing, proxies, waveforms, FFmpeg, deterministic export, provider execution, resource governor.

**First built in part:** P00 (spike) then P01. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Editing project state without a validated job/command result; building shell strings from input.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
