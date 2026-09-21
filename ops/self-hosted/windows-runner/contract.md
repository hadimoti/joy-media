# JOY Media Windows Docker runner contract

Docker Desktop on the owner-controlled PC is the execution boundary; GitHub
is only the workflow and control plane. Host-direct Windows runners are forbidden.
Every Windows workflow job uses this exact tuple:

`self-hosted,windows,x64,joy-media-worker-docker`

The image is a Windows Server Core container. It uses a digest-pinned base and
portable, SHA-256-verified MinGit, FFmpeg, jq, Node.js, pnpm, and Actions
Runner binaries. Chocolatey and any host-installed package are deliberately
not part of the build contract.

## Build

Switch Docker Desktop to **Use Windows containers instead of Linux
containers** before building. From the repository root:

```powershell
docker build --pull `
  --file ops/self-hosted/windows-runner/Dockerfile.windows `
  --build-arg RUNNER_VERSION=2.337.0 `
  --tag joy-media-worker-windows:2.337.0 `
  ops/self-hosted/windows-runner

docker image inspect --format '{{.Id}}' joy-media-worker-windows:2.337.0
```

The second command supplies the immutable `sha256:<64 hex>` value required by
`JOY_MEDIA_WINDOWS_IMAGE_DIGEST`. Never invent an image digest or use a mutable
tag as acceptance evidence.

## Register (token never persisted)

Registration tokens are short-lived and are supplied only to the one-shot
configuration container:

```powershell
$registrationToken = gh api --method POST repos/hadimoti/joy-media/actions/runners/registration-token --jq .token
$imageId = docker image inspect --format '{{.Id}}' joy-media-worker-windows:2.337.0

docker volume create joy-media-worker-docker-runner
docker run --rm `
  --name joy-media-worker-docker-register `
  -e RUNNER_TOKEN=$registrationToken `
  -e RUNNER_NAME=joy-media-worker-docker `
  -e RUNNER_LABELS=self-hosted,windows,x64,joy-media-worker-docker `
  -e JOY_MEDIA_WINDOWS_IMAGE_DIGEST=$imageId `
  -v joy-media-worker-docker-runner:C:\actions-runner `
  joy-media-worker-windows:2.337.0 -ConfigureOnly
```

The long-running container is started without `RUNNER_TOKEN`:

```powershell
docker run -d `
  --name joy-media-worker-docker `
  --restart unless-stopped `
  -e JOY_MEDIA_WINDOWS_IMAGE_DIGEST=$imageId `
  -v joy-media-worker-docker-runner:C:\actions-runner `
  joy-media-worker-windows:2.337.0
```

The entrypoint removes the token after registration and never writes it to the
image, runner volume, logs, or evidence. If the volume already contains an
older host-direct registration, discard only that runner volume after the
GitHub runner is removed and register a fresh Docker-labelled runner; do not
reuse a stale registration under the new contract.

## Container-local acceptance

`worker-acceptance-container.ps1` is the only release acceptance harness. It
spawns the normal Worker and loopback fixture inside the container, observes
container-local process/lifecycle events, verifies disposable state, repair,
update, rollback, and teardown, and emits candidate-bound redacted evidence.
It must not call host task-scheduler APIs, `Win32_Process`, host credentials,
or an owner session. The older `worker-acceptance.ps1` host fixture is not an
accepted CI path.

Evidence is accepted only when it contains the exact candidate SHA, workflow
run/attempt, exact Docker label, immutable container ID and image digest, a
verified Windows platform marker, source provenance, and a fully verified
container-local lifecycle. The release gate rejects missing, stale, mismatched,
host-direct, portable, or legacy evidence.

## Runtime blocker policy

This contract does not invent runtime evidence. Until Docker Desktop's Windows
engine builds the image, registers this exact label, executes both acceptance
passes, and produces exact-candidate evidence, the release gate remains red.
On the current PC, `docker desktop engine ls` lists only `linux *` and
`docker desktop engine use windows` returns `engine is disabled`; do not run the
Windows registration commands against the Linux engine or substitute a native
Windows runner. Restore/enable a Windows-container-capable Docker engine (or use
an owner-controlled Windows Docker host) before proceeding.
