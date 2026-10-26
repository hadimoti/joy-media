<#
.SYNOPSIS
Repeats the packaged export spec against an installed JOY Media and records what the GPU encode fallback did (L2, plan section 3.2, step 5).

.DESCRIPTION
Attended G2 tool. It is not run by CI and must not run unattended: the export spec drives the GPU, and a GPU crash on this
PC is the failure under study. The Playwright spec starts the installed app itself through JOY_MEDIA_TEST_EXECUTABLE.

Per run it records:
- the spec outcome, read from the Playwright JSON report;
- whether a joy-media.exe from the test install was relaunched with the encode-fallback marker
  (--joy-media-gpu-encode-fallback, apps/desktop/src/main/gpu-encode-fallback.ts). The fallback switch is applied
  in-process with appendSwitch, so the Media Foundation switch never appears on the OS command line. The marker is the
  only OS-visible sign of a fallback relaunch;
- the most test-install processes seen at once. Electron runs several processes under one exe name, so this is context,
  not a relaunch count;
- the nvidia-smi encoder session count before and after the run.

Not recorded here: GPU process exits. The diagnostic mode (gpu-diagnostics.ts) is not wired into the app yet, so count
those from the app log by hand in G2.

Only the test install is counted or stopped, matched by executable path. The harness refuses to start while that install
is already running. Raw reports and logs go to -OutDir, which must be outside the repository.

Use -PreflightOnly to check paths and the pnpm requirement and print the plan without starting anything.

.EXAMPLE
pwsh -NoProfile -File tooling/diagnostics/run-default-export-repeat.ps1 -InstallRoot 'D:\JOY Media' -OutDir 'D:\joy-gpu-g2' -Runs 30 -NodeDirectory 'D:\node24' -PnpmDirectory 'D:\pnpm'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [ValidateRange(1, 200)][int]$Runs = 3,
    [ValidateRange(60, 3600)][int]$SpecTimeoutSeconds = 900,
    [string]$NodeDirectory,
    [string]$PnpmDirectory,
    [switch]$PreflightOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Must match GPU_ENCODE_FALLBACK_ARGUMENT in apps/desktop/src/main/gpu-encode-fallback.ts.
$fallbackArgument = '--joy-media-gpu-encode-fallback'
$configPath = 'playwright.desktop.config.ts'
$specPath = 'tests/desktop/export-semantics.spec.ts'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path

if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) { throw "InstallRoot is not a folder: $InstallRoot" }
$appExe = Join-Path (Resolve-Path -LiteralPath $InstallRoot).Path 'joy-media.exe'
if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) { throw "joy-media.exe is missing from $InstallRoot." }

$outFull = [System.IO.Path]::GetFullPath($OutDir)
if ($outFull -eq $repoRoot -or $outFull.StartsWith($repoRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutDir must be outside the repository; raw GPU reports stay on this PC.'
}

if (-not $NodeDirectory) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'node is not on PATH. Pass -NodeDirectory, the folder that holds node.exe (Node 24).' }
    $NodeDirectory = Split-Path -Parent $nodeCommand.Source
}
$nodeDirectoryFull = (Resolve-Path -LiteralPath $NodeDirectory).Path
$nodeExe = Join-Path $nodeDirectoryFull 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) { throw "node.exe is missing from $nodeDirectoryFull." }

$pathEntries = @($nodeDirectoryFull)
if ($PnpmDirectory) { $pathEntries += (Resolve-Path -LiteralPath $PnpmDirectory).Path }
$env:PATH = (($pathEntries -join ';') + ';' + $env:PATH)
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw 'pnpm is not on PATH. The Playwright config starts its API server with pnpm, so pass -PnpmDirectory.'
}

$playwrightCli = Join-Path $repoRoot 'node_modules\@playwright\test\cli.js'
if (-not (Test-Path -LiteralPath $playwrightCli -PathType Leaf)) { throw 'Playwright CLI is missing. Run pnpm install in the repository first.' }
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $specPath) -PathType Leaf)) { throw "Spec is missing: $specPath" }

function Get-TestInstallProcesses {
    # Matched by executable path, so a JOY Media the operator runs from another folder is never counted or stopped.
    return @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'joy-media.exe'" |
        Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $appExe) } |
        Select-Object ProcessId, CommandLine)
}

function Get-EncoderSessionCount {
    if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) { return 'nvidia-smi not found' }
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& nvidia-smi --query-gpu=encoder.stats.sessionCount --format=csv,noheader 2>&1 | ForEach-Object { [string]$_ })
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    return ($lines -join ' | ')
}

