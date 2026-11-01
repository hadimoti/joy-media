# worker

> **Status:** local Worker that runs under the JOY Media desktop app. It runs verified
> thumbnail, AI text (through the desktop broker), audio, and professional masking derivative
> jobs. Local AI models (upscale, denoise, matting) are experimental, need separate model setup,
> and are not qualified in this release.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §26, §8.4 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Local/GPU worker daemon: probing, proxies, waveforms, FFmpeg, deterministic export, provider execution, resource governor.

**First built in part:** P00 (spike) then P01. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

The desktop app starts this Worker and supplies `JOY_MEDIA_API_URL=http://127.0.0.1:<port>`,
the loopback address of its local job API, and a per-run `JOY_MEDIA_WORKER_LOCAL_TOKEN`.
Any other control-plane address is refused before the Worker reads or writes state.
The state file at `~/.joy-media/worker-state.json` (override with `JOY_MEDIA_WORKER_STATE_PATH`)
keeps only the device identity. The per-run token lives in memory and is never written.
Older pairing fields in that file are ignored and kept. AI text jobs go through the desktop
broker, which holds the profile and the key. The Worker holds no provider key and reads no
provider file. The current fixture job writes a deterministic 1×1 PPM only in its private job
directory. The receipt carries a fixed SHA-256, never the local path or media bytes.

**Must not:** Editing project state without a validated job/command result; building shell strings from input.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.

## Masking models

See [`masking/README.md`](masking/README.md). Mask model paths and source media
paths remain Worker-only. The Worker advertises `mask.image` / `mask.video`
only when the matching runner is explicitly configured, and the control plane
leases work only when the source asset ID is present locally.

## Startup under the desktop app

The JOY Media desktop app starts the Worker when the app starts. No separate
install and no logon task are needed. The Worker runs while the desktop app is
open, because the app supplies both the job route and the per-run token. The
app restarts the Worker after an unexpected exit.

Earlier builds installed a hidden logon task named `JOY Media Local Worker`
that reconnected to a remote control plane. That task is no longer used.
Remove it once, in PowerShell:

```powershell
Unregister-ScheduledTask -TaskName 'JOY Media Local Worker' -Confirm:$false
```

`pnpm worker:exe` builds the native launcher, `joy-worker.exe`.
`run-worker.bat` and `scripts/run-worker-headless.ps1` are for a standalone run
from a checkout. They have no remote default. Set `JOY_MEDIA_API_URL` to
`http://127.0.0.1:<port>` and `JOY_MEDIA_WORKER_LOCAL_TOKEN` first. Otherwise
they stop with a clear message.

The executable never accepts arbitrary shell commands. It launches one fixed
Worker entrypoint and the Worker executes only typed, allowlisted job adapters.
Any future local-command approval must surface a user-visible notification in
the JOY UI before dispatch; Windows startup and health probes are background
supervisor work, not user-authored commands. If a future exceptional command
window is unavoidable, the application must explain it in a notification before
opening that window; ordinary startup and recovery never open CMD.
