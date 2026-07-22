# ADR-0017: Hybrid OPFS editing cache and private object-storage replica

Status: Accepted
Date: 2026-07-22

## Context

WP-14 must turn a verified Worker derivative receipt into a browser-playable
asset without making a local filesystem path, Worker credential, pairing code,
or creative-media byte stream part of the control plane. The owner selected a
combined model: OPFS for high-performance local editing and private object
storage for opt-in cloud backup and access from another owned device. This
refines the local-first, optional-cloud decisions in Q3 and Q4 while preserving
ADR-0008's opaque asset locations and ADR-0009's outbound-only Worker model.

## Decision

1. **OPFS is the active editing cache.** The editor writes browser-imported or
   downloaded playable derivatives into the current browser profile's OPFS and
   resolves them locally first. An OPFS handle, directory name, or browser
   filesystem path is never sent to the API, a Worker, or another device.
2. **Private object storage is the durable, opt-in replica.** A project owner
   explicitly enables sync before the API schedules upload or grants a
   download. Object identifiers are opaque, immutable content-addressed
   references; buckets and objects are private and have no public-read URL.
3. **The API is the cloud authorization broker.** It authenticates the
   audience-scoped JOY assertion, checks project ownership and sync consent,
   then issues a short-lived, operation-scoped upload/download authority. The
   browser assertion, Worker session token, pairing code, and local path never
   go to the object store. The object store never contacts a Worker.
4. **Integrity is content-addressed.** Each replicated object records the
   expected SHA-256 and byte length. The uploader must report both; a receiver
   verifies both before marking a derivative playable. A mismatch is `invalid`,
   not a cache hit or cloud backup.
5. **Metadata describes availability, not device paths.** A derivative may be
   `pending`, `available-local`, `available-cloud`, `evicted`, or `invalid`.
   Metadata contains an opaque asset/derivative ID, immutable content hash,
   byte length, profile, and opaque local/cloud location references only.
6. **WP-14 scope is bounded.** It first replicates verified, bounded playable
   derivatives selected by explicit project sync. Automatic replication of all
   original source media, project collaboration/conflict resolution, public
   sharing, and bulk archival are separate work and must not be implied by a
   successful derivative delivery proof.
7. **Revocation is layered.** Removing sync consent or project access blocks
   new cloud authorities immediately; their short expiry limits already issued
   authorities. It does not silently erase the current browser's local OPFS
   cache. The editor exposes a cache-purge action, and a failed/expired cloud
   resolution remains a usable local/offline state.

## Alternatives considered

- **Local Worker bridge only.** Fast and private but cannot provide the
  requested cloud backup or a second-device path.
- **OPFS only.** Good for a single profile, but browser storage cannot back up
  data or make it available to another device.
- **Object storage only.** Adds upload/download latency and cost to normal
  editing, while needlessly weakening the local-first editing experience.
- **Public object URLs.** Rejected: possession of a URL would become media
  authorization and revocation would be unreliable.

## Consequences

The editor can stay responsive offline using OPFS while opted-in verified
derivatives survive device changes in private storage. The system gains a
provider-neutral storage adapter, quota/retention policy, sync lifecycle, and
explicit cache recovery UX. A concrete provider, bucket, credentials, region,
retention period, and cost/usage limits still require owner operational
approval before any production object-storage deployment.

### Approved initial provider

The owner approved the existing ParsPack S3-compatible `c212734` bucket for
the initial private replica, using only the isolated
`sweden-backups/joy-media/` prefix. Existing VPS backup content under
`sweden-backups/daily/` and `sweden-backups/configs/` is not JOY Media data and
is outside its retention policy. The root-owned rclone credential remains on
the VPS; it is never committed, copied into browser state, or returned by the
API. On 2026-07-22, a one-object write → read/content-equality → deletion
probe passed in the JOY Media prefix and left it empty. This approves the
provider for API-broker implementation, but does not yet configure a JOY Media
API/Worker credential or upload any media.

## Validation and rollback

WP-14 must prove that a derivative is playable from OPFS, then from an
owner-scoped private-cloud retrieval after an editor reload. Tests must reject
cross-owner access, expired/revoked authority, public URL assumptions, hash or
byte-count mismatch, raw local paths, Worker/session secrets, and browser
assertion forwarding. Rollback disables issuing new cloud authorities and
leaves already cached OPFS derivatives usable; it does not delete user media.

## Related contracts/tests

ADR-0008 · ADR-0009 · ADR-0016 · `plan/WP-14-media-asset-delivery.md` ·
master plan §13, §27, §39 items 27–39.