function Read-SpecOutcome([string]$ReportPath) {
    if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) {
        return [pscustomobject]@{ reported = $false; expected = 0; unexpected = 0; skipped = 0 }
    }
    $report = Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json
    return [pscustomobject]@{
        reported = $true
        expected = [int]$report.stats.expected
        unexpected = [int]$report.stats.unexpected
        skipped = [int]$report.stats.skipped
    }
}

Write-Output "app under test: $appExe"
Write-Output "node: $nodeExe"
Write-Output "pnpm: $((Get-Command pnpm).Source)"
Write-Output "playwright cli: $playwrightCli"
Write-Output "encoder sessions now: $(Get-EncoderSessionCount)"
$running = @(Get-TestInstallProcesses)
if ($running.Count -gt 0) {
    throw "The test install is already running (PIDs $($running.ProcessId -join ', ')). Close it first. This harness does not count or stop processes it did not start."
}
if ($PreflightOnly) {
    Write-Output 'preflight ok; nothing was started.'
    return
}

New-Item -ItemType Directory -Force -Path $outFull | Out-Null
$env:JOY_MEDIA_TEST_EXECUTABLE = $appExe
$results = New-Object System.Collections.Generic.List[object]

for ($run = 1; $run -le $Runs; $run++) {
    $stem = 'run-{0:D3}' -f $run
    $reportPath = Join-Path $outFull "$stem.json"
    $env:PLAYWRIGHT_JSON_OUTPUT_NAME = $reportPath
    $encoderBefore = Get-EncoderSessionCount

    $argumentLine = '"{0}" test --config {1} {2} --retries=0 --reporter=json' -f $playwrightCli, $configPath, $specPath
    $started = Get-Date
    $process = Start-Process -FilePath $nodeExe -ArgumentList $argumentLine -WorkingDirectory $repoRoot `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $outFull "$stem.stdout.log") `
        -RedirectStandardError (Join-Path $outFull "$stem.stderr.log")

    $deadline = $started.AddSeconds($SpecTimeoutSeconds)
    $maxConcurrent = 0
    $fallbackSeen = $false
    while (-not $process.HasExited -and (Get-Date) -lt $deadline) {
        $appProcesses = @(Get-TestInstallProcesses)
        if ($appProcesses.Count -gt $maxConcurrent) { $maxConcurrent = $appProcesses.Count }
        if (@($appProcesses | Where-Object { [string]$_.CommandLine -like "*$fallbackArgument*" }).Count -gt 0) { $fallbackSeen = $true }
        Start-Sleep -Milliseconds 500
    }

    $timedOut = -not $process.HasExited
    $exitCode = $null
    if ($timedOut) {
        & taskkill.exe /PID $process.Id /T /F | Out-Null
    }
    else {
        $exitCode = $process.ExitCode
    }

    # A relaunched instance can outlive the spec. Stop what this run left behind so the next run starts clean.
    $leftovers = @(Get-TestInstallProcesses)
    foreach ($leftover in $leftovers) { & taskkill.exe /PID $leftover.ProcessId /T /F | Out-Null }

    $encoderAfter = Get-EncoderSessionCount
    $outcome = Read-SpecOutcome $reportPath
    $passed = $outcome.reported -and (-not $timedOut) -and ($exitCode -eq 0) -and ($outcome.expected -gt 0) -and ($outcome.unexpected -eq 0) -and ($outcome.skipped -eq 0)

    $results.Add([pscustomobject]@{
        run = $run
        passed = [bool]$passed
        timedOut = $timedOut
        exitCode = $exitCode
        seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
        fallbackRelaunchSeen = $fallbackSeen
        maxConcurrentTestInstallProcesses = $maxConcurrent
        leftoverProcessesStopped = $leftovers.Count
        encoderSessionsBefore = $encoderBefore
        encoderSessionsAfter = $encoderAfter
        report = $reportPath
    })
    Write-Output ('run {0}: passed={1} fallbackRelaunchSeen={2} exitCode={3}' -f $run, [bool]$passed, $fallbackSeen, $exitCode)
}

$summary = [pscustomobject]@{
    installedApp = $appExe
    nodeDirectory = $nodeDirectoryFull
    runs = $Runs
    passed = @($results | Where-Object { $_.passed }).Count
    failed = @($results | Where-Object { -not $_.passed }).Count
    fallbackRelaunchRuns = @($results | Where-Object { $_.fallbackRelaunchSeen }).Count
    results = $results
}
$summaryPath = Join-Path $outFull 'summary.json'
$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
Write-Output "summary: $summaryPath"
