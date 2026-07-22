# M-MAD — Media Asset Delivery and Playable Derivatives

**Status:** in progress (delivery decision required before implementation) · **Gate to enter:** WP-13 complete · **Master plan:** §13, §27, §39 items 27–39

**Goal:** turn the WP-13 verified derivative receipt into a real, safely
resolvable media asset that can be played in the editor without ever exposing a
local filesystem path, Worker session, pairing code, or original source bytes
to the control plane or browser project state.

## Why this is next

WP-13 intentionally proved only a receipt. A receipt is evidence that a Worker
finished; it is not a browser-playable proxy. The next vertical slice is asset
identity plus a deliberately chosen delivery boundary—not another fixture job
or an unsafe URL pointing at a local disk.

## Decision gate — required before WP-14.2

Choose one delivery model and record it in a new ADR before writing transport
or storage code:

1. **Local Worker bridge (recommended for the local-first MVP).** A
   permission-scoped localhost/desktop bridge resolves opaque Worker asset IDs
   and streams a derivative only to the local editor. Requires strict origin,
   pairing/session, loopback, and revocation tests; no VPS media bytes.
2. **Browser/OPFS asset store.** Browser-selected source/derivative data lives
   under browser permission and OPFS handles; a Worker may create metadata but
   cannot become a raw-path resolver. Best for browser-only imports, but needs
   quota/recovery and background-processing limits addressed.
3. **Private object storage.** Worker uploads a derivative to a dedicated
   private store; the API grants owner-scoped, short-lived retrieval. Requires
   storage lifecycle, upload integrity, cost/retention, and additional VPS
   operational approval.

The default planning assumption is option 1 only; it is **not** an
authorization to implement it until the owner selects it.

## Work packages

- [ ] **WP-14.1 — Delivery ADR and threat contract.** Select the delivery
      model; define asset/derivative identifiers, resolver authority, revocation,
      integrity checksum, retention, and recovery behavior. Explicitly reject raw
      paths, Worker sessions, pairing codes, browser assertions, and original bytes
      from project/control-plane/API responses.
- [ ] **WP-14.2 — Durable asset and derivative metadata.** Add typed asset,
      media-descriptor, location, and derivative records with opaque references and
      hash-based invalidation. Persist only metadata appropriate to the selected
      boundary; never copy the entire creative project or physical location.
- [ ] **WP-14.3 — Real Worker derivative.** Replace the fixture-only output
      with a bounded actual thumbnail/proxy job, ffprobe-normalized descriptor, and
      independently verified output hash/byte count. Handle cancel, retry, Worker
      loss, and cleanup without leaking temporary paths.
- [ ] **WP-14.4 — Authorized resolver transport.** Implement the selected
      local/OPFS/object-store resolver and test origin/owner/revocation/integrity
      boundaries. No public URL, implicit cross-origin access, or direct VPS-to-
      Worker connection.
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
