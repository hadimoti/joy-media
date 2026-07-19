# html-scene-runtime

> **Status: P04 complete.** Versioned manifests, typed variables, asset/font resolution, permission-derived CSP, deterministic compiler diagnostics, `joy-scene`, a bridged `allow-scripts` preview, and a configured Chromium→RGBA capture driver now back four first-party scene templates with pixel goldens and export parity. Browser/process isolation remains the production boundary described in ADR-0006.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §2.3, §20.4 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Sandboxed scene SDK: deterministic clock, typed variables, asset/font resolvers, message protocol.

**First built in part:** P00 (spike) then P04. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Uncontrolled network/wall-clock/random; direct DOM access to the host app.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
