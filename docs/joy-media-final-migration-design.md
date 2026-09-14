# JOY Media final migration — Wave 0 design

Status: wave 0 complete. Written by the Claude Code implementation lead in worktree
`C:\Users\HadiMoti\joy-media-final-migration` (branch `codex/joy-media-final-migration-20260914`),
2026-09-14. No secrets read or written. No deploy, restart, retirement, or payment action taken.

## 1. What already exists vs. what the brief assumes

The brief reads as if the desktop app is greenfield. It is not entirely — but it is much thinner
than the worktree names (`joy-media-windows-worker-companion`, `desktop-companion-hardening`,
`desktop-error-pending`, `desktop-timeout-race`) suggest. Concretely:

| Surface                                      | State found in this worktree                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop` (`@joy-media/desktop`)        | A **dependency-free host contract only**: origin allow-list (`origin-policy.ts`), IPC channel enum + validator (`ipc.ts`), opaque local-file boundary (`file-boundary.ts`), Worker status shape (`worker-status.ts`), `joy://open/project/<uuid>` deep-link parser (`deep-link.ts`). No Electron/Tauri/WebView2 dependency is declared (`package.json` has no runtime deps at all). `pnpm desktop:package` only emits a JSON manifest with `signing: "blocked"`. **There is no main process, no preload script, no BrowserWindow, no packaging toolchain.** README explicitly says so. |
| `apps/editor-web`                            | Real Vite + React editor, full feature set (motion/effects/agent/media panels), builds today with `pnpm --filter @joy-media/editor-web build`. Currently browser/hosted-oriented (talks to `apps/api` over HTTP).                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/worker`                                | Node + `playwright-core` render/export worker (`tsx src/index.ts`), already the job-execution engine referenced by the desktop contract's `worker-status.ts`. Runs today as a standalone process paired to the API over `/v1/worker-pair/*`.                                                                                                                                                                                                                                                                                                                                           |
| `apps/api`                                   | Postgres-backed hosted API (`postgres-*.ts`, `project-document-store.ts`, `project-snapshot-service.ts`, `private-object-store.ts`). **OTP auth already exists**: `POST /v1/auth/request-otp`, `POST /v1/auth/verify-otp`, `POST /v1/auth/logout`, `GET /v1/auth/session`, `GET /v1/auth/avatar` (`http-server.ts:520-563`). No device/session-entitlement, subscription, release-channel, or payment routes exist yet.                                                                                                                                                                |
| `packages/project-persistence`               | `browser-store.ts` (IndexedDB-ish), `desktop-store.ts` (JSON file, atomic temp-file + rename), shared `persistence.ts` contract (`ProjectStore<P,T>` with snapshots + transactions). **No SQLite or other embedded transactional DB anywhere in the repo** (`rg` for `better-sqlite3                                                                                                                                                                                                                                                                                                   | sqlite3 | node:sqlite` is empty). |
| `packages/provider-sdk`                      | Already has `secrets.ts`, `privacy.ts`, `provenance.ts`, `resolution.ts`, `lifecycle.ts`, `idempotency.ts` — this is the existing JOY Agent BYOK contract layer the brief wants "moved behind the desktop host." It is host-agnostic today (used from the browser).                                                                                                                                                                                                                                                                                                                    |
| `apps/api/src/joy-agent-route-retirement.ts` | **Precedent for the wave 4/6 fail-closed retirement pattern already exists**: a regex-matched retired-route predicate + a frozen `{code, message}` response, used when server-side reasoning routes were retired in favor of the browser-based JOY Agent. Reuse this exact shape for the new hosted project/media/job retirement flags.                                                                                                                                                                                                                                                |
| USDC / Alchemy / "Nutrized"                  | **Not present in this repository at all.** The only repo hit for "nutrized" is the VPS hostname `nutrized-hermes` in a deploy runbook (`docs/reviews/joy-live-director-r1-deploy-handoff-2026-09-07.md:156`), not a payment codebase. The brief's "adapt the Nutrized checkout patterns" therefore has **no in-repo reference implementation** — wave 5 must be designed from the locked owner decisions alone, or Codex must hand this worktree a reference (read-only, no secrets) before wave 5 starts.                                                                             |
| `deploy/`, nginx                             | `deploy/joy-media.nginx.conf` documents (not deploys) the live Nginx config: static asset routes, SPA fallback, `/api/` reverse-proxy to `127.0.0.1:8790`. Real config lives inline on the VPS in `joy-wg-bot.conf`; this file is a manually-synced mirror. Any wave 4/6 Nginx boundary change is a **doc/patch proposal only** from this worktree — actual application is a VPS deploy, out of scope here.                                                                                                                                                                            |

Net effect on wave ordering: **wave 1 (desktop host/IPC) is not a refinement, it is the first
real Electron bootstrap.** The existing `apps/desktop` package becomes the _policy layer_ consumed
by a new Electron main process, not something to replace.

## 2. Target architecture (waves 1-3)

```
apps/desktop (Electron)
├── src/main/            Electron main process: app lifecycle, BrowserWindow (sandbox: true,
│                         contextIsolation: true, nodeIntegration: false), crash-safe shutdown,
│                         child-process supervision (Worker), SQLite-backed stores, DPAPI secret
│                         store, deep-link registration, auto-update hook (wave 7).
├── src/preload/          contextBridge surface exposing ONLY the channels enumerated in
│                         ipc.ts (existing). No Node/electron globals leak to the renderer.
├── src/policy/           <- existing origin-policy.ts / ipc.ts / file-boundary.ts / deep-link.ts /
│                         worker-status.ts, unchanged in contract, imported by main + preload.
└── src/store/            SQLite project store implementing the existing ProjectStore<P,T>
                          contract from packages/project-persistence, plus media manifest.

apps/editor-web (renderer)
└── loaded as the BrowserWindow's content (file:// or a packaged local server in dev), talking to
    the host only through the preload bridge — never a raw net/fs API.
```

Key contract decision: **the renderer keeps using `@joy-media/project-persistence`'s
`ProjectStore<P,T>` interface.** Wave 2 adds a SQLite-backed implementation of that same
interface (`sqlite-store.ts`) rather than inventing a new persistence API — this keeps
`apps/editor-web` and `packages/*-core` untouched where possible and confines the desktop-specific
code to `apps/desktop` and the new store module.

## 3. Local persistence: SQLite decision

The brief permits "SQLite or an equivalent transactional embedded store with a documented
reason." Decision: **use `node:sqlite` (Node 22+ built-in, matches the repo's
`engines.node: ">=22"`) via a thin wrapper**, not `better-sqlite3` (native module, would need
prebuilt binaries per Electron ABI and complicate packaging/signing) unless Electron's bundled
Node version at packaging time doesn't expose `node:sqlite` — that must be re-checked once the
Electron version is pinned in wave 1, since Electron's main process Node version can lag stable
Node. Fallback documented reason if `node:sqlite` is unavailable in the pinned Electron/Node
combination: keep `JsonFileProjectStore` (already atomic via temp-file + rename) as the
short-term transactional store and file a follow-up wave-2 task to swap in SQLite once the
runtime allows it — never ship an un-atomic store.

**Status: implemented in wave 2** as `packages/project-persistence/src/sqlite-store.ts`
(`SqliteProjectStore`, exported from the `./desktop` subpath) plus
`apps/desktop/src/store/local-database.ts` (`LocalDatabase`, media manifest + job queue). The
Electron/Node-version re-check from §3 is still open: it needs a real Electron process, which
this worktree cannot run (see the wave 1/2 "known gap" entries in
`docs/joy-media-final-migration-progress.md`). `SqliteProjectStore` itself is not yet wired into
`electron-entry.ts` — see that progress-log entry for why.

Schema (wave 2 draft): `projects`, `snapshots`, `transactions`, `media_manifest` (path, checksum,
kind, byte size, last-verified-at), `provider_profiles` (encrypted blob + metadata only, no
plaintext keys ever touch this DB — keys live in DPAPI-protected storage per the locked owner
decision), `entitlement_state` (signed token cache), `jobs` (Worker job queue/status for
recovery after crash).

## 4. Hosted-service retirement list (wave 4/6 target — not executed in wave 0)

Retire (fail closed with `{code, message}` in the `joy-agent-route-retirement.ts` shape) **only
after** the desktop app covers the equivalent local path and a cutover flag is explicitly enabled:

- `POST /v1/projects`, `POST /v1/projects/ensure`, and the underlying `project-document-store.ts` /
  `project-snapshot-service.ts` / `project-document-sync-request-validation.ts` hosted project
  paths.
- `GET /v1/library/cloud-assets`, `GET /v1/library/my-assets`, `private-object-store.ts`-backed
  media hosting for new project media (existing customer data is archived, not deleted — wave 6).
- `POST /v1/worker-pair/offers`, `POST /v1/worker-pair/claim`, `GET /v1/workers` — hosted
  Worker-pairing/control-plane (`control-plane.ts`, `postgres-control-plane.ts`) once the desktop
  host supervises its own local Worker child process.
- `gpu-preview-transport.ts`, `export-remux.ts` hosted preview/export transport, once local
  monitor/preview/export (wave 2) is in place.

Keep (these match the brief's "internet required" carve-outs and are not part of the retirement
list):

- `/v1/auth/request-otp`, `/v1/auth/verify-otp`, `/v1/auth/logout`, `/v1/auth/session`,
  `/v1/auth/avatar` — OTP login, already implemented, extend with device/session/entitlement
  (wave 4).
- `/v1/providers/reasoning`, `/v1/providers/mistral/complete`, `/v1/providers/speech/*`,
  `/v1/providers/audio/denoise` — hosted-AI/provider actions the brief says may require internet;
  BYOK direct-provider adapters (wave 3) are additive, not a replacement for these.
- Release metadata / download endpoints — new in wave 4, not a retirement.

Every retirement is **flag-gated**, defaults off, and this worktree will not flip a retirement
flag on, restart the API, or touch the live Nginx config — that is explicitly reserved for Codex
per the lead brief's stop conditions.

## 5. Open items that block later waves (owner/Codex gates)

1. **Wave 5 (USDC/Alchemy)** has no in-repo reference implementation to adapt from. Needs either
   an owner-provided read-only reference or a from-scratch design against the locked decisions
   only. Checkout stays disabled regardless (explicit brief requirement).
2. **Wave 7 (signed installer)** needs an owner-provided Windows code-signing certificate/HSM
   access and an Electron packaging toolchain choice (electron-builder vs. electron-forge) — not
   decided yet, deferred to wave 1 implementation detail, finalized at wave 7.
3. **`node:sqlite` vs. Electron's bundled Node version** must be re-verified once wave 1 pins an
   Electron version (see §3).
4. Alchemy webhook/RPC configuration and the Nutrized USDC contract/recipient address need
   "protected verification of deployed configuration" per the locked decisions — this worktree
   will not fetch or guess those values; they must come from the owner through a protected
   channel, not Git/Gbrain/logs.

## 6. Wave-by-wave file ownership (for Codex tracking)

- Wave 1: `apps/desktop/src/main/**`, `apps/desktop/src/preload/**`, `apps/desktop/package.json`
  (adds `electron`), `apps/desktop/electron-builder` config or equivalent, dev scripts.
- Wave 2: `apps/desktop/src/store/**`, `packages/project-persistence/src/sqlite-store.ts` (or
  `apps/desktop/src/store/sqlite-store.ts` if kept desktop-local — decide in wave 2 to avoid
  forcing a native/`node:sqlite` dependency onto browser-targeted packages), Worker supervision
  in `apps/desktop/src/main/worker-supervisor.ts`.
- Wave 3: `packages/provider-sdk/src/**` (extend, do not fork), `apps/desktop/src/main/secrets/**`
  (DPAPI/Keychain wrapper). **Status: implemented** as `provider-sdk`'s `validation.ts` +
  `adapters/openai-compatible.ts`, and `apps/desktop`'s `main/secrets/electron-secret-store.ts`
  (Electron `safeStorage`-backed `SecretStore`) plus `store/local-database.ts`'s new `secrets`
  and `provider_profiles` tables and five new IPC channels. Deliberately does **not** relocate
  `apps/editor-web/src/joy-agent/**` (the large, live, tested JOY Agent engine) — see
  `docs/joy-media-final-migration-progress.md`'s wave 3 entry for why and what remains.
- Wave 4: `apps/api/src/**` new route modules + `postgres-migrations.ts` additions,
  `apps/editor-web` account panel UI, `deploy/` doc updates (not live changes). **Status:
  implemented** for the server side — `entitlement-signing.ts` (Ed25519, systemd-credential
  read), `account-service.ts` (devices/subscriptions/entitlement issuance),
  `release-metadata-service.ts`, `hosted-route-retirement.ts` (flag-gated, all flags default
  off), migration `007-account-devices-subscriptions-entitlements`, and the matching
  `http-server.ts`/`server.ts` wiring. **Not implemented:** any `apps/editor-web` account panel
  UI (no renderer code calls the new routes yet) and `deploy/joy-media-api.override.conf` is
  deliberately left untouched — see `docs/joy-media-final-migration-progress.md`'s wave 4 entry
  for why adding its `LoadCredentialEncrypted=` line myself would be a live-deploy risk, not a
  doc-only change.
- Wave 5: new `packages/invoice-ledger` (or `apps/api/src/invoice-*.ts`), disabled by default.
  **Status: implemented** as `apps/api/src/usdc-catalog.ts` (USD prices, exact base-unit
  conversion — placeholder $0.00 prices), `usdc-invoice-ledger.ts` (Postgres-backed invoice
  state machine), `usdc-confirmation.ts` (pure on-chain verification + RPC receipt decoding),
  `alchemy-transport.ts`/`alchemy-webhook.ts` (protected RPC/webhook, both credential-sourced),
  `usdc-checkout-service.ts` (orchestration), migration `008-usdc-invoices`, and 4 new
  `http-server.ts` routes. `JOY_MEDIA_USDC_CHECKOUT_ENABLED` defaults `false` and this
  worktree never sets it — see `docs/joy-media-final-migration-progress.md`'s wave 5 entry for
  the full verification trail, the "why no contract address is hardcoded" rationale, and what
  remains deliberately out of scope (on-chain refund execution, an operator-facing
  reconciliation UI/route, and validating `alchemy-webhook.ts`'s payload parser against a real
  Alchemy delivery).
- Wave 6: new `tooling/archive/**` export/checksum scripts, runbooks under `docs/`. **Status:
  implemented** — `tooling/archive` (manifest/encryption/export/import/no-data-loss
  verification, all tested, none wired to a live data source), `apps/api/src/
legacy-editor-retirement.ts` (coarse VPS kill switch, defaults off),
  `deploy/joy-media-cutover-nginx-boundary.md` (proposal, not applied), and
  `docs/joy-media-final-migration-backup-restore-runbook.md` (DB backup/restore + archive
  cutover checklist, referencing the existing `joy-media-rollback.sh` rather than duplicating
  it). See `docs/joy-media-final-migration-progress.md`'s wave 6 entry for what remains
  deliberately unwired (a real `ProjectArchiveSource`, an export/import route or CLI, desktop
  import wiring).
- Wave 7: `apps/desktop` packaging/signing scripts, `docs/joy-media-final-migration-progress.md`
  final acceptance section.

## 7. Test/build baseline captured at wave 0

Baseline commands (from repo root, this worktree) and their result are recorded in
`docs/joy-media-final-migration-progress.md` so later waves can diff against a known-good state.
