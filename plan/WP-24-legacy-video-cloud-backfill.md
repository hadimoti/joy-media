# WP-24 - Legacy personal video cloud backfill

**Status:** planned 2026-08-08

## Goal

Recover the exact original bytes for the one legacy personal video record and attach
them to that existing asset through JOY Media's authenticated private-cloud upload
path. Preserve the asset ID, project ownership, metadata, and references. Finish with
all personal media backed by ParsPack and with no storage-integrity regression.

This is a recovery task, not a migration of bytes that are currently available on the
server. The record is metadata-only because its original bytes are absent server-side.
All newly imported media already requires automatic private-cloud backup under
[ADR-0031](../docs/adr/0031-automatic-private-media-backup.md).

## Current evidence

| Check                                | Known state                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| Personal images                      | 2 of 2 cloud-backed                                                                   |
| Personal videos                      | 0 of 1 cloud-backed                                                                   |
| Legacy video metadata size           | 55,159,596 bytes                                                                      |
| Legacy video private-object location | Absent                                                                                |
| New editor imports                   | Mandatory automatic private-cloud backup                                              |
| Reconciled media namespace           | Exact DB-to-bucket equality; no extra, missing, malformed, or size-mismatched objects |

Do not copy private asset IDs, object refs, account identifiers, or credentials into
this document, commits, terminal transcripts, or issue comments.

## Safety rules

- Never invent bytes, a digest, a location, or a successful-backup status.
- Never add a `private-object` location directly in PostgreSQL.
- Never upload a different file under the legacy asset's metadata.
- Never delete or replace the legacy record without a project/reference audit and the
  owner's explicit approval.
- Keep the storage reconciliation exact. A successful content-addressed upload does
  not necessarily increase the bucket object count if identical content already exists.
- Take a fresh database backup and sync it off-site before any production mutation.

## Recovery sequence

### 1. Preflight

- [ ] Confirm `/opt/joy-media/repo` is clean and `main`, `origin/main`, and
      `vps-local/main` agree.
- [ ] Confirm the deployed API and editor releases, public health, and service health.
- [ ] Create and verify a fresh compressed PostgreSQL backup, then sync it off-site.
- [ ] Re-run the aggregate query and confirm there is exactly one personal video with
      no `private-object` location.
- [ ] Capture the current DB private-ref manifest and ParsPack media-prefix manifest,
      including counts, total bytes, and sorted ref-set digests.
- [ ] Confirm the legacy row's registered SHA-256, byte length, MIME type, project, and
      owner without printing those values into tracked files.

Stop if the preflight finds more than one unbacked personal asset, ownership ambiguity,
or any DB/bucket divergence. Investigate that as a separate incident first.

### 2. Try the existing browser recovery path first

Use the owner's signed-in browser profile that originally imported the video:

1. Open the Media panel in personal-assets mode and select Video.
2. Locate the sole legacy video.
3. If its cloud-backup action is visible, trigger it once and wait for completion.
4. Reload the editor and verify the asset remains in the personal Video view, reports a
   cloud original, and can retrieve/play the original through JOY Media.

The button is intentionally rendered only when
[`OpfsOriginalAssetCache.get`](../apps/editor-web/src/opfs-original-asset-cache.ts)
finds the asset's original in this browser profile. It calls
[`ControlPlaneClient.uploadAssetOriginal`](../apps/editor-web/src/control-plane-client.ts),
which uses the existing owner-authorized original-upload endpoint.

### 3. Re-supply the exact original when OPFS is empty

If the original browser cache is unavailable, ask the owner to locate and select the
original source file. Before sending any bytes:

- compute SHA-256 and byte length client-side;
- require both values to exactly match the registered asset metadata;
- require a MIME type whose top-level kind is `video`;
- show a clear mismatch result and make no network mutation when validation fails.

If the bytes match, reuse `uploadAssetOriginal(projectId, asset, file)`. Do not create a
parallel API route or a second asset. The server route in
[`apps/api/src/http-server.ts`](../apps/api/src/http-server.ts) independently enforces
owner access, media kind, declared metadata, body length, and SHA-256 before storing the
content-addressed object and attaching the private location.

