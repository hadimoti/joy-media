# JOY Media isolated Linux runner

Labels: `self-hosted,linux,x64,joy-media-ci`

This image is a local, low-privilege GitHub Actions runner for the release
candidate lanes. It is deliberately separate from the production Sweden VPS
and never receives the owner browser/OpenCLI profile.

Build with Docker Desktop's Linux engine:

```powershell
$env:Path = 'C:\Program Files\Docker\Docker\resources\bin;' + $env:Path
docker build --pull --build-arg RUNNER_VERSION=2.337.0 --tag joy-media-ci-linux:2.337.0 ops/self-hosted/linux-runner
```

Create a short-lived registration token without saving it in the repository:

```powershell
$registrationToken = gh api --method POST repos/hadimoti/joy-media/actions/runners/registration-token --jq .token
```

The first container invocation configures the runner volume. The long-running
container is then started without the token, so the expired registration token
is not retained in the container environment:

```powershell
docker volume create joy-media-ci-linux-runner
docker run --rm `
  --name joy-media-ci-linux-register `
  -e RUNNER_TOKEN=$registrationToken `
  -e RUNNER_NAME=joy-media-ci-linux `
  -e RUNNER_LABELS=self-hosted,linux,x64,joy-media-ci `
  -v joy-media-ci-linux-runner:/opt/actions-runner `
  joy-media-ci-linux:2.337.0 --configure-only

docker run -d `
  --name joy-media-ci-linux `
  --restart unless-stopped `
  -v joy-media-ci-linux-runner:/opt/actions-runner `
  joy-media-ci-linux:2.337.0
```

The release workflow still requires the isolated PostgreSQL/S3 service
environment and an executable `JOY_MEDIA_CI_RELEASE_COMMAND`. Do not mark the
release gate green merely because this runner is online; provision and verify
those prerequisites before dispatching `release-candidate.yml`.
