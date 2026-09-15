# JOY Media final migration — progress log

Lead: Claude Code (`claude-sonnet-5`), worktree `C:\Users\HadiMoti\joy-media-final-migration`,
branch `codex/joy-media-final-migration-20260914`. This log is updated at every wave boundary
with exact evidence so Codex can update external handoffs. No deploy, VPS restart, production
data change, secret change, or payment activation has been performed.

## Wave 0 — Preflight/architecture (COMPLETE)

**Commit:** see `git log` for the commit that adds this file and
`docs/joy-media-final-migration-design.md` (wave 0 docs-only commit).

**What was done:**

- Surveyed `apps/desktop`, `apps/editor-web`, `apps/worker`, `apps/api`,
  `packages/project-persistence`, `packages/provider-sdk`, `deploy/`, and the repo for any
  existing USDC/Alchemy/"Nutrized" payment code.
- Found `apps/desktop` is a **host-neutral policy contract only** (no Electron/Tauri dependency,
  no main process) — wave 1 is a real Electron bootstrap, not a refinement.
- Found OTP auth (`/v1/auth/request-otp|verify-otp|logout|session|avatar`) already implemented in
  `apps/api/src/http-server.ts` — wave 4 extends this rather than building it from scratch.
- Found no SQLite/embedded-DB usage anywhere in the repo; confirmed `node:sqlite` is available
  (experimental) on the installed Node 22.22.3.
- Found `apps/api/src/joy-agent-route-retirement.ts` as the existing fail-closed retirement
  pattern to reuse for wave 4/6 hosted-route retirement.
- Confirmed no in-repo "Nutrized" payment reference exists (`nutrized-hermes` is only a VPS
  hostname in a deploy runbook) — flagged as a wave 5 blocker requiring owner/Codex input.
- Wrote `docs/joy-media-final-migration-design.md`: architecture map, target Electron/SQLite
  layout, retirement list (flag-gated, not executed), wave-by-wave file ownership, and open
  gate items.

**Commands run (this worktree):**

- `pnpm install --frozen-lockfile` → succeeded (353 packages resolved from store, 0 downloaded).
- `node -e "require('node:sqlite')"` → `DatabaseSync` present under
  `ExperimentalWarning: SQLite is an experimental feature`.
- `pnpm --filter @joy-media/desktop test` → **5/5 passed** (`src/desktop.test.ts`), 329ms.

**Known blockers / gates for later waves:**

- Wave 5 (USDC/Alchemy) has no in-repo reference implementation; needs owner/Codex-provided
  material or a from-scratch design against the locked decisions.
- Wave 7 (signing) needs an owner-provided Windows code-signing certificate and a packaging
  toolchain decision (electron-builder vs. electron-forge) — not yet made.
- `node:sqlite` vs. Electron's bundled Node version must be re-verified once wave 1 pins an
  Electron release.

**Next gate:** none — wave 1 (Electron main/preload/renderer bootstrap) may proceed in this
worktree without further owner input.

---

## Wave 1 — Desktop host/IPC (COMPLETE, with one documented runtime gap)

**Commit:** see `git log` for the commit adding `apps/desktop/src/main/**` and
`apps/desktop/src/preload/**` (wave 1 commit, immediately after the wave 0 docs commit).

**What was done:**

- Added `electron` (`^44.3.0`) as a devDependency of `@joy-media/desktop`.
- Added a real Electron main process (`apps/desktop/src/main/electron-entry.ts`), thin by
  design, wiring the existing policy contract (`origin-policy.ts`, `ipc.ts`, `file-boundary.ts`,
  `worker-status.ts`, `deep-link.ts` — all unchanged) to:
  - `main/file-registry.ts` — main-process-only id→realPath map wrapping `createFileBoundary`
    (the raw path still never crosses into the shared policy layer or the renderer).
  - `main/worker-supervisor.ts` — supervises the Worker as a child process: spawn, crash-restart
    up to a cap then `degraded`, graceful SIGTERM→SIGKILL stop, `WorkerStatus`-shaped reporting.
  - `main/ipc-handlers.ts` — the 5 `IPC_CHANNELS` handlers plus `dispatchIpcRequest`, which
    re-validates origin+channel (failing closed, including on the policy layer's thrown
    "blocked origin" error) before any handler runs.
  - `main/window.ts` — `buildSecureWebPreferences` (`sandbox: true`, `contextIsolation: true`,
    `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `webviewTag: false`) and
    `resolveRendererTarget` (dev → `http://localhost:5173`, in the existing origin allow-list;
    packaged → a privileged custom `joy-media-app://` scheme registered as standard+secure, so
    the packaged renderer keeps a normal secure-context origin instead of `file://`).
  - `main/shutdown.ts` — crash-safe, idempotent shutdown on `before-quit`, `window-all-closed`,
    `SIGINT`, `SIGTERM`: stops the Worker before flushing.
  - `electron-entry.ts` also: single-instance lock, `app.setAsDefaultProtocolClient('joy')` +
    `second-instance` deep-link handling, a denied `setWindowOpenHandler`, and a denied default
    permission-request handler.
- Added `src/preload/ipc-channels.cjs` (electron-free channel data) and `src/preload/preload.cjs`
  (hand-written CommonJS `contextBridge` bridge — kept out of the tsc/NodeNext ESM build
  deliberately; see the in-file comment and the README for why).
- Every new main-process module is dependency-injected and unit-tested against a **mocked**
  `electron` surface (fake `spawn`, fake `dialog`, fake `app`/process event emitters) —
  `electron-entry.ts` itself is the only untested file, by design (see "known gap" below).
- Updated `apps/desktop/README.md` (layout, boundaries, known gap, commands) and
  `scripts/package-dev.mjs`'s dev manifest to describe the real bootstrap instead of the old
  "host-contract-only, nativeHost: not-selected" placeholder.
- Added an eslint override for `apps/desktop/src/preload/*.cjs` (CommonJS + `window` globals).

**Commands run (this worktree):**

- `pnpm install` (adds `electron`) → succeeded; lockfile diff is additive-only (electron + its 2
  transitive deps). **`electron`'s own binary download did not run**: `pnpm-workspace.yaml`'s
  `allowBuilds` allowlist does not include `electron`, so pnpm correctly blocked its postinstall
  script per the repo's existing supply-chain policy — this worktree did not add it there itself
  (see "known gap").
- `pnpm --filter @joy-media/desktop build` (`tsc -b`) → **passes** (typechecks against
  electron's bundled `.d.ts`, which installed fine without the binary).
- `pnpm --filter @joy-media/desktop test` → **27/27 passed** across 7 files (up from 5/5 at wave
  0: `desktop.test.ts` unchanged + 6 new files: `file-registry.test.ts`,
  `worker-supervisor.test.ts`, `ipc-handlers.test.ts`, `window.test.ts`, `shutdown.test.ts`,
  `preload/preload.test.ts`).
- `pnpm typecheck` (root, all 42 workspace projects) → **passes**.
- `pnpm lint` (root eslint) → **passes, 0 problems**.
- `pnpm format:check` (root prettier) → **1 pre-existing failure**,
  `apps/editor-web/src/playback-loop-contract.test.ts`, confirmed via
  `git log -1 -- <file>` to predate this worktree's wave 0/1 commits (last touched by
  `c398de80`, a prior unrelated commit) — not introduced by this work, left as-is. All files
  this wave touched are prettier-clean.
- `pnpm desktop:package` → succeeded, wrote
  `apps/desktop/dist/joy-media-desktop-dev.json` with `signing.status: "blocked"` still true
  (wave 7 gate).

**Known gap (explicit, not silently accepted):**

- **No real Electron window has been opened.** This background session has no interactive
  display, and `electron`'s binary was not downloaded (see `allowBuilds` above), so
  `electron-entry.ts` — the one file with no unit coverage by design — has not been runtime
  smoke-tested end-to-end (window opens, preload bridge answers a real IPC round-trip, deep
  link opens a second instance, custom-scheme protocol serves a packaged build). Before wave 1
  is treated as fully done, a human or a session with a real Windows desktop session needs to:
  1. Add `electron: true` to `pnpm-workspace.yaml`'s `allowBuilds` (an explicit owner/Codex
     decision — this worktree deliberately did not add it unilaterally).
  2. `pnpm install` again so the real Electron binary downloads.
  3. `pnpm --filter @joy-media/editor-web dev` (Vite dev server) +
     `pnpm --filter @joy-media/desktop dev:electron` and confirm a window opens, loads the
     editor, and `window.joyDesktop.invoke(...)` round-trips.

