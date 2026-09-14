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
