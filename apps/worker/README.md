# worker

> **Status: WP-12.3 local protocol complete; live deployment pending.** The local Worker persists a device identity and Worker-only session, publishes an outbound pairing offer, claims a session only after owner approval, announces capabilities, renews lease/progress, obeys cancellation, and returns a verified fixture-thumbnail receipt. This is locally tested, not deployed.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §26, §8.4 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Local/GPU worker daemon: probing, proxies, waveforms, FFmpeg, deterministic export, provider execution, resource governor.

**First built in part:** P00 (spike) then P01. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

Set `JOY_MEDIA_API_URL` to run the daemon against the versioned API. On its
first run it prints a high-entropy pairing code; the signed-in owner approves
that code in the Media UI/API before the Worker can claim its token. The code
is retained until its five-minute offer expires, so restarting after approval
claims the same approved offer rather than replacing it. The local
state path defaults to `~/.joy-media/worker-state.json` and can be overridden
with `JOY_MEDIA_WORKER_STATE_PATH`. It contains only the device identity and
revocable Worker session—not a JOY browser login, media path, or project data.
The current fixture job writes a deterministic 1×1 PPM only in its private job
directory; the API receives and independently validates its fixed SHA-256
receipt, never the local path or media bytes.

**Must not:** Editing project state without a validated job/command result; building shell strings from input.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