**Next gate:** none required to start wave 2 (local runtime) — it can proceed against the
dependency-injected module boundaries already in place. The runtime smoke test above should
happen before any packaged build is trusted, and definitely before wave 7 signing.

---

## Wave 2 — Local runtime (COMPLETE for the desktop-host substrate; editor-web wiring deferred)

**Commit:** see `git log` for the commit adding `packages/project-persistence/src/sqlite-store.ts`
and `apps/desktop/src/store/**` (wave 2 commit, after the wave 1 commit).

**What was done:**

- `packages/project-persistence/src/sqlite-store.ts`: `SqliteProjectStore<P,T>`, a `node:sqlite`
  implementation of the existing `ProjectStore<P,T>` contract (same interface
  `JsonFileProjectStore` and `BrowserProjectStore` already implement). Two tables
  (`snapshots`, `transactions`), WAL journal mode, every multi-row write wrapped in
  `BEGIN IMMEDIATE`/`COMMIT` with `ROLLBACK` on error (tested by poisoning a payload with a
  BigInt mid-batch and confirming the prior row survives). Exported from the package's
  `./desktop` subpath only — never the browser-safe `.` entry `apps/editor-web`'s Vite bundle
  resolves — same convention `desktop-store.ts` already established.
- `apps/desktop/src/store/paths.ts`: pure `resolveDesktopPaths(userDataDir)` → database file +
  media root, so path resolution is testable without Electron's `app.getPath`.
- `apps/desktop/src/store/local-database.ts`: `LocalDatabase`, a second `node:sqlite` connection
  (safe under WAL) to the same file, owning two desktop-host-only concerns:
  - **Media manifest** (`media_manifest` table): `recordMedia`/`getMedia`/`listMedia`/
    `removeMedia`, keyed by the same opaque ref id `file-registry.ts` mints.
  - **Job queue** (`jobs` table): `enqueueJob`/`updateJobStatus`/`getJob`/`listJobs`, plus
    `recoverInterrupted()` — marks every `queued`/`running` job `cancelled` with
    `error: "interrupted by shutdown"`, called once at main-process startup before any new job
    can be enqueued. This is the crash-recovery contract for jobs.
- `apps/desktop/src/main/media-checksum.ts`: streaming SHA-256 (`checksumFile`), extension-based
  `classifyMediaKind`, and `fileExistsWithSize` for future re-verification passes.
- Wired into `ipc-handlers.ts` / `electron-entry.ts`:
  - `desktop.select-file` now probes the chosen file and records it into the media manifest;
    `desktop.revoke-file` removes that record too.
  - `desktop.request-derivative` now enqueues a `queued` job and returns its id alongside the
    existing approval token.
  - Two new `IPC_CHANNELS`: `desktop.job-status` (`{jobId}` → `JobRecord`) and
    `desktop.cancel-job` (`{jobId}` → cancels, refusing an already-finished job). Added to
    `ipc.ts`, `preload/ipc-channels.cjs` (kept in sync — `preload.test.ts`'s guard catches
    drift), and `desktop.test.ts` needed no change (it doesn't assert the full channel list).
  - `electron-entry.ts` now resolves `paths = resolveDesktopPaths(app.getPath('userData'))`,
    creates the media root directory, opens `LocalDatabase`, calls `recoverInterrupted()` before
    handling any IPC, and closes it inside `shutdown.ts`'s flush step (after the Worker stops).

**Explicitly deferred (not silently dropped), same honesty pattern as the wave 1 gap:**

- `SqliteProjectStore` is **not yet constructed in `electron-entry.ts`**: no IPC channel opens
  or saves a project through it. Wiring it in requires new IPC channels (open/save/list/delete
  project) plus a renderer-side decision in `apps/editor-web` about when to use the desktop
  store instead of its current browser store — a sensitive change to a live, tested app that
  this pass deliberately did not touch, to avoid regressing working editor code without a
  runtime smoke test available in this session (see the wave 1 gap).
- `desktop.request-derivative` enqueues a job row but **does not dispatch it to the Worker**:
  no job-protocol wire format between the desktop host and the Worker child process exists yet.
  A queued job sits `queued` until cancelled or the app restarts (at which point
  `recoverInterrupted()` cancels it). Real dispatch is follow-up work.
- "Monitor/preview data path" and "offline-first editor startup" from the wave 2 brief are not
  addressed: both are `apps/editor-web` runtime-selection concerns (which data source to read
  from, live GPU preview transport) that depend on the project-store wiring above landing first.
- Media probing here is extension-based classification + a full-file hash, not the Worker's real
  demux/codec/duration probe — intentionally, per the existing README boundary ("the Worker
  remains the owner of probing, hashing, and derivative generation").

**Commands run (this worktree):**

- `pnpm --filter @joy-media/project-persistence build` (`tsc -b`) → **passes**.
- `pnpm vitest run packages/project-persistence` → **17/17 passed** (11 existing +
  6 new `sqlite-store.test.ts`).
- `pnpm --filter @joy-media/desktop build` (`tsc -b`) → **passes**.
- `pnpm --filter @joy-media/desktop test` → **56/56 passed** across 10 files (up from 27/27 at
  wave 1: +`store/paths.test.ts`, +`store/local-database.test.ts`, +`main/media-checksum.test.ts`, and `ipc-handlers.test.ts` grew from 6 to 13 tests).
- `pnpm typecheck` (root, all 42 workspace projects) → **passes**.
- `pnpm lint` (root eslint) → **passes, 0 problems**.
- `pnpm format:check` (root prettier) → **same single pre-existing failure** as wave 1
  (`apps/editor-web/src/playback-loop-contract.test.ts`, unrelated, predates this worktree). All
  files this wave touched are prettier-clean.

**Known gap:** same as wave 1 — nothing in `apps/desktop` has been runtime-smoke-tested with a
real Electron window in this session (no display, `electron`'s binary not downloaded). The
`LocalDatabase`/`SqliteProjectStore` code paths are exercised by real `node:sqlite` in unit
tests (not mocked), which is a meaningfully stronger guarantee than the Electron-API-mocked main
process code, but "does the whole app start up, open the SQLite file under a real `userData`
path, and survive an actual crash" is still unverified end-to-end.

**Next gate:** none required to start wave 3 (JOY Agent/BYOK). Before resuming the deferred
items above (project-store IPC wiring, job dispatch to the Worker), the wave 1 runtime smoke
test gate should be cleared first, since both build directly on `electron-entry.ts` actually
running.

---

## Wave 3 — JOY Agent/BYOK behind desktop host (COMPLETE for the host-side substrate; editor-web integration deferred)

**Commit:** see `git log` for the commit adding `packages/provider-sdk/src/validation.ts`,
`packages/provider-sdk/src/adapters/openai-compatible.ts`, and
`apps/desktop/src/main/secrets/**` (wave 3 commit, after the wave 2 commit).

**A scoping decision made before writing any code:** the brief says "move the existing JOY
Agent protocol and local engine behind the desktop host." That engine is
`apps/editor-web/src/joy-agent/**` — roughly 90 files, live, heavily tested, the product's
actual working AI-editing feature today (`byok-session.ts`, `engine.worker.ts`,
`run-controller.ts`, the approval/revision/readback chain, etc.). Actually relocating it into
`apps/desktop` in one pass, with no way to runtime-smoke-test the result in this session (see
the wave 1/2 known gap), would risk regressing a live feature with no way to catch the
regression before it's committed. That is exactly the kind of change the lead brief's own
engineering-discipline section warns against. Instead, this wave builds the new
**desktop-host-only capability the browser-only implementation structurally cannot have** —
OS-protected persistent key storage — as additive infrastructure the existing engine can be
wired into later, and does not touch a single file under `apps/editor-web/src/joy-agent/`.

**What was done:**

- `packages/provider-sdk/src/validation.ts`: `validateProviderProfileInput` — fails closed on
  an unsupported provider, empty model id, or insecure base URL (`https://` only, except
  `http://` to a loopback host for local OpenAI-compatible servers like Ollama). Field names
  (`provider`, `baseUrl`, `modelId`) deliberately match
  `apps/editor-web/src/joy-agent/protocol.ts`'s existing `ByokSessionConfig`.
- `packages/provider-sdk/src/adapters/openai-compatible.ts`: `probeOpenAiCompatibleProvider` —
  a dependency-injected (no `fetch`/`node:*`/`electron` import) connectivity probe: a tiny,
  fixed synthetic request, never real content. Maps HTTP 401/403 → `AUTH_FAILED`, other
  non-2xx → `PROVIDER_INCOMPATIBLE`, an oversized response → `RESPONSE_TOO_LARGE`, an
  `AbortError` → `TIMEOUT`, anything else → `NETWORK_ERROR`. The report never includes the
  response body, endpoint, or credential — tested explicitly (`JSON.stringify(report)` must
  never contain the fake secret or the fake leaking body used in tests).
- `apps/desktop/src/main/secrets/electron-secret-store.ts`: `createElectronSecretStore` —
  implements provider-sdk's existing `SecretStore` contract (the same one
  `createMemorySecretStore` implements) over Electron's `safeStorage` (OS-level DPAPI on
  Windows) plus `LocalDatabase`'s new `secrets` table for ciphertext only. Refuses to store a
  key at all if `safeStorage.isEncryptionAvailable()` is false, rather than a plaintext
  fallback. `redact()` mirrors the in-memory reference implementation's semantics: every value
  this instance has ever encrypted or decrypted stays redactable, even after deletion.
- `apps/desktop/src/store/local-database.ts`: two new tables — `secrets` (ciphertext only,
  keyed by handle id) and `provider_profiles` (non-secret metadata: `provider`, `baseUrl`,
  `modelId`, a `secretHandleId` pointer — never the key) — plus CRUD methods for both.
- `apps/desktop/src/main/ipc-handlers.ts`: five new channels —
  `desktop.provider-profile.save` (validates, writes the key to `safeStorage` _before_ writing
  profile metadata, so a crash between the two never orphans a profile pointing at a
  never-written handle; rejects an `id` that doesn't already exist rather than creating a
  forged profile), `.list` (metadata only — tested that the JSON response never contains a
  saved secret), `.delete` (removes both profile and secret), `.begin-session` (a **volatile,
  one-time** plaintext handoff of a `ByokSessionConfig`-shaped object, matching
  `apps/editor-web/src/joy-agent/byok-session.ts`'s existing `forgetByokConfig` volatility
  contract for manually-entered keys), `.test` (runs the host-side probe with the resolved key
  and returns only the redacted report — the key never reaches the renderer for a connectivity
  test). Added to `ipc.ts`, `preload/ipc-channels.cjs` (kept in sync), and wired for real in
  `electron-entry.ts` (`safeStorage` import, `createElectronSecretStore`,
  `probeOpenAiCompatibleProvider(request, fetch)`).
- `apps/desktop/package.json`/`tsconfig.json`: added `@joy-media/provider-sdk` as a real
  dependency (workspace TS project reference).
- Updated `apps/desktop/README.md` (new "BYOK / JOY Agent provider profiles" section) and
  `packages/provider-sdk/README.md` (new addendum) with the same explicit "not yet wired into
  the renderer" framing as the wave 2 deferrals.

**Explicitly deferred (not silently dropped):**

- No code under `apps/editor-web/src/joy-agent/` was touched. `byok-session.ts`'s manual
  key-entry flow still works exactly as it does today; a future wave would add a call to
  `desktop.provider-profile.begin-session` (or a profile-management UI) as an alternative to
  typing the key in each session — this wave only makes that call possible, not automatic.
- The `.test` probe and `.begin-session` handoff are both real and tested against a mocked
  `SecretStore`/`fetch`, but neither has been exercised against Electron's real `safeStorage`
  (needs a real OS session — see the running known gap) or a real provider endpoint.

**Commands run (this worktree):**

- `pnpm --filter @joy-media/provider-sdk build` (`tsc -b`) → **passes**.
- `pnpm --filter @joy-media/desktop build` (`tsc -b`) → **passes**.
- `pnpm vitest run apps/desktop packages/provider-sdk` → **214/214 passed** across 24 files, up
  from 171 tests across 21 files combined at the end of wave 2 (desktop: 56→84 tests, 10→11
  files — new `secrets/electron-secret-store.test.ts` (10 tests), `local-database.test.ts`
  21→33 tests, `ipc-handlers.test.ts` 13→22 tests; provider-sdk: 115→130 tests, 11→13 files —
  new `validation.test.ts` (7 tests) and `adapters/openai-compatible.test.ts` (8 tests)).
- `pnpm typecheck` (root, all 42 workspace projects) → **passes**.
- `pnpm lint` (root eslint) → **passes, 0 problems** (one `@typescript-eslint/consistent-type-imports`
  violation from an inline `import()` type annotation was caught and fixed during this wave).
- `pnpm format:check` (root prettier) → **same single pre-existing failure** as waves 1-2
  (`apps/editor-web/src/playback-loop-contract.test.ts`, unrelated, predates this worktree). All
  files this wave touched are prettier-clean.

**Known gap:** same running gap as waves 1-2 — no real Electron window/process in this session,
so `safeStorage`'s actual availability/behavior (it can return
`isEncryptionAvailable() === false` on a machine without OS credential protection configured,
which the code handles by refusing to store rather than falling back to plaintext, but that
path itself is untested against the real API) is unverified end-to-end.

