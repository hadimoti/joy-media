#!/usr/bin/env pwsh
# JOY Media Windows self-hosted runner entrypoint (Windows-container variant).
#
# Mirrors the Linux `ops/self-hosted/linux-runner/entrypoint.sh` contract:
#   - The first run requires RUNNER_TOKEN / RUNNER_NAME / RUNNER_LABELS to
#     register the runner. RUNNER_TOKEN is short-lived, supplied at the
#     moment of `docker run --rm … --configure-only`, and never persisted
#     inside the image or a long-running container.
#   - The long-running container (`docker run -d …`) is started WITHOUT
#     RUNNER_TOKEN, so the expired registration token cannot be leaked
#     into the container environment, the workflow logs, or the durable
#     evidence store.
#   - The Windows-container variant is the only accepted Windows lane. The
#     release gate binds evidence to the exact `joy-media-ci` label and to the
#     candidate SHA; host-direct and portable evidence are rejected.
#
# Build prerequisites: the owner PC must have Docker Desktop with the
# "Use Windows containers instead of Linux containers" engine enabled.
# See `Dockerfile.windows` and `contract.md` in this directory.
[CmdletBinding()]
param(
    [switch]$ConfigureOnly
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'C:\actions-runner'

$runnerConfigPath = Join-Path $PWD '.runner'
if (-not (Test-Path -LiteralPath $runnerConfigPath -PathType Leaf)) {
    if (-not $env:RUNNER_TOKEN) { throw 'RUNNER_TOKEN is required only for first-time registration.' }
    if (-not $env:RUNNER_NAME)  { throw 'RUNNER_NAME is required only for first-time registration.' }
    if (-not $env:RUNNER_LABELS) { throw 'RUNNER_LABELS is required only for first-time registration.' }
    $expectedLabels = 'self-hosted,windows,x64,joy-media-ci'
    if ($env:RUNNER_LABELS -ne $expectedLabels) { throw "RUNNER_LABELS must be exactly '$expectedLabels'." }
    & .\config.cmd --unattended `
        --url 'https://github.com/hadimoti/joy-media' `
        --token $env:RUNNER_TOKEN `
        --name $env:RUNNER_NAME `
        --labels $env:RUNNER_LABELS `
        --work _work `
        --replace
    # The token has now been used. Do NOT echo it, log it, or persist it.
    Remove-Item Env:\RUNNER_TOKEN -ErrorAction SilentlyContinue
}

if ($ConfigureOnly) {
    exit 0
}

& .\run.cmd
