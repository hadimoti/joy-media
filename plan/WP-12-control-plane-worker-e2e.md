# M-CPW — Control Plane and Worker E2E

**Status:** in-progress · **Gate to enter:** P00 architecture proofs; WP-11 local preview/export evidence · **Master plan:** §26–§28, §35–§36 Phase 1, §37
**Goal:** turn the existing in-memory control-plane and Worker spikes into one observable, authenticated, local-first workflow: editor → API → paired local Worker → job state/progress → verified result or recoverable interruption.

## Reality audit (2026-07-22)

The production control plane is now deployed on the VPS: public TLS health,
JWKS, versioned API routing, PostgreSQL migration, and the static Jobs panel
all respond. The API and editor artifact are immutable releases; the source
checkout is at the current pushed revision. A real Windows Worker process
paired outbound, announced `asset.thumbnail`, completed a deterministic
fixture through PostgreSQL, then proved cancel → retry and lease-expiry
recovery with cursorable events and receipt verification. The paired Worker
session was subsequently revoked and rejected by the Worker API.

This is deliberately not treated as a signed-in-browser product E2E yet. The
live owner calls used a short-lived, operator-issued RS256 deployment-smoke
assertion. The public JOY issuer endpoint itself correctly requires the
user's cookie session and entitlement, and the available browser has neither.
No unknown user's access was enabled merely to close a checkbox. A creator
must sign into an entitled JOY account to prove the browser assertion,
pairing, submission, cancellation, retry, and recovery UI actions.

## Work packages

- [x] **WP-12.1 — Live audit and evidence reconciliation.** Re-check the deployed API, service state, port ownership, PostgreSQL reachability, and Worker presence without changing VPS state. Reconcile the X01/P01 completion claims with the actual source and service evidence above. **Verified 2026-07-22:** API health succeeds over public TLS; `joy-media@api` is active and port 8790 is listening; the VPS health script reports all checks passing; no Worker service was found. This is infrastructure evidence only, not a user-job E2E proof.
- [ ] **WP-12.2 — Versioned API transport and persistence.** The public API now verifies only RS256 JOY assertions through the configured JWKS, issuer, audience, entitlement, signature, and bounded lifetime; there is no public development identity fallback. PostgreSQL tables/indexes migrated successfully and live owner/Worker deployment-smoke calls persisted projects, pairings, leases, progress, cancellations, retries, stale re-leases, completions, and events. The JOY issuer/JWKS source (`joy-vps` `305e9b6`) is deployed with a VPS-only private key and default-deny entitlement. **Open evidence:** the public cookie-session assertion issuance has not been exercised by an actual entitled JOY user in the browser.
- [x] **WP-12.3 — Outbound Worker client.** A real Windows Worker persisted its device/pending pairing outside the project, kept its pairing code across restart, claimed its outbound Worker-only session, announced capabilities, polled/leased/heartbeated, honored cancellation, retried, and completed the private 1×1 PPM fixture. PostgreSQL recorded the live progress and stale-lease recovery; the server independently accepted only the expected SHA-256/byte receipt, never a local path or media bytes. Owner revocation now has an authenticated `/v1/workers/:id/revoke` route, the Jobs UI exposes it, and a freshly paired live Worker-only session was revoked then rejected by the API with HTTP 401. The original temporary Worker state retained only device identity at final inspection; its usable session was revoked. No VPS Worker service was installed: this proof is an actual local process, as required by the local-first design.
- [ ] **WP-12.4 — Editor job surface.** The deployed Jobs panel obtains a short-lived assertion only in browser memory, sends it only to same-origin `/api`, displays safe Worker status/capabilities, supports pair/revoke, queues `fixture.thumbnail`, polls state/progress, and offers cancel/retry/offline states. The public editor DOM loaded with no browser console warnings/errors; an unauthenticated session visibly receives the graceful `Offline or not signed in: unauthorized` state. **Open evidence:** the interactive actions still need a real entitled browser session; they were not simulated or bypassed.
- [ ] **WP-12.5 — Live E2E and interruption gate.** Deployment smoke is real for the Worker/API/PostgreSQL path: fixture completion, progress, cancel → retry, stale re-lease, receipt validation, and Worker-session revocation all ran against the VPS. Backup `joymedia-20260722-110935.sql.gz` was made before migration and synced off-host; prior immutable releases are preserved and rollback is documented as a symlink switch. **Open gate:** signed-in browser interaction and an executed rollback drill remain unverified, so this part cannot be honestly closed.

## Exit criteria

- [ ] The editor can show a connected/disconnected paired Worker without exposing local paths or pairing secrets. **Rendered and safely offline-verified; signed-in interaction remains open.**
- [x] A local fixture job travels through authenticated API, persisted queue, local Worker, and verified output with observable progress.
- [ ] Cancellation, retry, and stale-lease recovery are demonstrated in the running editor and recorded in cursorable events. **Recorded through the live API/Worker; signed-in editor operation remains open.**
- [x] API/Worker restart does not erase project metadata, job state, or auditable events.
- [ ] Live deployment identifies an immutable source revision/artifact and preserves X01 isolation, health, backup, and rollback guarantees. **Source/artifact/health/backup are evidenced; an actual rollback drill is open.**
- [ ] Root typecheck, formatting, and relevant unit/integration/browser checks pass; documented repository-baseline exceptions remain explicit. **Run recorded in the final gate review.**

## Scope boundaries

- Shared JOY authentication is a required production boundary (DECIDED Q10); this milestone must not ship a header/token shortcut to the public VPS.
- The Worker runs on the creator's machine and initiates its outbound connection. The VPS never receives raw local filesystem paths or original media by default.
- VPS rendering, provider jobs, desktop tray packaging, and a full project-sync product are outside this milestone unless needed solely to exercise the small fixture job.