**Next gate:** none required to start wave 4 (VPS account/site routes) — it is a different
codebase area (`apps/api`) with no dependency on the wave 1-3 desktop work. The wave 1 runtime
smoke test gate remains the thing to clear before trusting any of `apps/desktop`'s Electron
wiring end-to-end.

---

## Wave 4 — VPS account/site routes (COMPLETE for the API surface; editor-web panel + live cutover deferred)

**Commit:** see `git log` for the commit adding `apps/api/src/entitlement-signing.ts`,
`account-service.ts`, `release-metadata-service.ts`, `hosted-route-retirement.ts`, and the
matching `http-server.ts`/`server.ts`/`postgres-migrations.ts` wiring (wave 4 commit, after the
wave 3 commit).

**What was done:**

- `entitlement-signing.ts`: Ed25519 signing (`node:crypto`, no JWT library — a plain, auditable
  `{payload, signature}` JSON shape) satisfying the locked decision that device/session
  entitlements be "signed, time-bounded, revocable, and safe under clock rollback/offline use."
  `readEntitlementSigningKeyFromCredential` reads the private key only from the systemd
  `LoadCredential=` directory `joy-media@api.service` already uses for its other secrets
  (`stock-video-credentials.ts` precedent) — never generated, never committed, never logged.
  `DisabledEntitlementSigner` fallback when unconfigured.
- `account-service.ts`: `AccountService` (devices, subscriptions, entitlement issuance), same
  `pool`-backed-class-plus-`Disabled*`-fallback shape as `MediaAuthService`/`DisabledMediaAuth`.
  Identity is always the `mediaAuth` actor id (OTP contact) — the same identity domain as
  `/v1/auth/*`, not the legacy `ApiAuthentication` project/worker/job actor. Revocation works by
  _absence of reissuance_: a revoked device can never get a new entitlement, and every issued
  entitlement expires on its own within 72h (configurable) — no live revocation-check network
  call is needed on every offline use, which is what makes offline verification safe.
  `selectPlan` records a pending plan (status stays `none` — wave 5's payment confirmation is
  what activates it via the included-but-unwired `activateSubscription` hook) and refuses to
  touch an already-active subscription. `getSubscription` computes `expired` at read time by
  comparing `current_period_end` to `now` — no separate expiry cron/job/state to go stale.
- `release-metadata-service.ts`: public read model (`GET /v1/releases/:channel`, no auth) for
  the installer/download page and the desktop app's own update check; `publish` exists but is
  reachable only by direct call, not any HTTP route — wave 7's job.
- `hosted-route-retirement.ts`: generalizes `joy-agent-route-retirement.ts`'s `{code, message}`
  fail-closed shape to the exact 7 hosted project/media/Worker-pairing routes the wave 0 design
  doc names (`POST /v1/projects`, `POST /v1/projects/ensure`, `GET /v1/library/cloud-assets`,
  `GET /v1/library/my-assets`, `POST /v1/worker-pair/offers`, `POST /v1/worker-pair/claim`,
  `GET /v1/workers`), one flag per group, exact method+pathname matching (never a prefix regex
  — tested that a project sub-route like `/v1/projects/:id/preview-sessions` is never matched).
  Every flag reads `env[VAR] === 'true'` and defaults `false`; `server.ts` reads them from
  `process.env` but this worktree never sets any of them.
- Migration `007-account-devices-subscriptions-entitlements` (additive-only: `account_devices`,
  `account_subscriptions`, `release_metadata` tables), following the existing checksummed
  `PostgresMigration` ledger pattern — appended, not editing an applied migration.
