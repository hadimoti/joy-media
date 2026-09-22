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

Run the committed provisioner from the repository root after switching Docker
Desktop to Windows containers:

```powershell
.\ops\self-hosted\windows-runner\provision.ps1
```

The provisioner configures the runner inside the long-running container. This
is required because Windows runner credentials are protected with DPAPI and
must be created in the container that will use them. The registration token is
requested only after the container is ready, travels only on standard input to
`docker exec -i`, and is cleared from the provisioning process afterwards; it
is never passed as a host environment variable or command-line value.

The default MTU is 1240 because the owner PC's VPN tunnel has an MTU of 1280
and Windows containers otherwise default to 1500. The provisioner sets each
non-loopback IPv4 subinterface to 1240 with `store=active` before starting the
runner, then verifies the setting. Use `-MtuBytes 0` only when the container's
network path does not require this adjustment.

If a container with the exact runner name already exists, remove it explicitly
after retiring its GitHub runner registration; the provisioner never deletes
containers or runner volumes. You may pass a named Docker volume with
`-Volume`, or leave it empty to use the container writable layer.

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
Docker Desktop's Windows-container engine is required for this runner while
the Linux lanes use the independent Ubuntu-24.04 WSL2 Docker Engine; do not
switch Docker Desktop to its Linux engine or substitute a native Windows
runner. If the Windows engine is unavailable, repair it before proceeding.
