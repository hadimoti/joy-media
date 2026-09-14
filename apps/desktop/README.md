# JOY Media desktop shell

This package is the desktop host for JOY Media: a real Electron main/preload bootstrap
(wave 1) plus a local SQLite-backed runtime (wave 2) of the final migration, built on top of
a dependency-free policy contract. It deliberately does not contain editor, timeline,
rendering, or agent logic: those remain in `apps/editor-web` and shared packages.

## Layout

- `src/origin-policy.ts`, `src/ipc.ts`, `src/file-boundary.ts`, `src/worker-status.ts`,
  `src/deep-link.ts` — the host-neutral policy contract (unchanged from the pre-wave-1
  milestone; still exported as a library via `src/index.ts`).
- `src/main/` — the Electron main process, split into small, dependency-injected, unit-tested
  modules (`file-registry.ts`, `worker-supervisor.ts`, `ipc-handlers.ts`, `window.ts`,
  `shutdown.ts`, `media-checksum.ts`) plus the thin, untested wiring entry
  `electron-entry.ts` that imports the real `electron` module and calls into them. Business
  logic belongs in the testable modules, never in `electron-entry.ts`.
- `src/store/` — the desktop-only local runtime database (wave 2): `paths.ts` resolves the
  per-user database file and media root under Electron's `userData` directory (pure — the
  caller passes that path in, so it's testable without Electron), and `local-database.ts`
  wraps a `node:sqlite` connection for the media manifest and the Worker job queue. Reachable
  only from `apps/desktop`'s main process, never the renderer or `apps/editor-web`'s bundle.
- `src/preload/` — the `contextBridge` preload script. It is hand-written CommonJS
  (`preload.cjs`), not compiled by `tsc`: sandboxed-preload ESM support is still
  version/platform-dependent, and this is the single most security-critical file in the
  package, so it stays out of the NodeNext ESM build entirely. `ipc-channels.cjs` holds the
  shared, electron-free channel allow-list so both `preload.cjs` and `preload.test.ts` can use
  it without loading the real `electron` module outside an Electron process.

## Local runtime (wave 2)

- **Project store:** `@joy-media/project-persistence`'s `desktop` subpath now also exports
  `SqliteProjectStore`, a `node:sqlite`-backed implementation of the same `ProjectStore<P,T>`
  contract `JsonFileProjectStore` already implements (see that package's README/tests). It is
  **not yet constructed in `electron-entry.ts`**: no IPC channel opens or saves a project
  through it yet, so wiring it in today would be dead code. That wiring — plus the renderer-side
  decision of when `apps/editor-web` uses the desktop store instead of its current browser
  store — is explicitly deferred, not silently dropped (see the progress log).
- **Media manifest:** `desktop.select-file` now probes the chosen file (streaming SHA-256 +
  extension-based kind classification, `main/media-checksum.ts`) and records it into
  `LocalDatabase`'s `media_manifest` table, keyed by the same opaque ref id `file-registry.ts`
  mints. `desktop.revoke-file` removes the manifest entry along with the ref. This is a
  best-effort local record, not the Worker's real probe (demux/codec/duration) — the Worker
  remains the authority on that per the Boundaries section below.
- **Worker job queue:** `desktop.request-derivative` now enqueues a `queued` row in
  `LocalDatabase`'s `jobs` table (via `enqueueJob`) and returns its id alongside the existing
  approval token. Two new IPC channels poll and cancel it: `desktop.job-status` (payload
  `{ jobId }`) and `desktop.cancel-job` (payload `{ jobId }`, refuses to cancel an
  already-finished job). **Actually dispatching a queued job to the Worker child process and
  transitioning it through `running`/`done`/`failed` is not implemented yet** — that needs the
  real `@joy-media/job-protocol` wire format between the desktop host and the Worker, which is
  future work; today a job sits `queued` until cancelled or the app restarts.
- **Crash recovery:** `electron-entry.ts` calls `LocalDatabase.recoverInterrupted()` once at
  startup, before any new job can be enqueued. Any job still `queued`/`running` from a process
  that didn't shut down cleanly is marked `cancelled` with `error: "interrupted by shutdown"` —
  the Worker that would have finished it is gone, so silently resuming is never safe.
- **Shutdown:** `LocalDatabase.close()` now runs inside `main/shutdown.ts`'s flush step, after
  the Worker is stopped, on every shutdown path (`before-quit`, `window-all-closed`, `SIGINT`,
  `SIGTERM`).

## Boundaries

- **Editor origin:** only the configured JOY production origin and explicit loopback development origins may request the bridge. Unknown origins are rejected before IPC dispatch.
- **IPC:** only the versioned channels in `src/ipc.ts` are exposed. Requests carry opaque IDs and structured data; there is no arbitrary command, shell, or path channel. `ipc-handlers.ts`'s `dispatchIpcRequest` re-validates origin + channel on every call before a handler ever runs.
- **Files:** native selection is represented by an opaque `local-file` reference. The raw path never crosses the renderer boundary — `main/file-registry.ts` is the only place the real path is resolvable, and only from main-process code (Worker supervision, media ingest), never from preload or the renderer. Derivatives must be explicitly requested by reference and kind.
- **Deep links:** only `joy://open/project/<UUID>` is accepted. Credentials, arbitrary hosts, and arbitrary paths are rejected.
- **Worker:** `main/worker-supervisor.ts` supervises the Worker as a child process (spawn, crash-restart with a cap, graceful SIGTERM/SIGKILL stop) and reports lifecycle/status and startup preference only. The Worker remains the owner of probing, hashing, and derivative generation; project mutation stays in the editor command path. Wave 2 adds a local job queue (see below) that tracks a derivative request's lifecycle; it does not yet dispatch that job to the Worker over a real protocol.
- **Window:** `BrowserWindow` is created with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `webviewTag: false` (`main/window.ts`'s `buildSecureWebPreferences`), a denied `setWindowOpenHandler`, and a denied default permission-request handler. The packaged renderer loads from a privileged custom scheme (`joy-media-app://renderer/`) rather than `file://`, so it keeps a normal secure-context origin; dev loads the Vite dev server at `http://localhost:5173`, which is in the `origin-policy.ts` allow-list.
- **Shutdown:** `main/shutdown.ts` stops the Worker before flushing pending state on `before-quit`, `window-all-closed`, `SIGINT`, and `SIGTERM`, and is idempotent if multiple signals arrive.

## Known gap: no runtime smoke test yet

Everything above is unit-tested with the real `electron` module's APIs mocked out via
dependency injection — see `src/main/*.test.ts` and `src/preload/preload.test.ts`. Nobody has
actually run `pnpm --filter @joy-media/desktop dev:electron` and opened a real window in this
worktree: this background session has no interactive display, and the `electron` package's own
binary download is gated by `pnpm-workspace.yaml`'s `allowBuilds` supply-chain allowlist (it
does not currently include `electron`). Add `electron: true` there (an explicit owner/Codex
decision, not something this package does for itself) and run a real smoke test before treating
wave 1 or wave 2 as done end-to-end.

## Commands

```text
pnpm --filter @joy-media/desktop test
pnpm --filter @joy-media/desktop build
pnpm --filter @joy-media/desktop dev:electron   # needs `electron` allow-built first, see above
pnpm desktop:package
```

`desktop:package` creates `apps/desktop/dist/joy-media-desktop-dev.json`, a deterministic package manifest containing the shell contract version, runtime requirements, and explicit `signing: blocked` metadata. A signed Windows installer requires a future owner-approved native runtime and certificate/tooling (wave 7).
