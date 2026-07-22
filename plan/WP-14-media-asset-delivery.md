# M-MAD — Media Asset Delivery and Playable Derivatives

**Status:** in progress (WP-14.1 accepted; durable metadata next) · **Gate to enter:** WP-13 complete · **Master plan:** §13, §27, §39 items 27–39

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
- [ ] **WP-14.2 — Durable asset and derivative metadata.** Add typed asset,
      media-descriptor, location, and derivative records with opaque references and
      hash-based invalidation. Track OPFS and private-object availability through
      opaque references only; never copy the entire creative project or physical
      location.
- [ ] **WP-14.3 — Real Worker derivative.** Replace the fixture-only output
      with a bounded actual thumbnail/proxy job, ffprobe-normalized descriptor, and
      independently verified output hash/byte count. Handle cancel, retry, Worker
      loss, cleanup, and explicit sync handoff without leaking temporary paths.
- [ ] **WP-14.4 — Authorized resolver transport.** Implement the selected
      OPFS-first/private-object-store resolver and test origin/owner/revocation/
      integrity boundaries. No public URL, implicit cross-origin access, or direct
      VPS-to-Worker connection.
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
