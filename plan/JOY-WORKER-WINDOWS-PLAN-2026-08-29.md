# JOY Worker — Windows executable and headless startup plan

## Objective

Run the local GPU Worker like a Windows background application while keeping
JOY Studio in the browser. After one local install and owner pairing, opening
`https://www.joyst.ir/` should discover the Worker through the authenticated
JOY control plane without requiring a desktop shell window.

## Architecture (accepted)

```text
JOY Studio (browser)
        │ authenticated HTTPS control-plane calls
        ▼
JOY Media API (VPS)
        ▲ outbound Worker session / leases / heartbeats
        │
joy-worker.exe (Windows, hidden at logon)
        │
        ├─ local GPU / WebGL preview
        ├─ FFmpeg and typed media adapters
        ├─ ComfyUI / local AI adapters when configured
        └─ local files addressed only by opaque asset IDs
```

The Worker is not a browser tab, Service Worker, or arbitrary command shell.
The browser cannot launch a local process by opening a URL; Windows Task
Scheduler is the supported installation boundary.

## Implemented tranche

- `scripts/worker-sea-bootstrap.cjs` is a dependency-free SEA bootstrap. It
  launches the audited `apps/worker/dist/index.js`, inherits safe Worker
  environment settings, redirects output to the private Worker log, and has a
  `--joy-worker-self-test` mode.
- `scripts/build-worker-exe.ps1` produces `apps/worker/bin/joy-worker.exe` with
  Node 22 SEA + pinned `postject@1.0.0-alpha.6`; the generated `bin` directory
  is ignored because it is a platform artifact.
- `scripts/install-worker-autostart.ps1` builds the executable if needed and
  installs/updates the hidden `JOY Media Local Worker` AtLogOn task with
  `StartWhenAvailable`, one-minute restart recovery, and limited interactive
  user scope.
- `scripts/run-worker-headless.ps1` remains a portable fallback and launches
  the executable when present, otherwise the audited Node entrypoint.
- `run-worker.bat` prefers the executable while retaining the Node fallback.

## Safety and notification contract

1. Pairing remains owner-approved and one-time. No browser page or startup task
   may silently pair a device or expose the pairing code.
2. The executable launches only the fixed Worker entrypoint. Worker jobs are
   typed/allowlisted; arbitrary `cmd`, PowerShell, or user-provided shell text
   is rejected.
3. If a future feature needs a local command approval, the JOY UI must create a
   visible notification/tab before dispatch and show pending, running, success,
   and failure states. Startup, reconnect, and health probes are supervisor
   actions and do not open a command tab.
4. Logs contain diagnostics only; they must never contain browser cookies,
   pairing secrets, local paths in API payloads, or media bytes.

## Verification gates

- Build: Worker TypeScript build and `pnpm worker:exe` self-test pass.
- Startup: Scheduled Task is `Running`, `Hidden`, `StartWhenAvailable`, and
  configured to restart after failure; the child process is `joy-worker.exe`.
- Runtime: pairing persistence/retry tests, Worker control-plane tests,
  typecheck, lint, and full test suite pass.
- Browser: the orchestrator alone rechecks the authenticated JOY page,
  Effects categories, Jobs/Worker panel, and 3D tab without a crash or console
  error. Sub-agents do not use browsers or OpenCLI.
- Release: commit/push the source, deploy the exact main SHA, verify both
  `joyst.ir` and `www.joyst.ir` origin health, and retain source-bound Worker
  delivery/inspection evidence before claiming final completion.

## Remaining owner-only gate

The executable and hidden startup are complete, but the current local Worker is
not paired and has no explicit opaque local-asset map. A real source-bound
lease → local processing → derivative upload → inspection → two Motion
placements journey still requires the owner to enter the one-time code in the
authenticated Pair panel (or explicitly authorize the orchestrator to do so).
Until that evidence and the 30-minute production canary exist, the release
gate must remain NO-GO.
