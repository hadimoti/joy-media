# JOY Media isolated Linux runner

Labels: `self-hosted,linux,x64,joy-media-ci`

## Current PC topology

The Windows runner and Linux runners use separate local Docker daemons so both
labels can stay online at the same time:

- Docker Desktop remains on its Windows-container engine for
  `joy-media-worker-docker`.
- Ubuntu-24.04 WSL2 runs an independent Docker Engine for this Linux runner
  and the separate `joy-media-acceptance` runner.

On this PC, Docker bridge networking inside the WSL daemon times out against
the external download/API hosts, while the WSL host network succeeds. Build
and run the Linux runner with `--network host`; this is a local transport
workaround only and does not change the image's hash verification or runner
labels. Do not switch Docker Desktop between Linux and Windows engines as a
replacement: switching takes the other runner lane offline.

This image is a local, low-privilege GitHub Actions runner for the release
candidate lanes. It is deliberately separate from the production Sweden VPS
and never receives the owner browser/OpenCLI profile.

Build with the active Linux Docker daemon (Ubuntu-24.04 WSL2 on the current PC).
Do not use the Docker Desktop CLI here: its current context points at the
Windows daemon. Prefix Docker commands with `wsl -d Ubuntu-24.04 --`:

```powershell
$repoWindowsPath = (Get-Location).Path
$repoDrive = $repoWindowsPath.Substring(0, 1).ToLowerInvariant()
$repoWslPath = "/mnt/$repoDrive/" + $repoWindowsPath.Substring(3).Replace('\', '/')
wsl -d Ubuntu-24.04 -- docker build --network host --pull --build-arg RUNNER_VERSION=2.337.0 --tag joy-media-ci-linux:2.337.0 "$repoWslPath/ops/self-hosted/linux-runner"
```

Create a short-lived registration token without saving it in the repository:

```powershell
$registrationToken = gh api --method POST repos/hadimoti/joy-media/actions/runners/registration-token --jq .token
$runnerEnv = @(
  "RUNNER_TOKEN=$registrationToken"
  'RUNNER_NAME=joy-media-ci-linux'
  'RUNNER_LABELS=self-hosted,linux,x64,joy-media-ci'
) -join "`n"
```

The first container invocation configures the runner volume. The long-running
container is then started without the token, so the expired registration token
is not retained in the container environment:

```powershell
wsl -d Ubuntu-24.04 -- docker volume create joy-media-ci-linux-runner
$runnerEnv | wsl -d Ubuntu-24.04 -- docker run --rm `
  --name joy-media-ci-linux-register `
  --network host `
  --env-file /dev/stdin `
  -v joy-media-ci-linux-runner:/opt/actions-runner `
  joy-media-ci-linux:2.337.0 --configure-only

wsl -d Ubuntu-24.04 -- docker run -d `
  --name joy-media-ci-linux `
  --restart unless-stopped `
  --network host `
  -v joy-media-ci-linux-runner:/opt/actions-runner `
  joy-media-ci-linux:2.337.0
```

The release workflow still requires the isolated PostgreSQL/S3 service
environment and an executable `JOY_MEDIA_CI_RELEASE_COMMAND`. Do not mark the
release gate green merely because this runner is online; provision and verify
those prerequisites before dispatching `release-candidate.yml`.
