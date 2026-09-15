# JOY Media final migration — backup/restore, archive, and rollback runbook (wave 6)

**Status: runbook only. No command in this document has been run against the live VPS from
this worktree.** This is written for Codex/the owner to execute during the actual cutover;
this background session has no VPS access and the lead brief explicitly reserves deploy/restart
actions for Codex after independent checks.

Locked owner decision this runbook exists to satisfy: **"Archive existing hosted/browser
projects and start a fresh desktop workspace. Provide a reversible, encrypted, checksummed
archive export and a clear import boundary; do not silently migrate or delete customer data."**
Lead brief: **"Do not delete releases or databases."**

## 1. What already exists (do not duplicate)

Release rollback is already a mature, tested mechanism — see `deploy/README.md`,
`deploy/joy-media-rollback.sh`, and `deploy/joy-media-rollback.test.sh`. It performs an atomic
pair of symlink swaps (`current-api`, `/opt/joy-media/web`) back to a previously verified
immutable release, defaults to `--dry-run`, and rewrites only the `JOY_MEDIA_RELEASE_*` keys in
`/etc/joy-media/api.env` before `systemctl restart joy-media@api`. **Use it as-is** for any
release-level rollback during this migration's cutover; this runbook does not replace it.

What did **not** already exist before this wave: a documented database backup/restore
procedure, and any per-owner customer-data export. This runbook and `tooling/archive` (this
wave's new package) fill those two gaps.

## 2. Database backup

Before any cutover step that touches schema (a new migration applying), retires a hosted route
class, or narrows the Nginx boundary, take a fresh logical backup of the `joymedia` Postgres
database:

```bash
# On the VPS, as a role with read access to the joymedia database:
pg_dump --format=custom --file="/opt/joy-media/backups/joymedia-$(date -u +%Y%m%dT%H%M%SZ).dump" joymedia
sha256sum "/opt/joy-media/backups/joymedia-"*.dump > "/opt/joy-media/backups/joymedia-$(date -u +%Y%m%dT%H%M%SZ).sha256"
```

- Use `--format=custom` (not plain SQL) so `pg_restore` can do a selective or parallel restore
  if only part of the database needs recovering.
- Record the SHA-256 alongside the dump — the same "checksum everything durable" discipline
  this migration applies to archive exports (§4) and release identities
  (`joy-media-release-identity.sh`).
- **Retention:** keep at minimum the backup taken immediately before each migration wave's
  schema change (`007-account-devices-subscriptions-entitlements`, `008-usdc-invoices`, and any
  future migration) until that wave's acceptance is confirmed. Never delete a backup as part of
  routine cleanup without an explicit, separate decision — "do not delete releases or
  databases" extends naturally to their backups.

## 3. Database restore (verification and, if ever needed, real recovery)

**Rehearse this against a scratch database first — never restore directly onto `joymedia`
without a fresh backup of its current state taken immediately beforehand (§2).**

```bash
# Rehearsal, into a throwaway database:
createdb joymedia_restore_check
pg_restore --format=custom --dbname=joymedia_restore_check "/opt/joy-media/backups/joymedia-<timestamp>.dump"
# Spot-check row counts against what the backup's source deployment reported at backup time.
dropdb joymedia_restore_check
```

A real restore (only after a genuine data-loss incident, and only with explicit owner/Codex
sign-off) follows the same `pg_restore` invocation against `joymedia` itself, preceded by
stopping `joy-media@api` (`systemctl stop joy-media@api`) so nothing writes during the restore,
and followed by the same health-check sequence `deploy/README.md`'s release order already
describes (`/live`, `/ready`, `/health/ready`, OTP login round trip) before restarting traffic.

## 4. Per-owner archive export (`tooling/archive`)

New this wave. A database backup protects against operational data loss; it does **not** give
an individual customer a reversible, encrypted copy of _their own_ data they can independently
verify and later import into the desktop app — that is the locked decision's actual ask, and
what `tooling/archive` implements:

- `exportOwnerArchive(ownerId, source)` — builds a checksummed manifest
  (`tooling/archive/src/manifest.ts`) of every project document and media asset for one owner,
  then encrypts the whole bundle with a freshly generated AES-256-GCM key
  (`tooling/archive/src/encryption.ts`). The key is returned to the caller exactly once — it is
  never persisted by this package.
- `importOwnerArchive(encrypted, keyBase64)` — the "clear import boundary": decrypts, then
  verifies **every** checksum before returning anything, so a corrupted or tampered archive
  fails closed rather than partially importing.
- `verifyNoDataLoss(manifest, expectedProjectCount)` — compares the exported manifest's project
  count against an independently-obtained count from the live source (never from the archive
  itself), catching a source query that silently dropped rows.

**What is not built yet** (see `docs/joy-media-final-migration-progress.md`'s wave 6 entry for
the full list): a `ProjectArchiveSource` backed by the real Postgres
`project-document-store.ts`/`private-object-store.ts`, an HTTP route or CLI to trigger an
export for a real owner, and any desktop-side import wiring. `tooling/archive` is the tested,
reusable core; wiring it to production data is deliberately left for a follow-up pass so this
worktree never touches a live database.

**Before retiring any hosted project/media route** (wave 4's `hosted-route-retirement.ts`
flags, or wave 6's `legacy-editor-retirement.ts` flag), every affected owner must have a
successfully verified archive export, per the "do not silently migrate or delete customer data"
decision. A cutover checklist:

1. For each owner with hosted projects: `exportOwnerArchive` → `verifyNoDataLoss` against the
   live project count → hand the owner their encrypted archive + key (exact delivery mechanism
   — e.g. a one-time download link plus a displayed recovery key — is a product decision not
   made in this migration yet).
2. Confirm the owner can `importOwnerArchive` it back (round-trip check) before their hosted
   access is narrowed.
3. Only then enable the relevant retirement flag(s).

## 5. No-data-loss verification checklist (run at every cutover step)

- [ ] Fresh `pg_dump` taken and checksummed (§2) immediately before the step.
- [ ] For any step affecting customer-visible project/media access: every affected owner has a
      verified archive export (§4) predating the step.
- [ ] `pnpm --filter @joy-media/api build && pnpm vitest run apps/api` green on the exact commit
      being deployed (this migration's own discipline — see the wave 0-6 progress log entries).
- [ ] Health sequence after the step: `/live`, `/ready`, `/health/ready`, OTP request+verify
      round trip (Gmail and Telegram), one authenticated `GET /v1/account/subscription` call.
- [ ] Rollback plan identified and rehearsed _before_ the step, not written after something
      goes wrong: release rollback via `joy-media-rollback.sh --dry-run` first, `--apply` only
      after the dry run is reviewed; database restore rehearsed per §3 if the step touched
      schema.
- [ ] Nothing deleted: no release directory removed, no database dropped, no archive discarded,
      matching "Do not delete releases or databases" and the archive locked decision.

## 6. Rollback decision tree

- **A bad API/web release** (wrong code deployed, not a data problem): `joy-media-rollback.sh`
  (§1). No database involved.
- **A bad migration** (schema change causes problems): prefer rolling the API release back
  first (§1) — every migration in `postgres-migrations.ts` is additive-only by this repo's own
  established convention (see `006-look-instances`'s comment: "Additive + nullable — never NOT
  NULL, never a DROP"), so an older API build simply ignores new columns/tables rather than
  breaking. A `pg_restore` (§3) is the last resort, only if the additive-migration assumption
  turns out to be violated.
- **A bad retirement-flag flip** (wave 4/6 flags cut off something still needed): unset the
  environment variable and restart `joy-media@api` — every flag in
  `hosted-route-retirement.ts`/`legacy-editor-retirement.ts` is read fresh from `process.env`
  at process start, so this is a plain config rollback, not a code rollback.
- **A bad Nginx boundary change** (§ see `joy-media-cutover-nginx-boundary.md`): revert to
  `joy-media.nginx.conf`'s current content and reload Nginx — no database or release involved.
