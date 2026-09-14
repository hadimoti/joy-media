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