- `http-server.ts`: 8 new routes wired in — `POST`/`GET /v1/devices`,
  `POST /v1/devices/:id/revoke`, `GET`/`POST /v1/account/subscription`,
  `POST /v1/entitlements/refresh`, `GET /v1/entitlements/public-key` (public),
  `GET /v1/releases/:channel` (public) — plus the hosted-route-retirement check placed right
  after the existing JOY Agent retirement check (same position, same "auth checked first"
  ordering). New `AccountServiceError`/`ReleaseMetadataError` branches in `respondError`. All
  four new `ControlPlaneHttpServerOptions` fields (`account`, `releases`,
  `entitlementPublicKeyPem`, `hostedRouteRetirement`) are optional with safe disabled/empty/all-
  off defaults, so every existing caller of `createControlPlaneHttpServer` (tests included)
  keeps behaving exactly as before without being updated.
- `server.ts`: real wiring — reads the signing key from its systemd credential path, constructs
  `AccountService`/`ReleaseMetadataService` when `pool` is configured (else the `Disabled*`
  fallbacks), reads the three retirement flags from `process.env`.
- `docs/joy-media-final-migration-design.md` updated (wave 4 status).

**Explicitly deferred (not silently dropped):**

- No `apps/editor-web` UI calls any of the 8 new routes — no account/device/subscription panel
  exists yet. This wave only built the API surface that panel will call.
- `deploy/joy-media-api.override.conf` (the real, tracked systemd override this Sweden VPS
  deploy uses) was **deliberately not edited** to add a
  `LoadCredentialEncrypted=joy-media-entitlement-signing-key:...` line. Unlike the nginx config
  doc mirror, this file's precedent (`docs/reviews/...deploy-handoff...`) suggests it may be
  applied close to verbatim during a real deploy — adding that line without the owner first
  creating `/etc/credstore.encrypted/joy-media-entitlement-signing-key` via `systemd-creds
encrypt` would make `systemctl restart joy-media@api.service` fail outright (systemd refuses
  to start a unit whose `LoadCredentialEncrypted=` target is missing). That is a live-deploy
  risk this worktree will not take; Codex/the owner should add that line together with actually
  provisioning the credential, as one atomic ops step.
- No cutover flag was set anywhere real; `isRetiredHostedRoute` is exercised only by this
  wave's own tests and stays inert in every actual deployment today.
- `activateSubscription` (the wave 5 payment-confirmation hook) exists and is tested but is not
  called from any route — wave 5's job.

**Commands run (this worktree):**

- `pnpm --filter @joy-media/api build` (`tsc -b`, including a from-scratch rebuild after
  deleting `dist/`/`*.tsbuildinfo` to rule out an incremental-build false pass) → **passes**.
- `pnpm vitest run apps/api` → **454/454 passed** across 34 files (37 pre-existing skips
  unrelated to this wave); this wave added 65 net-new tests (5 new test files: 12 in
  `entitlement-signing.test.ts`, 19 in `account-service.test.ts`, 8 in
  `release-metadata-service.test.ts`, 9 in `hosted-route-retirement.test.ts`, 16 in
  `http-server-account-routes.test.ts`; plus 1 new case in `postgres-migrations.test.ts`).
  `account-service.test.ts` and `release-metadata-service.test.ts` run against real SQL via
  `pg-mem` (same harness `media-auth.test.ts` already established), not a mocked pool.
- `pnpm typecheck` (root, all 42 workspace projects) → **passes**.
- `pnpm lint` (root eslint) → **passes, 0 problems**.
- `pnpm format:check` (root prettier) → **same single pre-existing failure** as waves 1-3
  (`apps/editor-web/src/playback-loop-contract.test.ts`, unrelated, predates this worktree). All
  files this wave touched are prettier-clean.

**Known gap:** `options.mediaAuth`/`options.account`/etc. being accessed without an optional
check inside `route()` relies on that function's parameter type intersection
(`ControlPlaneHttpServerOptions & { readonly mediaAuth: MediaAuthApi; ... }`) marking them
non-optional — this is the file's own pre-existing pattern (confirmed by a from-scratch build),
not something this wave introduced, but it means a future caller of the internal `route()`
function directly (not `createControlPlaneHttpServer`) could in principle bypass the defaulting.
Not a new risk this wave created; flagged for completeness.

**Next gate:** none required to start wave 5 (USDC/Alchemy) as far as _code_ goes — wave 5's
`activateSubscription` hook already exists. However wave 5 itself is blocked per the wave 0
design doc: no in-repo Nutrized/USDC/Alchemy reference exists, and checkout must stay disabled
regardless per the locked owner decisions. Before wave 4's account/device/subscription routes
are trusted in production: (1) the owner/Codex must provision the
`joy-media-entitlement-signing-key` systemd credential and add the corresponding
`LoadCredentialEncrypted=` line to `deploy/joy-media-api.override.conf` together, (2) run the
migration against the real database, (3) build the `apps/editor-web` account panel UI.

---

## Wave 5 — USDC/Alchemy invoice ledger (COMPLETE for the API surface; checkout stays disabled, editor-web UI + reconciliation route deferred)

**Commit:** see `git log` for the commit adding `apps/api/src/usdc-catalog.ts`,
`usdc-invoice-ledger.ts`, `usdc-confirmation.ts`, `alchemy-transport.ts`, `alchemy-webhook.ts`,
`usdc-checkout-service.ts`, and the matching `http-server.ts`/`server.ts`/
`postgres-migrations.ts` wiring (wave 5 commit, after the wave 4 commit).

**No in-repo Nutrized reference existed to adapt (confirmed at wave 0)**, so every piece here
is designed from scratch against the locked owner decisions alone — "Use the exact Nutrized
public USDC contract and recipient only after protected verification of deployed
configuration" specifically forbids inventing or hardcoding one, including the well-known
canonical Ethereum-mainnet USDC contract address: this worktree never writes that address
anywhere. Every route and service takes the recipient/contract address as required,
non-defaulted configuration.

**What was done:**

- `usdc-catalog.ts`: USD price catalog + exact decimal-string → USDC-base-unit conversion (no
  `Number()`/float math anywhere in the path — `usdToUsdcBaseUnits('999999.99')` is exact).
  **Prices are placeholders: `$0.00` for both plans**, overridable via
  `JOY_MEDIA_USDC_MONTHLY_PRICE_USD`/`JOY_MEDIA_USDC_YEARLY_PRICE_USD`. `$0.00` is deliberate,
  not lazy: even if the disabled gate were ever bypassed, a real on-chain USDC transfer of
  exactly zero cannot happen, so no placeholder invoice can ever actually confirm.
- `usdc-confirmation.ts`: `verifyTransferAgainstInvoice` (pure — chain/contract/recipient/exact
  amount/confirmation-count checks, no I/O, fully unit-tested) and
  `observeTransferFromReceipt` (decodes a real ERC20 `Transfer` log from a JSON-RPC receipt —
  the event topic hash is public protocol data, safe to hardcode unlike the contract address).
