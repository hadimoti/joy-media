# M-CPW — Control Plane and Worker E2E

**Status:** done · **Gate to enter:** P00 architecture proofs; WP-11 local preview/export evidence · **Master plan:** §26–§28, §35–§36 Phase 1, §37
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

The signed-in creator gate was completed on 2026-07-22 after the owner enabled
JOY Media access for the known Hadi / @PersiaReborn account. The browser used
its cookie-backed JOY assertion to approve a fresh outbound Windows Worker,
create the initial control-plane project, queue a fixture, cancel a queued
retry, retry it, and show the Worker-completed 14-byte receipt. The temporary
Worker was revoked from the same UI afterwards. No browser token, password,
pairing code, local path, or media bytes were exposed in the evidence.

## Work packages

- [x] **WP-12.1 — Live audit and evidence reconciliation.** Re-check the deployed API, service state, port ownership, PostgreSQL reachability, and Worker presence without changing VPS state. Reconcile the X01/P01 completion claims with the actual source and service evidence above. **Verified 2026-07-22:** API health succeeds over public TLS; `joy-media@api` is active and port 8790 is listening; the VPS health script reports all checks passing; no Worker service was found. This is infrastructure evidence only, not a user-job E2E proof.
- [x] **WP-12.2 — Versioned API transport and persistence.** The public API verifies only RS256 JOY assertions through the configured JWKS, issuer, audience, entitlement, signature, and bounded lifetime; there is no public development identity fallback. PostgreSQL tables/indexes persist projects, pairings, leases, progress, cancellations, retries, stale re-leases, completions, and events. The JOY issuer/JWKS source (`joy-vps` `305e9b6`) is deployed with a VPS-only private key and default-deny entitlement. **Final browser evidence 2026-07-22:** the owner-enabled Hadi / @PersiaReborn session used the cookie-backed assertion to approve a Worker and create/operate its own persisted project; no manually issued browser assertion or fallback was used.
- [x] **WP-12.3 — Outbound Worker client.** A real Windows Worker persisted its device/pending pairing outside the project, kept its pairing code across restart, claimed its outbound Worker-only session, announced capabilities, polled/leased/heartbeated, honored cancellation, retried, and completed the private 1×1 PPM fixture. PostgreSQL recorded the live progress and stale-lease recovery; the server independently accepted only the expected SHA-256/byte receipt, never a local path or media bytes. Owner revocation now has an authenticated `/v1/workers/:id/revoke` route, the Jobs UI exposes it, and a freshly paired live Worker-only session was revoked then rejected by the API with HTTP 401. The original temporary Worker state retained only device identity at final inspection; its usable session was revoked. No VPS Worker service was installed: this proof is an actual local process, as required by the local-first design.
- [x] **WP-12.4 — Editor job surface.** The deployed Jobs panel obtains a short-lived assertion only in browser memory, sends it only to same-origin `/api`, displays safe Worker status/capabilities, supports pair/revoke, queues `fixture.thumbnail`, polls state/progress, and offers cancel/retry/offline states. **Final browser evidence 2026-07-22:** the entitled Hadi / @PersiaReborn session displayed the paired Worker and its safe capability, queued a fixture, observed the completed verified receipt, retried it while the Worker was offline, cancelled that queued retry, retried it again after the Worker restarted, and revoked the temporary Worker. Browser console warnings/errors were empty.
- [x] **WP-12.5 — Live E2E and interruption gate.** Deployment smoke is real for the Worker/API/PostgreSQL path: fixture completion, progress, cancel → retry, stale re-lease, receipt validation, and Worker-session revocation all ran against the VPS. The browser E2E above closes the entitlement/UI gate. **Rollback drill 2026-07-22:** API and web symlinks changed from immutable `59f1cd2` to `36e7489`; `joy-media@api` restarted and its control-plane health succeeded; both symlinks were restored to `59f1cd2`, restarted, and health succeeded again. The signed-in Jobs panel then still showed the persisted revoked Worker and verified completed receipt. The retained database backup and immutable releases remain in place.

## Exit criteria

- [x] The editor can show a connected/disconnected paired Worker without exposing local paths or pairing secrets. **Signed-in browser proof completed; the temporary Worker was revoked after verification.**
- [x] A local fixture job travels through authenticated API, persisted queue, local Worker, and verified output with observable progress.
- [x] Cancellation, retry, and stale-lease recovery are demonstrated in the running editor and recorded in cursorable events. **The browser cancelled and retried a queued job; prior live API/Worker smoke recorded progress and stale re-lease.**
- [x] API/Worker restart does not erase project metadata, job state, or auditable events.
- [x] Live deployment identifies an immutable source revision/artifact and preserves X01 isolation, health, backup, and rollback guarantees. **The 36e7489 → 59f1cd2 API/web rollback-and-restore drill passed with control-plane health at both ends.**
- [x] Root typecheck, formatting, and relevant unit/integration/browser checks pass; documented repository-baseline exceptions remain explicit. **Final 2026-07-22 run:** typecheck and formatting pass; 1,117/1,118 tests pass, with only the documented cross-Chromium golden mismatch; lint has exactly the eight accepted plugin-sdk/bin findings duplicated by the foreign worktree. The command is therefore not literally green, but no new gate regression remains.

## Scope boundaries

- Shared JOY authentication is a required production boundary (DECIDED Q10); this milestone must not ship a header/token shortcut to the public VPS.
- The Worker runs on the creator's machine and initiates its outbound connection. The VPS never receives raw local filesystem paths or original media by default.
- VPS rendering, provider jobs, desktop tray packaging, and a full project-sync product are outside this milestone unless needed solely to exercise the small fixture job.
