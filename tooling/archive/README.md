# `@joy-media/archive`

Encrypted, checksummed hosted/browser data export and import boundary for the JOY Media
desktop migration (wave 6 — archive/cutover guards). Implements the locked owner decision:
"Archive existing hosted/browser projects and start a fresh desktop workspace. Provide a
reversible, encrypted, checksummed archive export and a clear import boundary; do not silently
migrate or delete customer data."

## Modules

- `manifest.ts` — `buildManifest`/`verifyManifest`: a SHA-256 per entry plus a top-level
  `manifestChecksum` covering the sorted list of entries, so a manifest can be checked for
  internal tampering independently of re-hashing every entry.
- `encryption.ts` — `generateArchiveKey`/`encryptArchive`/`decryptArchive`: AES-256-GCM. A key
  is generated fresh per export and returned to the caller — never derived from anything
  server-controlled, never persisted by this package.
- `archive-export.ts` — `exportOwnerArchive(ownerId, source)`: builds one owner's project
  documents + media assets into a checksummed, encrypted archive. `ProjectArchiveSource` is the
  seam a real Postgres-backed data source plugs into; this package never opens a database
  connection itself.
- `archive-import.ts` — `importOwnerArchive(encrypted, keyBase64)`: the "clear import
  boundary" — decrypts, then verifies every checksum before returning anything. Fails closed
  (throws `ArchiveImportError`/`ArchiveEncryptionError`) on a wrong key, tampered ciphertext, or
  a manifest that doesn't match its entries.
- `integrity-verification.ts` — `verifyNoDataLoss(manifest, expectedProjectCount)`: compares
  the exported manifest's project count against an independently-obtained count from the live
  source, catching a source query that silently dropped rows.

## What is deliberately not here

No HTTP route, CLI, or `ProjectArchiveSource` implementation backed by the real
`project-document-store.ts`/`private-object-store.ts` — wiring this package to production data
is left for a follow-up pass so this worktree never opens a database connection to customer
data. See `docs/joy-media-final-migration-backup-restore-runbook.md` for the operational
procedure this package is designed to support, and
`docs/joy-media-final-migration-progress.md`'s wave 6 entry for the exact list of what remains.

## Commands

```text
pnpm --filter @joy-media/archive test
pnpm --filter @joy-media/archive build
```
