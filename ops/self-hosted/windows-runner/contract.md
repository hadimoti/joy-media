# JOY Media Windows self-hosted CI runner — container contract

This directory documents the **Windows-container** variant of the JOY Media
self-hosted CI runner image. It complements (and is intentionally narrower
than) `ops/self-hosted/linux-runner/`, which is the primary PC Docker
runner.

## Labels

The Windows-container image registers the runner with labels
`self-hosted`, `windows`, `x64`, `joy-media-ci` — the same shape as the
Linux container, so any future Windows-only step that does NOT need
host-level access can use the same pipeline.

The owner-controlled Windows self-hosted runner that JOY-Media's actual
release-candidate `windows-worker-clean` and `worker-package` jobs target
is the PRIMARY Windows runner with labels
`self-hosted`, `windows`, `x64`, `joy-media-worker`. That runner runs
DIRECTLY on the PC (not inside a Windows container), because the JOY
Media Worker acceptance fixture (`worker-acceptance.ps1`) needs
`Register-ScheduledTask` against the host's task scheduler and
`Win32_Process` enumeration — both of which are per-host and unavailable
from inside a `mcr.microsoft.com/windows/servercore` container.

## Build

The container build requires Docker Desktop on the owner's PC with the
**Windows-container** engine enabled:

```powershell
$env:Path = 'C:\Program Files\Docker\Docker\resources\bin;' + $env:Path
docker build --pull `
  --build-arg RUNNER_VERSION=2.337.0 `
  --tag joy-media-ci-windows:2.337.0 `
  ops/self-hosted/windows-runner
```

## Register (token never persisted)

```powershell
$registrationToken = gh api --method POST repos/hadimoti/joy-media/actions/runners/registration-token --jq .token

docker volume create joy-media-ci-windows-runner
docker run --rm `
  --name joy-media-ci-windows-register `
  -e RUNNER_TOKEN=$registrationToken `
  -e RUNNER_NAME=joy-media-ci-windows `
  -e RUNNER_LABELS=self-hosted,windows,x64,joy-media-ci `
  -v joy-media-ci-windows-runner:C:\actions-runner `
  joy-media-ci-windows:2.337.0 --configure-only
```

The long-running container is started **without** `RUNNER_TOKEN` so the
expired registration token is never retained:

```powershell
docker run -d `
  --name joy-media-ci-windows `
  --restart unless-stopped `
  -v joy-media-ci-windows-runner:C:\actions-runner `
  joy-media-ci-windows:2.337.0
```

## What this container CANNOT do

The Windows-container variant is intentionally not used for the JOY Media
release-candidate `windows-worker-clean` acceptance step. Server Core
containers cannot see the host's task scheduler or the host's
`Win32_Process` table; the Worker acceptance fixture needs both. Steps
that only need PowerShell + Node inside the container (for example,
running `pwsh -File scripts/build-worker-exe.ps1` to produce
`joy-worker.exe` without exercising the daemon loopback fixture) CAN
target this label; the release gate today does not require that.

## Windows-platform evidence caveat

The ONLY Windows acceptance evidence JOY-Media's release gates currently
consume is produced on `self-hosted,windows,x64,joy-media-worker` — the
owner-controlled Windows runner, NOT this Windows container. The
durable evidence emitted by that lane is tagged
`runner: "self-hosted,windows,x64,joy-media-worker"` and
`execution: "self-hosted-windows-worker"` so it can never be confused
with a Linux-container run, and the gate contract (`release:gate`)
binds those tags before it accepts `test-output/windows/acceptance.json`.

Any future contributor who points a job at a Windows-hosted label
(`windows-latest`) will fail the offline runner-policy test in
`tooling/release/src/ci-runner-policy.test.ts` before a CI minute is
consumed.
