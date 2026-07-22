# M-CPW — Control Plane and Worker E2E

**Status:** in-progress · **Gate to enter:** P00 architecture proofs; WP-11 local preview/export evidence · **Master plan:** §26–§28, §35–§36 Phase 1, §37
**Goal:** turn the existing in-memory control-plane and Worker spikes into one observable, authenticated, local-first workflow: editor → API → paired local Worker → job state/progress → verified result or recoverable interruption.

## Reality audit (2026-07-22)

The VPS foundation is operational, but it is not evidence of this milestone's product workflow. Live, read-only checks found `https://media.joyteam.ir/api/health` returns a healthy control-plane response; `joy-media@api` is active on port 8790; PostgreSQL and the VPS health script pass. The deployed `/opt/joy-media/app` is a build artifact rather than a Git checkout, however, and no `joy-media` Worker unit is installed/running. The current source server exposes only `/health`; `LocalControlPlane` is memory-only and the editor makes no API or Worker requests. The active `joy-admin-api.service` runs a stale shared-password copy at `/opt/joy-admin`, but the tracked `joy-vps` source already has per-user web sessions and feature flags via `accounts_service`; its file hash differs from the active copy. ADR-0016 defines the required signed assertion/JWKS boundary and `joymedia_allowed` extension in that source. Production `/v1` remains disabled until the source change is tested and deployed through its own release workflow. Therefore no pair/lease/progress/cancel/retry/recovery claim is treated as live until this plan verifies it end to end.

## Work packages

- [x] **WP-12.1 — Live audit and evidence reconciliation.** Re-check the deployed API, service state, port ownership, PostgreSQL reachability, and Worker presence without changing VPS state. Reconcile the X01/P01 completion claims with the actual source and service evidence above. **Verified 2026-07-22:** API health succeeds over public TLS; `joy-media@api` is active and port 8790 is listening; the VPS health script reports all checks passing; no Worker service was found. This is infrastructure evidence only, not a user-job E2E proof.
- [ ] **WP-12.2 — Versioned API transport and persistence.** Put the existing project/worker/job semantics behind a versioned HTTP contract with typed request/response validation, authenticated actor resolution at the shared JOY boundary, PostgreSQL-backed state, and cursorable job events. A development-only local test identity must never be deployable on the public endpoint. **Initial transport boundary landed locally:** `createControlPlaneHttpServer` exposes health plus authenticated `/v1` project/Worker/job/lease/completion/event routes through injected authentication; focused HTTP tests cover the lifecycle and prove unauthenticated requests are rejected. It remains in-memory and deliberately has no public identity fallback, so this box is not complete or deployed.
- [ ] **WP-12.3 — Outbound Worker client.** Turn `apps/worker` from a one-shot hello logger into a persistent local process: durable device identity, pair/revoke flow, capability hello, poll/lease/heartbeat, bounded structured logs, cancellation, result verification, and stale-lease rejection. Original media paths remain local/opaque.
- [ ] **WP-12.4 — Editor job surface.** Connect the editor's Jobs panel to the typed API client: safe Worker pairing status, submit a small local thumbnail/proxy job, live progress/event display, cancel/retry controls, and recoverable offline/error states. Do not replace the working browser MP4 export with a VPS render path.
- [ ] **WP-12.5 — Live E2E and interruption gate.** Deploy only through X01 after code review. In a browser, pair a local Worker, submit and complete a fixture job, inspect API/Worker logs and PostgreSQL state, then prove cancel/retry and lease-expiry recovery without loss of the local project. Record exact VPS revision/artifact provenance and restore/rollback evidence.

## Exit criteria

- [ ] The editor can show a connected/disconnected paired Worker without exposing local paths or pairing secrets.
- [ ] A local fixture job travels through authenticated API, persisted queue, local Worker, and verified output with observable progress.
- [ ] Cancellation, retry, and stale-lease recovery are demonstrated in the running editor and recorded in cursorable events.
- [ ] API/Worker restart does not erase project metadata, job state, or auditable events.
- [ ] Live deployment identifies an immutable source revision/artifact and preserves X01 isolation, health, backup, and rollback guarantees.
- [ ] Root typecheck, formatting, and relevant unit/integration/browser checks pass; documented repository-baseline exceptions remain explicit.

## Scope boundaries

- Shared JOY authentication is a required production boundary (DECIDED Q10); this milestone must not ship a header/token shortcut to the public VPS.
- The Worker runs on the creator's machine and initiates its outbound connection. The VPS never receives raw local filesystem paths or original media by default.
- VPS rendering, provider jobs, desktop tray packaging, and a full project-sync product are outside this milestone unless needed solely to exercise the small fixture job.
