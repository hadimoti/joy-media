# JOY Media Windows self-hosted runner contracts

Labels: `self-hosted,windows,x64,joy-media-worker`

Labels: `self-hosted,windows,x64,gpu,joy-media-worker-gpu`

Labels: `self-hosted,windows,x64,joy-media-ci`

This directory contains the owner-controlled Windows self-hosted CI
runner contracts for JOY Media.

## Self-hosted labels declared here

| Runner                   | Labels                                                     | Where it runs                              |
| ------------------------ | ---------------------------------------------------------- | ------------------------------------------ |
| joy-media-worker         | `self-hosted,windows,x64,joy-media-worker`                 | Owner-controlled Windows PC (host-direct)  |
| joy-media-worker-gpu     | `self-hosted,windows,x64,gpu,joy-media-worker-gpu`         | Owner-controlled Windows PC (GPU lane)     |
| joy-media-ci (Windows)   | `self-hosted,windows,x64,joy-media-ci`                     | PC Docker Windows-container (`Dockerfile.windows`) |

## Primary lane: `joy-media-worker` (host-direct)

The release-candidate `windows-worker-clean` job and the legacy
`worker-package` job in `ci.yml` / `ci-dev.yml` run on this label. The
runner is registered directly on the owner's Windows PC (no Docker
container), because the JOY Media Worker acceptance fixture requires
`Register-ScheduledTask` against the host's task scheduler and
`Win32_Process` enumeration — both unavailable inside a Windows
container.

## Secondary lane: `joy-media-ci` (Windows container)

`Dockerfile.windows` documents a Docker Desktop **Windows-container**
variant for any future Windows-only step that does not need host-level
access. No workflow currently targets this label; adding one requires
honoring the constraints in `contract.md`.

## Registration token handling

Registration tokens are short-lived, supplied at
`docker run --rm … --configure-only` (or `config.cmd --unattended …
--token`), and never persisted inside the image, the long-running
container, the workflow logs, or the durable evidence store. See
`Dockerfile.windows`, `windows-runner-entrypoint.ps1`, and the
equivalent contract in `ops/self-hosted/linux-runner/README.md`.
