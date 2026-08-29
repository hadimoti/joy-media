# worker

> **Status:** paired outbound Worker with verified thumbnail, AI, audio, and
> professional masking derivative jobs.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §26, §8.4 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Local/GPU worker daemon: probing, proxies, waveforms, FFmpeg, deterministic export, provider execution, resource governor.

**First built in part:** P00 (spike) then P01. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

Set `JOY_MEDIA_API_URL` to run the daemon against the versioned API. On its
first run it prints a high-entropy pairing code; the signed-in owner approves
that code in the Media UI/API before the Worker can claim its token. The code
is retained until its five-minute offer expires, so restarting after approval
claims the same approved offer rather than replacing it. The local
state path defaults to `~/.joy-media/worker-state.json` and can be overridden
with `JOY_MEDIA_WORKER_STATE_PATH`. It contains only the device identity and
revocable Worker session—not a JOY browser login, media path, or project data.
The current fixture job writes a deterministic 1×1 PPM only in its private job
directory; the API receives and independently validates its fixed SHA-256
receipt, never the local path or media bytes.

**Must not:** Editing project state without a validated job/command result; building shell strings from input.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.

## Masking models

See [`masking/README.md`](masking/README.md). Mask model paths and source media
paths remain Worker-only. The Worker advertises `mask.image` / `mask.video`
only when the matching runner is explicitly configured, and the control plane
leases work only when the source asset ID is present locally.

## Windows headless startup

The Worker is a background process, not a browser extension. From a built
checkout, create the native `joy-worker.exe` launcher and install an idempotent
hidden Windows logon task with:

```powershell
pnpm worker:exe
powershell -NoProfile -File .\scripts\install-worker-autostart.ps1
```

`pnpm worker:exe` uses Node's single-executable application format. The
resulting executable is a small runtime launcher that starts the audited Worker
entrypoint with the local Node runtime, so Playwright/GPU and model
dependencies remain external and upgradeable. The task starts this executable
from the checkout with `https://joyst.ir/api`, keeps its device identity in
`%USERPROFILE%\.joy-media\worker-state.json`, restarts after an unexpected exit,
and writes diagnostics to `%USERPROFILE%\.joy-media\logs\worker.log`. The
installer builds the executable automatically when it is missing. The first
install still requires one owner-approved pairing code; after that, opening
`https://www.joyst.ir/` discovers the connected Worker automatically. Silent
pairing is intentionally not supported.

The executable never accepts arbitrary shell commands. It launches one fixed
Worker entrypoint and the Worker executes only typed, allowlisted job adapters.
Any future local-command approval must surface a user-visible notification in
the JOY UI before dispatch; Windows startup and health probes are background
supervisor work, not user-authored commands.