First test whether the current import flow can repopulate OPFS for this exact asset
without registering a duplicate. If it cannot, add the smallest explicit `Locate
original` action for an unbacked owner asset. Keep it unavailable for curated cloud
assets and already-backed assets.

### 4. Leave an honest residual when bytes cannot be recovered

If no candidate has the exact registered SHA-256 and byte length:

- leave the legacy record metadata-only;
- do not claim the item is backed up or repaired;
- record that exact-byte recovery remains blocked on the unavailable original;
- keep mandatory cloud backup unchanged for every new upload.

A different video may be imported as a new, automatically backed asset only as an
explicit owner action. It must never be silently substituted for this record. Deleting
the metadata-only record is a separate decision and requires an explicit reference
audit and owner approval.

## Implementation checklist

- [ ] Exercise the existing OPFS-backed cloud action before changing code.
- [ ] If code is needed, expose a focused file-picker action only for an owner asset
      where `cloudBacked === false` and the OPFS original is missing.
- [ ] Validate candidate bytes locally before invoking the existing upload client.
- [ ] Reuse the current authenticated `/original` endpoint; add no direct bucket path.
- [ ] Keep retries idempotent and avoid background retry loops when no original exists.
- [ ] Provide accessible progress, success, mismatch, and failure states.
- [ ] Add focused tests for any changed behavior.
- [ ] Commit, push to both remotes, deploy immutable API/editor releases only if code
      changed, and update GBrain with the verified outcome.

## Required tests

- [ ] Exact OPFS original uploads successfully and the refreshed asset is cloud-backed.
- [ ] Missing OPFS original performs no upload and does not mutate metadata.
- [ ] Re-supplied exact file succeeds through the existing endpoint.
- [ ] Wrong SHA-256 or byte length is rejected before upload and by the API.
- [ ] Wrong media kind and wrong owner are rejected by the API.
- [ ] Retrying an exact successful upload is safe and does not create a divergent ref.
- [ ] A full browser reload can retrieve and play the repaired original.
- [ ] Personal mode still shows 2 images and 1 video; curated cloud mode remains isolated
      from personal assets.
- [ ] Post-change DB and bucket manifests have exact ref and byte-size equality, with no
      extras, missing objects, malformed refs, or size mismatches.
- [ ] Public health, API health, relevant service logs, and browser console are clean.

## Acceptance criteria

WP-24 is complete only when all of the following are true:

- the existing legacy video record has a verified `private-object` location;
- all three personal assets report `cloudBacked === true`;
- downloaded bytes exactly match the registered SHA-256 and 55,159,596-byte length;
- the video is playable after a full editor reload through an authorized JOY Media
  request, without exposing a provider URL;
- the DB and ParsPack media namespace reconcile exactly after the operation;
- no project, asset, derivative, or curated-cloud references were lost or leaked;
- the change and verification evidence are committed, pushed, deployed if necessary,
  and reflected in `STATE.md` and GBrain.

If the exact original bytes are unavailable, WP-24 remains honestly blocked and none of
the success criteria may be checked.

## Suggested next-session prompt

```text
Execute plan/WP-24-legacy-video-cloud-backfill.md. Attempt the existing OPFS
backup path first. Do not mutate PostgreSQL or ParsPack unless the supplied
original exactly matches the legacy asset's registered SHA-256 and byte length.
Stop and document the residual if the exact bytes are unavailable.
```

## Related

- [ADR-0031: Automatic private media backup](../docs/adr/0031-automatic-private-media-backup.md)
- [ADR-0017: Hybrid OPFS/private-object storage](../docs/adr/0017-hybrid-opfs-private-object-storage.md)
- [ADR-0008: Asset identity and opaque locations](../docs/adr/0008-asset-identity-and-opaque-locations.md)
- [`STATE.md`](../STATE.md), current storage reconciliation and legacy residual
