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

## Runner service environment

Keep service configuration in a root-owned file on the WSL host, outside the
repository, with mode `0600` (for example,
`/etc/joy-media/ci-runner.env`). Do not put values in this README or commit the
file. The primary `joy-media-ci` runner uses these names:

- `JOY_MEDIA_CI_DATABASE_URL`
- `JOY_MEDIA_CI_S3_ENDPOINT` — `scheme://host:port` only, with no embedded
  userinfo. Put credentials in `JOY_MEDIA_CI_S3_ACCESS_KEY` and
  `JOY_MEDIA_CI_S3_SECRET_KEY`.
- `JOY_MEDIA_CI_S3_HEALTHCHECK_URL`
- `JOY_MEDIA_CI_RELEASE_COMMAND` — absolute path to the isolated real-services
  release harness.
- `JOY_MEDIA_CI_EVIDENCE_ROOT=/opt/joy-media-evidence` — mount this path from
  a named volume called `<container>-evidence`, owned by runner uid 1001.

Create and assign the evidence volume once for this runner (replace the
placeholder with the container name):

```sh
docker volume create joy-media-ci-linux-evidence
docker run --rm --user 0 \
  --mount source=joy-media-ci-linux-evidence,target=/opt/joy-media-evidence \
  --entrypoint sh joy-media-ci-linux:2.337.0 \
  -c 'chown 1001:1001 /opt/joy-media-evidence'
```

The release harness expects the MinIO service hostname `joyminio`; with the
current host-network topology, map it to the host loopback address. Start the
long-running service with the root-only env file and persistent evidence
volume (the existing runner volume can be added as shown):

```sh
docker run -d \
  --name joy-media-ci-linux \
  --restart unless-stopped \
  --network host \
  --add-host joyminio:127.0.0.1 \
  --env-file /etc/joy-media/ci-runner.env \
  --mount source=joy-media-ci-linux-runner,target=/opt/actions-runner \
  --mount source=joy-media-ci-linux-evidence,target=/opt/joy-media-evidence \
  joy-media-ci-linux:2.337.0
```

Keep the S3 endpoint in `JOY_MEDIA_CI_S3_ENDPOINT` free of credentials because
the MinIO client rejects endpoint URLs containing userinfo. Both Linux runner
containers need their own environment file and evidence volume; see
`../acceptance-runner/README.md` for the acceptance runner's additional
profile and command variables.
