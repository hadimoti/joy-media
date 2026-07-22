# M-MAD — Media Asset Delivery and Playable Derivatives

**Status:** in progress (WP-14.3 locally verified; authorized resolver next) · **Gate to enter:** WP-13 complete · **Master plan:** §13, §27, §39 items 27–39

**Goal:** turn the WP-13 verified derivative receipt into a real, safely
resolvable media asset that can be played in the editor without ever exposing a
local filesystem path, Worker session, pairing code, or original source bytes
to the control plane or browser project state.

## Why this is next

WP-13 intentionally proved only a receipt. A receipt is evidence that a Worker
finished; it is not a browser-playable proxy. The next vertical slice is asset
identity plus a deliberately chosen delivery boundary—not another fixture job
or an unsafe URL pointing at a local disk.

## Accepted delivery boundary

The owner selected the hybrid model in
[`ADR-0017`](../docs/adr/0017-hybrid-opfs-private-object-storage.md):

1. OPFS is the browser-profile-local, high-performance editing cache.
2. Private object storage is an explicit per-project durable replica for
   verified playable derivatives and second-device access.
3. The API brokers owner-scoped, short-lived cloud authority; no public URL,
   direct VPS-to-Worker connection, raw path, Worker credential, pairing code,
   or browser assertion crosses this boundary.

Provider provisioning, bucket credentials, retention, and cost limits remain
an operational gate before production cloud deployment. This decision is not
authorization to upload all original source media or to make sharing public.

## Work packages

- [x] **WP-14.1 — Delivery ADR and threat contract.** Selected the hybrid
      model; define asset/derivative identifiers, resolver authority, revocation,
      integrity checksum, retention, and recovery behavior. Explicitly reject raw
      paths, Worker sessions, pairing codes, browser assertions, and original bytes
      from project/control-plane/API responses. See ADR-0017.
- [x] **WP-14.2 — Durable asset and derivative metadata.** Added owner-scoped,
      PostgreSQL-durable typed asset and local-derivative records, descriptors,
      SHA-256/byte-length integrity metadata, opaque OPFS/private-object
      references, availability state, and explicit per-project sync consent.
      Focused local/HTTP/PostgreSQL-restart coverage rejects paths, cross-owner
      reads, untrusted cloud availability claims, and secret-shaped responses.
      **Not yet verified:** production migration/deployment, actual OPFS writes,
      real derivative bytes, or object-store transport; those remain WP-14.3–.5.
      The catalog persists only metadata appropriate to the selected boundary;
      never copies the entire creative project or physical location.

- [x] **WP-14.3 — Real Worker derivative.** Added `asset.thumbnail`: a
      Worker-local opaque asset registry resolves the source only inside the
      Worker; FFmpeg creates one bounded JPEG thumbnail; FFprobe normalizes its
      descriptor; and the Worker re-reads the output for SHA-256/byte count before
      atomically retaining it under an opaque local reference. The API leases the
      job only to a Worker advertising that opaque asset ID, persists the safe
      receipt across PostgreSQL restart, and preserves the binding through retry.
      Focused real-FFmpeg fixture, cancellation/cleanup, real HTTP, and durable
      restart tests pass. **Not yet verified:** a production Worker registry,
      deployed migration/API, OPFS handoff, object-store sync, or browser playback.
- [ ] **WP-14.4 — Authorized resolver transport (in progress).** The editor now
      has an OPFS-first resolver whose only remote seam is an
      owner-authorized _binary_ transport—not a URL. It validates opaque IDs,
      SHA-256 and byte length before caching or creating a blob URL; removes
      tampered cache entries; makes object-URL cleanup explicit; distinguishes a
      revoked authority; and never gives the transport a raw local path or browser
      assertion. Focused coverage proves local-cache precedence, cache reuse,
      tamper rejection, and revocation. **Still required to close this package:**
      an API-brokered private-object-store adapter/end point that enforces project
      owner + sync consent and is backed by an owner-approved provider/bucket; no
      such provider, credential, or deployment is configured. No public URL,
      implicit cross-origin access, or direct VPS-to-Worker connection is present.
- [ ] **WP-14.5 — Editor asset UX and live gate.** Add an Asset Library and a
      playable derivative affordance with missing/pending/verified/revoked states.
      Browser/VPS proof must import or select a non-fixture asset, produce one real
      derivative, play it through the selected boundary, reload/restart safely, and
      remove/revoke the temporary authority.

## Exit criteria

- [ ] An asset and derivative have stable IDs, verified integrity metadata, and
      safe opaque locations; no project/API response contains an absolute path,
      source bytes, session, or pairing secret.
- [ ] A real bounded derivative is playable in the editor through the chosen
      authorized resolver, while a missing/revoked Worker remains a usable,
      non-crashing state.
- [ ] Cancellation, retry, API/editor restart, resolver revocation, and stale
      derivative invalidation are covered by unit/HTTP/browser evidence.
- [ ] The final browser/VPS gate verifies pixels/media behavior, console and
      network boundaries, and cleanup; known root lint/golden baselines remain
      explicit.

## Scope boundaries

- No public sharing, unrestricted remote URLs, provider media jobs, render farm,
  bulk upload, or object-storage deployment is implied by this milestone.
- Do not weaken WP-12 identity ownership, WP-13 control-plane isolation, or the
  Worker outbound-only direction.
- Do not treat a receipt as an asset or a fixture output as playable media.
