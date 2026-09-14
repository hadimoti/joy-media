# JOY Media desktop shell

This package is the desktop host for JOY Media: a real Electron main/preload bootstrap
(wave 1 of the final migration) built on top of a dependency-free policy contract. It
deliberately does not contain editor, timeline, rendering, or agent logic: those remain in
`apps/editor-web` and shared packages.

## Layout

- `src/origin-policy.ts`, `src/ipc.ts`, `src/file-boundary.ts`, `src/worker-status.ts`,
  `src/deep-link.ts` — the host-neutral policy contract (unchanged from the pre-wave-1
  milestone; still exported as a library via `src/index.ts`).
- `src/main/` — the Electron main process, split into small, dependency-injected, unit-tested
  modules (`file-registry.ts`, `worker-supervisor.ts`, `ipc-handlers.ts`, `window.ts`,
  `shutdown.ts`) plus the thin, untested wiring entry `electron-entry.ts` that imports the
  real `electron` module and calls into them. Business logic belongs in the testable modules,
  never in `electron-entry.ts`.
- `src/preload/` — the `contextBridge` preload script. It is hand-written CommonJS
  (`preload.cjs`), not compiled by `tsc`: sandboxed-preload ESM support is still
  version/platform-dependent, and this is the single most security-critical file in the
  package, so it stays out of the NodeNext ESM build entirely. `ipc-channels.cjs` holds the
  shared, electron-free channel allow-list so both `preload.cjs` and `preload.test.ts` can use
  it without loading the real `electron` module outside an Electron process.

## Boundaries

- **Editor origin:** only the configured JOY production origin and explicit loopback development origins may request the bridge. Unknown origins are rejected before IPC dispatch.
- **IPC:** only the versioned channels in `src/ipc.ts` are exposed. Requests carry opaque IDs and structured data; there is no arbitrary command, shell, or path channel. `ipc-handlers.ts`'s `dispatchIpcRequest` re-validates origin + channel on every call before a handler ever runs.
- **Files:** native selection is represented by an opaque `local-file` reference. The raw path never crosses the renderer boundary — `main/file-registry.ts` is the only place the real path is resolvable, and only from main-process code (Worker supervision, media ingest), never from preload or the renderer. Derivatives must be explicitly requested by reference and kind.
- **Deep links:** only `joy://open/project/<UUID>` is accepted. Credentials, arbitrary hosts, and arbitrary paths are rejected.
- **Worker:** `main/worker-supervisor.ts` supervises the Worker as a child process (spawn, crash-restart with a cap, graceful SIGTERM/SIGKILL stop) and reports lifecycle/status and startup preference only. The Worker remains the owner of probing, hashing, and derivative generation; project mutation stays in the editor command path. Wave 2 wires the actual job protocol through this supervisor.
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
wave 1 as done end-to-end.

## Commands

```text
pnpm --filter @joy-media/desktop test
pnpm --filter @joy-media/desktop build
pnpm --filter @joy-media/desktop dev:electron   # needs `electron` allow-built first, see above
pnpm desktop:package
```

`desktop:package` creates `apps/desktop/dist/joy-media-desktop-dev.json`, a deterministic package manifest containing the shell contract version, runtime requirements, and explicit `signing: blocked` metadata. A signed Windows installer requires a future owner-approved native runtime and certificate/tooling (wave 7).
