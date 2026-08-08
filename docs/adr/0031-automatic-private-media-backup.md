# ADR-0031: Automatic private media backup and curated cloud visibility

Status: Accepted
Date: 2026-08-08

## Context

ADR-0017 established OPFS as the active editing cache and private object
storage as an optional replica. Production now uses the private ParsPack
object store, and the owner directed JOY Media to back up every imported user
original automatically. The Assets panel also has two distinct catalog views:
the curated cloud library and assets owned by the signed-in user.

Treating every private-object record as curated would expose one user's
automatically backed-up media to every other authenticated JOY user. Deleting
only its metadata would also leave unreferenced content-addressed objects in
ParsPack. The storage, authorization, and deletion contracts therefore need to
change together.

## Decision

1. **OPFS remains the active editing cache.** The browser hashes the selected
   bytes, verifies and writes the original to OPFS, and registers only opaque
   integrity metadata with the API.
2. **Original backup is mandatory for editor imports.** A newly imported
   video, audio file, or image is uploaded through the authenticated API to
   private object storage. The editor does not add it to the timeline until
   registration and cloud upload both succeed. The legacy `asset-sync`
   endpoint accepts `true` only and exists for compatibility; projects cannot
   disable backup.
3. **Personal backups remain owner-readable.** A private-object location is
   not a publication flag. The owner may list the asset across their projects
   and retrieve its verified original from another signed-in browser. Other
   users receive `ASSET_NOT_FOUND`.
4. **Only the curated publisher is cross-account.** Assets owned by the
   dedicated `joy-media-library` service identity may appear in the cloud
   catalog and may be read by any entitled JOY Media user. User-owned assets
   appear only in the user catalog view.
5. **The API remains the byte broker.** Browsers never receive bucket URLs,
   object refs, rclone configuration, or ParsPack credentials. Reads remain
   same-origin, authenticated, integrity-verified, `private`, and `no-store`.
6. **Deletion is reference-counted.** Deleting an asset removes its metadata
   and derivative rows, calculates which private-object refs have no remaining
   asset or derivative reference, and asks the private store to purge only
   those objects. The HTTP response reports purge counts, never refs. A failed
   provider purge is surfaced as an operational cleanup requirement.
7. **Retries are integrity-bound.** If registration succeeded but upload was
   interrupted, selecting the same asset ID may resume only when ID, hash,
   byte length, kind, and MIME type still match. An ID collision with different
   media fails closed.
8. **Upload rollback never deletes deterministic refs blindly.** An object may
   already be referenced by another asset with identical bytes or by an earlier
   successful retry. If metadata attachment fails after the object write, the
   API leaves the object for reference-aware operational cleanup rather than
   risking deletion of valid media.

## Consequences

- Imported originals consume cloud quota by default; quota and retention
  monitoring are operational requirements.
- Cloud unavailability makes a new import fail instead of producing a local
  timeline clip that cannot be recovered on another device.
- Existing metadata-only assets can still be uploaded through the recovery
  action in the user catalog.
- Content-addressed deduplication remains safe because an object is purged only
  after its final metadata reference is deleted.
- A failed metadata attachment can leave an unreferenced object; storage
  reconciliation must compare bucket refs with metadata before purging it.
- The curated cloud catalog and private user backup use the same object-store
  adapter but have separate authorization semantics.

## Supersession

This ADR supersedes ADR-0017 decision points 2, 6, and the sync-consent part of
7, plus Decision Ledger Q3, Q4, and Q18 where they describe cloud storage as
opt-in. ADR-0017's OPFS, opaque-reference, broker, integrity, and no-public-URL
requirements remain in force.

## Validation

Tests must prove automatic cache/register/upload ordering, interrupted-upload
resume, collision rejection, owner-only personal retrieval, curated-library
cross-account retrieval, mandatory sync, reference-counted deletion, provider
purge reporting, rollback safety for shared refs, and the absence of paths,
object refs, or credentials in browser responses.
