#!/usr/bin/env pwsh
# JOY Media Windows Docker runner entrypoint.
#
# CLI flag: --configure-only. Registration is a one-shot operation. RUNNER_TOKEN is accepted only when
# the persistent runner volume has no .runner file, then removed from the
# process environment before the long-running runner starts.
[CmdletBinding()]
param(
    [switch]$ConfigureOnly
)

$ErrorActionPreference = 'Stop'
$runnerRoot = 'C:\actions-runner'
$runnerBase = 'C:\runner-base'
if (-not (Test-Path -LiteralPath (Join-Path $runnerRoot 'run.cmd') -PathType Leaf)) {
    New-Item -ItemType Directory -Path $runnerRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $runnerBase -Force | Copy-Item -Destination $runnerRoot -Recurse -Force
}
Set-Location -LiteralPath $runnerRoot

# These values are supplied by the owner-controlled docker run command. The
# hostname fallback is Docker's container hostname, but the image digest must
# always be explicit because it cannot be recovered reliably from inside the
# Actions runner process.
if (-not $env:JOY_MEDIA_WINDOWS_CONTAINER_ID) {
    $env:JOY_MEDIA_WINDOWS_CONTAINER_ID = (hostname).Trim().ToLowerInvariant()
}
if ($env:JOY_MEDIA_WINDOWS_CONTAINER_ID -notmatch '^[0-9a-f]{12,64}$') {
    throw 'JOY_MEDIA_WINDOWS_CONTAINER_ID must be Docker''s real container id.'
}
if ($env:JOY_MEDIA_WINDOWS_IMAGE_DIGEST -notmatch '^sha256:[0-9a-f]{64}$') {
    throw 'JOY_MEDIA_WINDOWS_IMAGE_DIGEST must be injected from docker image inspect.'
}

$runnerConfigPath = Join-Path $PWD '.runner'
$runnerCredentialsPath = Join-Path $PWD '.credentials'
$waitForRegistration = $env:JOY_MEDIA_WINDOWS_WAIT_FOR_REGISTRATION -eq '1'
while ((-not (Test-Path -LiteralPath $runnerConfigPath -PathType Leaf) -or -not (Test-Path -LiteralPath $runnerCredentialsPath -PathType Leaf)) -and -not $env:RUNNER_TOKEN) {
    if (-not $waitForRegistration) { throw 'RUNNER_TOKEN is required only for first-time registration, or set JOY_MEDIA_WINDOWS_WAIT_FOR_REGISTRATION=1.' }
    Start-Sleep -Seconds 2
}
if (-not (Test-Path -LiteralPath $runnerConfigPath -PathType Leaf) -or -not (Test-Path -LiteralPath $runnerCredentialsPath -PathType Leaf)) {
    if (-not $env:RUNNER_TOKEN) { throw 'RUNNER_TOKEN is required only for first-time registration.' }
    if (-not $env:RUNNER_NAME)  { throw 'RUNNER_NAME is required only for first-time registration.' }
    if (-not $env:RUNNER_LABELS) { throw 'RUNNER_LABELS is required only for first-time registration.' }
    $expectedLabels = 'self-hosted,windows,x64,joy-media-worker-docker'
    if ($env:RUNNER_LABELS -ne $expectedLabels) { throw "RUNNER_LABELS must be exactly '$expectedLabels'." }
    & .\config.cmd --unattended `
        --url 'https://github.com/hadimoti/joy-media' `
        --token $env:RUNNER_TOKEN `
        --name $env:RUNNER_NAME `
        --labels $env:RUNNER_LABELS `
        --work _work `
        --replace
    # The token has now been used. Never echo it, log it, or persist it.
    Remove-Item Env:\RUNNER_TOKEN -ErrorAction SilentlyContinue
}

if ($ConfigureOnly) {
    exit 0
}

# Do not pass the registration token to run.cmd. The runner process inherits
# only the redacted identity metadata used by acceptance evidence.
& .\run.cmd