- `alchemy-transport.ts`: `AlchemyJsonRpcTransport`, a fixed-shape JSON-RPC HTTP client whose
  URL (the credential — Alchemy's auth is URL-embedded) is read only from the systemd
  credential directory and never appears in a thrown error message (tested explicitly). Also
  reads the separate webhook HMAC signing key from its own credential id.
- `alchemy-webhook.ts`: `verifyAlchemyWebhookSignature` (HMAC-SHA256 over the _raw_ body,
  `timingSafeEqual` comparison) and `extractCandidateTxHashes`, explicitly documented as a
  best-effort payload parser **not validated against a real Alchemy delivery** — every field it
  extracts is independently re-derived from the chain via RPC before anything is trusted (see
  known gap below).
- `usdc-invoice-ledger.ts`: `UsdcInvoiceLedger` — ERC20 transfers carry no memo, so pending
  invoices are disambiguated by a unique _exact amount_ (catalog price + a small per-invoice
  base-unit nudge), enforced by a Postgres partial unique index on
  `(recipient_address, amount_usdc_base_units) WHERE status = 'pending'` (confirmed working
  against real pg-mem SQL, including the retry-on-collision path). `confirmInvoice` is a
  compare-and-set (`WHERE status = 'pending'`) that is also replay-safe (identical evidence
  resubmitted returns the same row) and collision-safe (a second unique index on
  `(tx_hash, log_index)` means the same on-chain event can never confirm two different
  invoices — tested explicitly). `expireStalePending`/`refundInvoice` are real, explicit state
  transitions (unlike wave 4's subscriptions, an invoice's `pending` status is not just
  computed on read, because expiry must free the amount slot the uniqueness index reserved).
  `listForReconciliation` returns every field as-is — the row shape itself contains no secret.
- `usdc-checkout-service.ts`: orchestrates create → observe → verify → confirm → activate.
  "Exactly-once entitlement activation" comes from `AccountService.activateSubscription` being
  an idempotent _overwrite_, not a separate dedup guard — documented explicitly, and tested
  that re-running confirmation with the same evidence is a no-op the second time (the ledger's
  own "no longer pending" check stops it before a second activation call). `createInvoice`
  throws `CHECKOUT_DISABLED` whenever `checkoutEnabled` is false — the default, and the only
  value this worktree ever sets.
- Migration `008-usdc-invoices` (additive-only, both unique indexes), appended to the ledger.
- `http-server.ts`: 4 new routes — `POST`/`GET /v1/billing/invoices`(`/:id`),
  `POST /v1/billing/invoices/:id/submit-tx` (mediaAuth-authenticated, a user-submitted-hash
  fallback if a webhook is ever missed), and the public `POST /v1/billing/webhooks/alchemy`
  (authenticated by HMAC signature, not a session — reads the _exact raw bytes_ via the
  existing `readBytes` helper so the signature check compares against precisely what Alchemy
  signed, never a re-serialized JSON.parse/stringify round trip). New
  `UsdcCheckoutError`/`UsdcLedgerError`/`CatalogError` → HTTP status branches in `respondError`.
  `usdcCheckout` is optional with a `DisabledUsdcCheckoutService` default, same safe-default
  shape as every other wave 4/5 option.
- `server.ts`: constructs the real `UsdcCheckoutService` only when _all five_ of pool, the
  Alchemy RPC credential, the webhook signing-key credential, and the owner-configured
  recipient/contract addresses are present — none are, in this worktree, so it always falls
  back to `DisabledUsdcCheckoutService`. `JOY_MEDIA_USDC_CHECKOUT_ENABLED` is read but never
  set here, independently gating checkout even if everything else were configured.

**Explicitly deferred (not silently dropped):**

- No `apps/editor-web` UI calls any of the 4 new routes — no checkout/payment UI exists yet.
- `UsdcInvoiceLedger.listForReconciliation`/`UsdcCheckoutService.listForReconciliation` exist
  and are tested but are **not wired to any HTTP route**: an operator-facing reconciliation
  view needs an admin-identity decision this repo has no established pattern for (media auth's
  allow-list has only an `enabled` boolean, no role field) — inventing one (e.g., hardcoding a
  specific email as "admin") would be presumptuous and is exactly the kind of decision this
  worktree defers to the owner, same as every other cross-cutting gate in this migration.
- No on-chain refund execution: `refundInvoice` only records that a refund happened by other
  means. Actually moving USDC back to a payer needs a signing wallet — explicitly out of scope
  per "do not read or print secrets" / no wallet key material handled anywhere in this repo.
- `alchemy-webhook.ts`'s `extractCandidateTxHashes` payload shape follows Alchemy's documented
  Address Activity schema as of this writing but **has not been checked against a real Alchemy
  webhook delivery** — this worktree has no Alchemy account/webhook to test against. This is
  a real gap, though a bounded one: every field the parser extracts is independently
  re-verified against the chain via RPC before anything is trusted, so a parser mismatch fails
  closed (no confirmation) rather than fails open.
- No periodic sweep calls `UsdcInvoiceLedger.expireStalePending()` — it exists, is tested, and
  is exactly the kind of thing a cron/scheduler would call, but no scheduler exists in this
  repo to wire it to.
- No `LoadCredentialEncrypted=` lines were added to `deploy/joy-media-api.override.conf` for
  the two new Alchemy credentials, for the same live-deploy-risk reason as wave 4's entitlement
  signing key (see that wave's entry) — Codex/the owner should add them together with actually
  provisioning the credentials.

**Commands run (this worktree):**

- `pnpm --filter @joy-media/api build` (`tsc -b`) → **passes**.
- `pnpm vitest run apps/api` → **548/548 passed** across 41 files (37 pre-existing skips
  unrelated to this wave); this wave added 94 net-new tests across 9 new files:
  `usdc-catalog.test.ts` (13), `usdc-confirmation.test.ts` (14), `alchemy-webhook.test.ts` (11),
  `alchemy-transport.test.ts` (10), `usdc-invoice-ledger.test.ts` (20, against real pg-mem
  SQL — including the partial-unique-index collision/retry path and the cross-invoice
  duplicate-evidence race), `usdc-checkout-service.test.ts` (14),
  `http-server-billing-routes.test.ts` (11), plus 1 new case in `postgres-migrations.test.ts`
  for migration 008. (`AccountApi` gained an `activateSubscription` method this wave — no new
  test needed since wave 4's `account-service.test.ts` already exercises the concrete
  implementation those new tests call through the interface.)
- `pnpm typecheck` (root, all 42 workspace projects) → **passes**.
- `pnpm lint` (root eslint) → **passes, 0 problems**.
- `pnpm format:check` (root prettier) → **same single pre-existing failure** as waves 1-4
  (`apps/editor-web/src/playback-loop-contract.test.ts`, unrelated, predates this worktree). All
  files this wave touched are prettier-clean.

**Known gap:** same running gap as waves 1-4 (no real Electron/OS session in this background
job) does not apply here — wave 5 is entirely `apps/api`, tested end-to-end against real SQL
via pg-mem. The gap specific to this wave is the untested-against-a-real-delivery webhook
payload parser noted above, and that `AlchemyJsonRpcTransport`/`observeTransferFromReceipt`
have never been run against a real Ethereum RPC endpoint (only against fakes/canned receipts) —
both are inherent to having no Alchemy account or live-wallet access in this worktree, which is
precisely the "live-wallet test gate" the locked owner decision requires before checkout is
ever enabled.

**Next gate:** wave 6 (archive/cutover guards) can proceed — it does not depend on wave 5's
USDC pieces going live. Before USDC checkout is ever enabled in production: (1) owner-verified
recipient/contract addresses and Alchemy credentials must be provisioned exactly as wave 4's
entitlement key was (systemd `LoadCredentialEncrypted=`, added together with the deploy-config
line), (2) real USD prices must replace the `$0.00` placeholders, (3) the webhook payload
parser must be validated against a real Alchemy delivery, (4) the "live-wallet test gate" from
the locked owner decision must actually be recorded by the owner/Codex before
`JOY_MEDIA_USDC_CHECKOUT_ENABLED=true` is ever set anywhere.

---

## Wave 6 — Archive/cutover guards (COMPLETE for the tooling/runbook surface; live wiring deferred)

**Commit:** see `git log` for the commit adding `tooling/archive/**`,
`apps/api/src/legacy-editor-retirement.ts`, `deploy/joy-media-cutover-nginx-boundary.md`, and
`docs/joy-media-final-migration-backup-restore-runbook.md` (wave 6 commit, after the wave 5
commit).

**What was done:**

- `tooling/archive` (new package, registered in root `tsconfig.json` references like
  `tooling/golden-render`/`tooling/benchmark` — unlike `tooling/release`, which has no
  `package.json` and is not typechecked by `pnpm typecheck`, this package deliberately follows
  the "real package" convention for full `tsc -b` coverage):
  - `manifest.ts` — `buildManifest`/`verifyManifest`: per-entry SHA-256 plus a top-level
    `manifestChecksum` over the sorted (name, checksum, length) triples, so the manifest itself
    can be checked for tampering independently of re-hashing every entry.
  - `encryption.ts` — AES-256-GCM (`node:crypto`), a fresh random key per export returned to
    the caller and never persisted by this package. Tested that a wrong key or tampered
    ciphertext both fail the same way (GCM's auth tag makes them indistinguishable by design).
  - `archive-export.ts` — `exportOwnerArchive(ownerId, source)`: builds one owner's project
    documents + media assets into a manifest + encrypted bundle. `ProjectArchiveSource` is
    dependency-injected — this package never opens a database connection. A display-name
    sanitizer strips path separators and `..` sequences so a media asset's name can never
    escape its `media/<projectId>/` namespace (tested with a literal `../../etc/passwd` input).
  - `archive-import.ts` — `importOwnerArchive(encrypted, keyBase64)`: the "clear import
    boundary" the locked decision requires — decrypts, then verifies every checksum before
    returning anything. Tested that a tampered _plaintext_ (re-encrypted with the same, correct
    key) is caught by the manifest-checksum check specifically, independent of the
    ciphertext-authenticity check already covered by `encryption.test.ts`.
  - `integrity-verification.ts` — `verifyNoDataLoss(manifest, expectedProjectCount)`: compares
    against an independently-supplied count, never the archive's own entries, so a source query
    that silently dropped rows is still caught.
  - 38 tests total, all passing against real `node:crypto`, no mocks for the crypto layer.
- `apps/api/src/legacy-editor-retirement.ts`: a single coarse kill switch
  (`JOY_MEDIA_LEGACY_EDITOR_RETIRED`, default `false`) distinct from wave 4's per-route
  `hosted-route-retirement.ts` — when true, the legacy `authentication.authenticate` every
  project/worker/job route in `http-server.ts` requires always returns `undefined`, the same
  way it already behaves today when `durableControlPlane` is unconfigured. Wired into
  `server.ts`; never set in this worktree.
- `deploy/joy-media-cutover-nginx-boundary.md`: a proposal (explicitly marked as such, not
  applied) for the target `joyst.ir` Nginx boundary once the desktop app is primary — narrows
  the served static site and the proxied `/v1/*` prefix from "everything" to
  auth/devices/account/entitlements/releases/billing only. Includes an explicit sequencing
  section (application-level retirement flags first, archive exports before any route
  narrows, Nginx narrowing last, as defense-in-depth on top of the flags — not a replacement).
  The existing `deploy/joy-media.nginx.conf` (documents the _current_ live config) was **not**
  touched.
- `docs/joy-media-final-migration-backup-restore-runbook.md`: documents `pg_dump`/`pg_restore`
  procedures (none of which already existed in this repo — only a one-line reminder in
  `deploy/README.md`), a per-owner archive-export cutover checklist built on `tooling/archive`,
  a no-data-loss verification checklist, and a rollback decision tree that explicitly defers to
  the existing, already-tested `deploy/joy-media-rollback.sh` for release-level rollback rather
  than duplicating it — this runbook only fills the two gaps that didn't already have one
  (database backup/restore, per-owner data archival).

**Explicitly deferred (not silently dropped):**

- No `ProjectArchiveSource` implementation backed by the real
  `project-document-store.ts`/`private-object-store.ts` exists yet — `tooling/archive` only
  ever runs against a fake source in tests. Wiring it to production data (and deciding how an
  export is actually triggered and delivered to an owner — a route? a CLI an operator runs?) is
  explicitly left for a follow-up pass, so this worktree never opens a connection to the real
  database.
- No desktop-side import wiring: `importOwnerArchive` exists and is tested, but nothing in
  `apps/desktop` calls it yet (same "SqliteProjectStore not wired into `electron-entry.ts`"
  boundary noted in the wave 2 entry — general project open/save IPC has to land first).
- `deploy/joy-media-cutover-nginx-boundary.md` is a proposal only; `joy-media.nginx.conf` (the
  live-config mirror) was not edited.
- No `pg_dump`/`pg_restore` command in the new runbook has actually been run — this worktree
  has no VPS access; the runbook is written for Codex/the owner to execute.

**Commands run (this worktree):**

- `pnpm --filter @joy-media/archive build` (`tsc -b`) → **passes**.
- `pnpm --filter @joy-media/api build` (`tsc -b`) → **passes**.
- `pnpm vitest run apps/api tooling/archive` → **588/588 passed** across 47 files (37
  pre-existing skips unrelated to this wave); this wave added 40 net-new tests: `manifest.test.ts`
  (11), `encryption.test.ts` (9), `archive-export.test.ts` (7), `archive-import.test.ts` (6),
  `integrity-verification.test.ts` (5) in `tooling/archive`, plus `legacy-editor-retirement.test.ts`
  (2) in `apps/api`.
- `pnpm typecheck` (root, all 43 workspace projects — `tooling/archive` added to the graph) →
  **passes**.
- `pnpm lint` (root eslint) → **passes, 0 problems** (one `no-control-regex` violation from a
  literal `�-` character-class regex was caught and rewritten as an explicit
  char-code filter during this wave).
- `pnpm format:check` (root prettier) → **same single pre-existing failure** as waves 1-5
  (`apps/editor-web/src/playback-loop-contract.test.ts`, unrelated, predates this worktree). All
  files this wave touched are prettier-clean.

**Known gap:** same as every prior `apps/api`-only wave — no live VPS/database access from this
session, so nothing in the new runbook or the `tooling/archive` package's eventual real-data
wiring has been exercised against production. The crypto/manifest/state-machine logic itself
(the part this worktree _can_ verify) is tested thoroughly; the "does this actually work against
a real `joymedia` database and a real owner's hosted projects" question is explicitly for
Codex/the owner to answer per the new runbook.

**Next gate:** wave 7 (packaging/release) can proceed — it does not depend on wave 6's runbook
being executed. Before any archive/cutover step is taken for real: the wave 6 runbook's §5
no-data-loss checklist should be followed exactly, starting with a fresh `pg_dump`.

---

## Wave 7 — Signed packaging/update evidence (IMPLEMENTED SCAFFOLD; public release blocked)

**Implementation record:** Codex completed the bounded Wave 7 fallback after the Claude Code
provider session limit and a Kilo free-route worker was stopped when its enforced isolation
policy mis-resolved the worktree path. The Kilo session was real (`ses_f5f9bd6aeffeUveXzRlgZGRPZv`,
resolved `poolside/laguna-s-2.1:free`) but produced no source diff; no Kilo implementation is
claimed. The fallback is committed and pushed as `96ecfbf1` (`feat: wave 7 signed release and
updater scaffolding`) on `codex/joy-media-final-migration-20260914`.

**What was done:**

- `apps/api/src/release-signing.ts` now has focused Ed25519 signing/verification coverage,
  credential-file lookup coverage, and the separate `release-publish.ts` adapter that signs the
  exact stored payload before calling the existing private metadata API. Missing signing material
  fails closed.
- `apps/desktop/src/main/auto-update-policy.ts` is a pure, network-free gate: active
  subscription, pinned public key, Ed25519 signature, HTTPS allowlisted `joyst.ir` host, SHA-256,
  semver, downgrade, minimum-version, and opt-in download checks are all explicit. It never
  fetches or installs an artifact itself.
- `apps/desktop/scripts/package-release.mjs` and `package:release` emit a blocked release plan
  unless owner-provided signing/toolchain gates are present; `package:dev` remains the only
  unsigned local package path.
- Wave 6 archive verification now checks top-level byte totals and normalizes malformed manifest/
  entry shapes through `ArchiveImportError` before any bytes are trusted.

**Explicit gates remain:** no real Electron window or packaged renderer smoke; no electron-builder
or equivalent owner-approved packaging toolchain; no Windows code-signing certificate; no pinned
production release public key; no public installer, release metadata publication, VPS mutation,
route retirement, payment activation, database migration, or deployment. CI is intentionally not
run per owner instruction; focused tests/builds are the only verification for this fallback.

**Verification recorded for `96ecfbf1`:** the five touched test files passed `29/29`; API,
desktop, and archive TypeScript builds passed; `package:dev` wrote the unsigned development
manifest; and `package:release` intentionally exited `2` after writing a blocked release plan.

---

## Wave 8 — Fresh Sonnet 5 audit of wave 7 (COMPLETE for the gaps found; no deploy/signing/secrets)

**Context:** a new Sonnet 5 session (after the prior session's usage limit reset) re-audited the
committed wave 7 scaffold (`0c909c61`) end-to-end before treating it as done, per the standing
instruction to do a substantive review rather than take the prior session's "IMPLEMENTED
SCAFFOLD" framing at face value. This wave is code-only: no deploy, VPS/joyst.ir change, secret
access, payment activation, production data migration, or signed release was performed or
attempted.

**Baseline established before any change (this worktree, this session):**

- `pnpm typecheck` (root, `tsc -b`) → **passes**, before and after.
- `pnpm vitest run apps/api apps/desktop tooling/archive` → **684/684 passed** (baseline, before
  this wave's new tests).
- `pnpm lint` (root eslint) → **failed**, 4 errors, all `no-undef 'process' is not defined` in
  `apps/desktop/scripts/package-release.mjs` (see finding 3 below). Confirmed pre-existing (not
  introduced by this session) by stashing this session's own working changes and re-running
  lint against the untouched `0c909c61` tree — identical 4 errors.
- `pnpm format:check` (root prettier) → **failed** on 6 files beyond the one pre-existing,
  unrelated failure every prior wave's entry records (`playback-loop-contract.test.ts`): every
  file wave 7 (`0c909c61`) itself touched or added —
  `apps/api/src/release-signing.ts`, `apps/desktop/scripts/package-release.mjs`,
  `apps/desktop/src/main/auto-update-policy.ts` and its test,
  `tooling/archive/src/archive-import.ts`. Wave 7's own progress-log entry never records a
  `pnpm lint` or `pnpm format:check` run at all — both were apparently never actually run before
  that commit, unlike every wave before it.

**Findings (substantive review of wave 7's actual wiring, not just its tests):**

1. **`createReleasePublisher` (`apps/api/src/release-publish.ts`) had zero callers anywhere in
   the repository outside its own unit test.** `grep -rl 'release-publish\|createReleasePublisher'`
   across the whole repo (excluding `dist/`) returned only `release-publish.ts` and
   `release-publish.test.ts`. `server.ts` never imports `release-signing.ts` or
   `release-publish.ts` at all. The wave 4/5 documented pattern ("not reachable from any route
   ... the wave 7 publish pipeline calls it directly") promised a direct-call path that did not
   exist — there was no way, even in principle, for a signed row to ever reach
   `release_metadata` short of writing ad hoc code. This is exactly the "release metadata API
   integration" gap named for this audit.
2. **`evaluateAutoUpdate` (`apps/desktop/src/main/auto-update-policy.ts`) had zero callers
   anywhere outside its own unit test.** `grep -rl 'evaluateAutoUpdate\|auto-update-policy'`
   under `apps/desktop/src` (excluding tests) returned only the module itself. No IPC channel,
   no `electron-entry.ts` wiring — the "desktop updater contract" was a correct, well-tested,
   pure function with no way for the running app to ever call it. This is the "desktop updater
   contract" gap named for this audit.
3. **`pnpm lint` was broken by wave 7's own new file.** `apps/desktop/scripts/package-release.mjs`
   uses `process.env`/`process.exitCode`, but `eslint.config.mjs`'s Node-globals override only
   matched `**/bin/**/*.{mjs,cjs,js}`, `tooling/**/*.mjs`, and `scripts/*.cjs` (root-level) — not
   `apps/*/scripts/*.mjs`, the pattern the sibling `package-dev.mjs` also lives under but never
   tripped this rule because it happens not to reference `process`. Root `pnpm lint` has been
   failing since `0c909c61` landed.
4. **`pnpm format:check` was broken by 6 of wave 7's own files** (listed above) — none were run
   through Prettier before that commit, unlike every prior wave's own stated verification step.
5. **Archive integrity (`tooling/archive`) re-reviewed independently:** `verifyManifest`'s
   wave-7-added `totalByteLength` check, `archive-import.ts`'s wave-7-added exhaustive shape
   guards (`isRecord`/`isArchiveManifestShape`, every `bundle.entries[]` member checked before
   `Buffer.from`), and the entry-count-before-index-access ordering were re-verified by hand for
   sound logic (no out-of-bounds access, no silently-accepted malformed shape) and found correct
   — no further changes made here beyond what wave 7 already landed. `manifest.ts`/
   `archive-import.ts`/`encryption.ts` still take a fake `ProjectArchiveSource` only in tests, as
   documented; that remains correctly out of scope (needs a real database connection this
   worktree does not have).

**What was done (fixes for findings 1-4; finding 5 needed no code change):**

- **Finding 1 fix:** added `apps/api/src/release-publish-cli.ts` — `parseReleasePublishInput`
  (validates an untrusted deserialized JSON value: non-empty `id`, `channel` is exactly
  `"stable"`/`"beta"`, non-empty `version`, `https://` `downloadUrl`, 64-hex-char `sha256`,
  optional string `minSupportedVersion` — fails closed on every other shape) and
  `runReleasePublish(raw, publisher)` (validates, then calls the injected `ReleasePublisher`).
  Added `apps/api/src/scripts/publish-release.ts`, a thin, deliberately untested wiring shell
  (same "tested logic / untested edge wiring" split as `server.ts` itself) that reads a release
  JSON file path from `process.argv`, refuses to run without both `JOY_MEDIA_DATABASE_URL` and
  the `joy-media-release-signing-key` systemd credential present, then constructs the real
  `ReleaseMetadataService`/`createEd25519ReleaseSigner`/`createReleasePublisher` chain and calls
  `runReleasePublish`. Wired as `pnpm --filter @joy-media/api release:publish <file>` in
  `apps/api/package.json`. **This worktree has neither a real database nor that credential, so
  this script has never been run, here or anywhere** — it exists so the publish pipeline has an
  actual caller instead of dead code with no path from a release artifact to a `release_metadata`
  row. No HTTP route was added — the locked "no public publish route" decision stands.
- **Finding 2 fix:** added `desktop.check-for-update` to `apps/desktop/src/ipc.ts`'s
  `IPC_CHANNELS` and the mirrored `apps/desktop/src/preload/ipc-channels.cjs` (the existing
  `preload.test.ts` drift guard catches any future mismatch). Added a `CheckForUpdate` injected
  dependency type and handler to `apps/desktop/src/main/ipc-handlers.ts`, with a payload parser
  (`asCheckForUpdateRequest`) that fails closed on any malformed manifest/payload shape without
  ever calling the injected function. Wired the real dependency in `electron-entry.ts`: the
  renderer is expected to fetch the `SignedReleaseManifest` itself from the existing public
  `GET /v1/releases/:channel` route and its own subscription state from the existing
  `GET /v1/account/subscription` route, then call this channel with
  `{manifest, subscriptionActive}`. The two pieces of trust material a compromised renderer must
  never be able to supply itself — the pinned release-signing public key
  (`JOY_MEDIA_RELEASE_SIGNING_PUBLIC_KEY`, a public key, not a secret) and the app's actual
  running version — are resolved only inside `electron-entry.ts` via `process.env` and
  `app.getVersion()`, never accepted from the IPC payload. `evaluateAutoUpdate` itself is
  unchanged; this only gives it a caller. Documented in a new "Auto-update policy check (wave 7)"
  section of `apps/desktop/README.md`, including that no renderer code calls it yet and that the
  channel always returns `release-key-unconfigured` today because
  `JOY_MEDIA_RELEASE_SIGNING_PUBLIC_KEY` is unset in every deployment.
- **Finding 3 fix:** extended `eslint.config.mjs`'s Node-globals override file list to include
  `apps/*/scripts/*.mjs`.
- **Finding 4 fix:** ran Prettier on exactly the 6 flagged pre-existing files plus this wave's
  own new/edited files; the pre-existing `playback-loop-contract.test.ts` failure was left
  untouched (confirmed via `git log -1 -- <file>` to predate this worktree, same as every prior
  wave's entry).

**Explicitly deferred (not silently dropped):**

- `desktop.check-for-update` still has no renderer-side caller — no UI shows an available
  update, downloads it, or installs it. That pipeline (progress UI, download, and where the
  installer handoff happens) is real follow-up work this channel only makes possible, exactly
  the same honesty pattern as every other wave's "substrate built, UI wiring deferred" note.
- `release:publish` has never been run against a real database or a real signing key in this or
  any session — provisioning both remains an owner/Codex ops action, same gate wave 4's
  entitlement-signing-key entry already names.
- No renderer/editor-web code was touched by this wave — this audit's fixes are entirely
  `apps/api`, `apps/desktop/src/main` and `apps/desktop/src/preload`, plus tooling config.

**Commands run (this worktree, this session):**

- `pnpm typecheck` (root, `tsc -b`) → **passes**, both before and after every change in this
  wave.
- `pnpm --filter @joy-media/desktop build` / `pnpm --filter @joy-media/api build` → **pass**.
- `pnpm --filter @joy-media/desktop test` → **90/90 passed** across 12 files (up from 88 tests
  before this wave's 2 new `ipc-handlers.test.ts` cases for `desktop.check-for-update`).
- `pnpm vitest run apps/api/src/release*` → **28/28 passed** (up from 14, this wave's new
  `release-publish-cli.test.ts` adds 14).
- `pnpm vitest run apps/api apps/desktop tooling/archive` → **700/700 passed** across 62 files (1
  pre-existing skip), up from the 684/684 baseline captured above.
- `pnpm vitest run` (whole repo, every workspace) → **4746/4746 passed, 38 skipped**, 0
  failures — a full-repo regression check this audit ran that no single prior wave's entry
  records at this scope.
- `pnpm lint` (root eslint) → **passes, 0 problems** (was 4 errors before finding 3's fix).
- `pnpm format:check` (root prettier) → **same single pre-existing failure** as every prior wave
  (`apps/editor-web/src/playback-loop-contract.test.ts`, confirmed to predate this worktree) —
  down from 7 failures (6 wave-7 files + that one) before finding 4's fix.
- `pnpm desktop:package` → succeeded, wrote the unsigned dev manifest, unchanged behavior.
- `pnpm --filter @joy-media/desktop package:release` → intentionally exited `2` after writing a
  blocked release plan, unchanged behavior (still no certificate, still no public key
  configured in this worktree).

**Next gate:** none required for further wave 8-adjacent work on `apps/desktop`/`apps/api`. The
running gates from every prior wave are unchanged by this audit: no real Electron window has
been opened in any session; `release:publish` needs a real database and the
`joy-media-release-signing-key` credential; `JOY_MEDIA_RELEASE_SIGNING_PUBLIC_KEY` needs to be
pinned in a real desktop build before `desktop.check-for-update` can ever return anything but
`release-key-unconfigured`; and the wave 1 runtime smoke test remains the prerequisite before
any of `apps/desktop`'s Electron wiring — old or new — is trusted end-to-end.

---

## Wave 9 — Real Electron runtime smoke test (COMPLETE)

**Context:** every prior wave's entry (0 through 8) names the same standing gap: no session had
ever actually launched `apps/desktop`'s Electron main process. `pnpm --filter @joy-media/desktop
test` only ever exercised the pure, injected-dependency modules under `src/main/**` — it never
imported `electron` itself, so `app.whenReady`, real `BrowserWindow` construction, and the real
`ipcMain.handle('joy-desktop-ipc', ...)` registration had zero evidence behind them. This wave
closes that gap with an automated, non-interactive runtime check instead of leaving it as a
manual "someone should open the app once" action item.

**What was done:**

- Added a `--smoke` branch to `apps/desktop/src/main/electron-entry.ts`, gated on
  `process.argv.includes('--smoke')`, checked once at module load. Inside the existing
  `app.whenReady().then(...)` callback (unchanged otherwise — same window/session/protocol
  wiring every other launch path goes through):
  - The `BrowserWindow` is constructed with `show: false` instead of the default visible
    window — same secure `webPreferences` (`buildSecureWebPreferences`), same
    `loadURL(resolveRendererTarget(isDev))` call, same `setWindowOpenHandler` denial. Nothing
    about window security or wiring is skipped or mocked for smoke mode.
  - Logs `[joy-desktop] electron runtime smoke passed: app ready, window initialized, IPC
wired`. This claim is truthful, not aspirational, at the point it is logged:
    `ipcMain.handle('joy-desktop-ipc', ...)` is registered unconditionally earlier in this same
    module, before the `--smoke` check even exists in the file, so by the time this line runs
    the app is ready, the window is constructed, and IPC is wired.
  - Calls `app.quit()` after a 300ms `setTimeout`, giving the log line time to flush to stdout
    before the process exits, then exits on its own — no manual Cmd+Q, no test harness needed
    to kill the process.
  - Updated this file's top-of-file doc comment, which previously pointed here (at "the wave 1
    smoke-test gap") as the reason the file had no test coverage; it now describes what
    `test:smoke` does and does not prove instead.
- Added `"test:smoke": "electron . --smoke"` to `apps/desktop/package.json`'s `scripts`,
  alongside the existing `dev:electron` (`electron .`) — both run the built `dist/main/
electron-entry.js` `main` entry, so `pnpm --filter @joy-media/desktop build` must precede
  either.

**What this proves, and what it still doesn't:**

- Proves, with a real Electron binary and a real exit code, that `app.whenReady()` resolves,
  `BrowserWindow` construction with this app's real secure `webPreferences` does not throw, and
  `ipcMain.handle` registration succeeds — the three things every prior wave's entry could only
  claim from unit tests of the pure modules feeding into this file, never from the file itself.
- Does **not** prove the renderer actually loads and paints (the window is never shown and
  `loadURL`'s result is never awaited, matching the pre-existing `void win.loadURL(...)` in the
  non-smoke path), that a real `joy-desktop-ipc` round trip from a loaded renderer succeeds, or
  that packaging/signing (wave 7) produces a launchable artifact. Those remain open, same as
  every prior wave's entry already said.

**Commands run (this worktree, this session):**

- `pnpm --filter @joy-media/desktop build` (`tsc -b`) → **passes**.
- `pnpm --filter @joy-media/desktop test` → **90/90 passed** across 12 files, unchanged from
  wave 8 — this wave adds no new unit tests, since the smoke path only exists to be run under a
  real Electron binary, not `vitest`'s Node process.
- `pnpm --filter @joy-media/desktop test:smoke` (equivalently `pnpm exec electron . --smoke`
  from `apps/desktop`) → printed exactly `[joy-desktop] electron runtime smoke passed: app
ready, window initialized, IPC wired` and exited `0` on its own, twice (once invoked directly
  via `pnpm exec electron . --smoke`, once via the `pnpm run test:smoke` script itself) — the
  first real Electron window construction and clean exit in this project's history.
- `pnpm typecheck` (root, `tsc -b`) → **passes**.

**Next gate:** none for `apps/desktop` main-process wiring. The packaging/signing gates from
wave 7/8 (certificate, `JOY_MEDIA_RELEASE_SIGNING_PUBLIC_KEY`, `release:publish` credentials)
are unchanged by this wave.

---

## Wave 10 — editor-web typed `window.joyDesktop` client (COMPLETE)

**Context:** `apps/editor-web` had no code at all that referenced `window.joyDesktop` — the
bridge `preload.cjs` installs only exposes a generic, untyped `invoke(channel, payload)` plus
the raw channel list (see wave 1/7 entries above). Anything in the editor that needs to detect
the desktop host, read Worker status, prompt a native file picker, or check for an update would
otherwise have had to call that untyped `invoke` directly, one channel string at a time, with no
shared request/response types and no test coverage.

**What was done:**

- Added `apps/editor-web/src/desktop-client.ts`: typed wrappers around `window.joyDesktop`,
  covering the four use cases that exist today —
  - `isDesktopHost()` — `typeof window !== 'undefined' && window.joyDesktop !== undefined`; safe
    to call from any environment, including one with no `window` at all.
  - `selectDesktopFile()` — wraps `desktop.select-file`; resolves to a typed
    `DesktopFileSelection` (mirrors `apps/desktop/src/file-boundary.ts`'s `OpaqueFileRef`) or
    `undefined` if the user cancels the native dialog.
  - `getDesktopWorkerStatus()` — wraps `desktop.worker-status`; resolves to a typed
    `DesktopWorkerStatus` (mirrors `apps/desktop/src/worker-status.ts`'s `WorkerStatus`).
  - `checkForDesktopUpdate(request)` — wraps `desktop.check-for-update`; takes a
    `DesktopUpdateCheckRequest` (the manifest the caller already fetched from the existing
    public `GET /v1/releases/:channel` route, plus the caller's own subscription state) and
    resolves to a typed `DesktopUpdateDecision` (mirrors `apps/desktop/src/main/
auto-update-policy.ts`'s `AutoUpdateDecision`). Does not fetch the manifest itself and
    cannot download or install anything — the pinned signing key and running version stay
    main-process-only, unchanged from wave 7/8.
  - All four throw or reject with `'joy-desktop bridge is unavailable outside the desktop
host'` if called outside the desktop shell, rather than silently returning `undefined` data
    or throwing a raw `TypeError` on `window.joyDesktop` being `undefined`.
  - `apps/desktop` is a sibling app, not a workspace package, so this module never imports from
    it — every mirrored type is redeclared locally, with a doc comment pointing at the
    `apps/desktop` source of truth it mirrors, the same pattern `apps/desktop/src/main/
ipc-handlers.ts` already uses for its own request/response shape guards.
- Added `apps/editor-web/src/desktop-client.test.ts` (`@vitest-environment jsdom`, the same
  per-file pragma `html-scene-browser-host.test.ts` already uses to get a real mutable
  `window`): 9 tests covering both the "outside the desktop host" rejection path and the
  "bridge present" path (mocked `invoke`) for all three async helpers, plus `isDesktopHost`'s
  two states. Each test restores `window.joyDesktop` to absent in `afterEach` so no test's mock
  bridge leaks into the next.

**Commands run (this worktree, this session):**

- `pnpm vitest run apps/editor-web/src/desktop-client.test.ts` → **9/9 passed**.
- `pnpm --filter @joy-media/editor-web test` → **288 files / 1680 tests passed** (up from 287
  files / 1671 tests before this wave's one new test file — no other editor-web test changed).
- `pnpm typecheck` (root, `tsc -b`) → **passes**, both before and after this wave's change.

**Explicitly deferred (not silently dropped):**

- No panel or UI component calls any of these four helpers yet — same "substrate built, UI
  wiring deferred" pattern as wave 7's `desktop.check-for-update` entry above. Nothing in the
  editor currently shows desktop-host-only affordances (a native file picker button, a Worker
  status indicator, an update banner).
- `checkForDesktopUpdate` still has no caller that fetches a manifest from
  `GET /v1/releases/:channel` or reads `GET /v1/account/subscription` — that wiring, and where
  an "update available" UI would render, remains open.

**Next gate:** none required for further `apps/editor-web`/`apps/desktop` work. Building actual
UI on top of `desktop-client.ts` (file-picker button, Worker status indicator, update banner) is
real follow-up work this wave only makes possible.
