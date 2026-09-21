# JOY Media Windows self-hosted CI runner — container contract

This directory documents the Windows-container runner for JOY Media private
CI. Docker Desktop on the owner-controlled PC is the execution boundary;
GitHub is the workflow and control plane only.

## Required labels

The runner must register with this exact comma-separated label list:

`self-hosted,windows,x64,joy-media-ci`

The release gate rejects host-direct Windows labels, Linux portable evidence,
missing labels, and evidence from any other runner.

## Build

The Docker Desktop engine must be switched to Windows containers before the
build. Run from the repository root:

```powershell
docker build --pull `
  --file ops/self-hosted/windows-runner/Dockerfile.windows `
  --build-arg RUNNER_VERSION=2.337.0 `
  --tag joy-media-ci-windows:2.337.0 `
  ops/self-hosted/windows-runner
```

The image build validates Chocolatey before using it, verifies the pinned
Node and Actions Runner SHA-256 values, and leaves Node at `C:\node\node.exe`
with Corepack at `C:\node\corepack.cmd`.

## Register (token never persisted)

Registration tokens are short-lived and are supplied only to the one-shot
configuration container:

```powershell
$registrationToken = gh api --method POST repos/hadimoti/joy-media/actions/runners/registration-token --jq .token

docker volume create joy-media-ci-windows-runner
docker run --rm `
  --name joy-media-ci-windows-register `
  -e RUNNER_TOKEN=$registrationToken `
  -e RUNNER_NAME=joy-media-ci-windows `
  -e RUNNER_LABELS=self-hosted,windows,x64,joy-media-ci `
  -v joy-media-ci-windows-runner:C:\actions-runner `
  joy-media-ci-windows:2.337.0 -ConfigureOnly
```

The long-running container is started without `RUNNER_TOKEN`:

```powershell
docker run -d `
  --name joy-media-ci-windows `
  --restart unless-stopped `
  -v joy-media-ci-windows-runner:C:\actions-runner `
  joy-media-ci-windows:2.337.0
```

The entrypoint removes the token from its process environment after
registration and never writes it to the image, runner work directory, logs,
or durable evidence.

## Container-local acceptance boundary

The Windows acceptance fixture must inspect only processes, files, and
lifecycle events created inside this container. It must not call the host task
scheduler or host process table. Any fixture that still requires host-only
APIs is incomplete and keeps the release gate red until it is ported to a
container-local contract.

Accepted evidence must include the exact candidate SHA, workflow run and
attempt, exact runner label, immutable container ID and image digest,
container-local startup/hello/lease/notification-clear/termination lifecycle,
source provenance, and a verified Windows platform marker. The gate rejects
missing, stale, mismatched, host-direct, portable, or legacy evidence.

## Runtime blocker policy

This contract does not invent runtime evidence. Until Docker Desktop Windows
engine can build the image, register the runner, execute the container-local
fixture, and produce exact-candidate evidence, the release gate remains red.
