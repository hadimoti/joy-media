<#
.SYNOPSIS
Repeats the default-launch export journey against an installed JOY Media, and writes the G2 acceptance steps (plan section 10d, G4 and G5).

.DESCRIPTION
Attended tool for the GPU track. It is not run by CI and must not run unattended: each run drives the GPU, and a GPU crash on this
PC is the failure under study.

Each run starts the installed app through tests/desktop/gpu-acceptance.spec.ts. That spec runs the export journey of
export-semantics.spec.ts with a test-side listener on every launch. The listener writes each launch, and each GPU child-process
exit with its normalised exit code, to a file in -OutDir. Nothing is added to the production build.

Per run the harness also records:
- the spec outcome, from the Playwright JSON report;
- whether a relaunch carried the encode-fallback marker (--joy-media-gpu-encode-fallback), seen on the OS command line;
- the nvidia-smi encoder session count, sampled on every poll of the 500 ms loop and summed over the GPUs. The run keeps the
  maximum. A non-numeric answer is a harness error, never a zero. The counts before and after the run are context only;
- the Windows Error Reporting crash events for joy-media.exe in the run window (counts and exception codes only). A crash event
  that the listener did not see counts as an unexplained GPU exit.

After the runs, the harness runs export-semantics.spec.ts once more (the export-spec step). Then it compares each measurement with
the registered G2 thresholds in docs/qa/attended/model-thresholds.json, records that file's SHA-256, and writes steps.json for
write-receipt.mjs. A step that lacks data for any run fails.

Three consecutive harness errors (not app failures) end the loop. App failures never stop it, so every run is recorded.

Raw reports and logs go to -OutDir, which must be outside the repository.

-PreflightOnly checks the paths and tools and prints the plan without starting anything.
-SelfTest checks the conversion and aggregation logic against scripted runs. It needs no app and no GPU.

.EXAMPLE
pwsh -NoProfile -File tooling/diagnostics/run-default-export-repeat.ps1 -InstallRoot 'D:\JOY Media' -OutDir 'D:\joy-gpu-g5' -Runs 30 -NodeDirectory 'D:\node24' -PnpmDirectory 'D:\pnpm'
#>
[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$OutDir,
    [ValidateRange(1, 200)][int]$Runs = 3,
    [ValidateRange(60, 3600)][int]$SpecTimeoutSeconds = 900,
    [string]$NodeDirectory,
    [string]$PnpmDirectory,
    [string]$Thresholds = 'docs/qa/attended/model-thresholds.json',
    [switch]$PreflightOnly,
    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Must match GPU_ENCODE_FALLBACK_ARGUMENT in apps/desktop/src/main/gpu-encode-fallback.ts.
$fallbackArgument = '--joy-media-gpu-encode-fallback'
$configPath = 'playwright.desktop.config.ts'
$acceptanceSpec = 'tests/desktop/gpu-acceptance.spec.ts'
$exportSpec = 'tests/desktop/export-semantics.spec.ts'
# Consecutive harness errors that end the loop (plan section 10d, G0 item 4).
$harnessErrorLimit = 3
$pollMilliseconds = 500

# A harness error is a failed measurement, not a failed app. Only these end the loop.
class HarnessError : System.Exception {
    HarnessError([string]$Message) : base($Message) {}
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path

if (-not $OutDir) { throw 'OutDir is required.' }
$outFull = [System.IO.Path]::GetFullPath($OutDir)
if ($outFull -eq $repoRoot -or $outFull.StartsWith($repoRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutDir must be outside the repository; raw GPU reports stay on this PC.'
}

$thresholdsPath = if ([System.IO.Path]::IsPathRooted($Thresholds)) { $Thresholds } else { Join-Path $repoRoot $Thresholds }
if (-not (Test-Path -LiteralPath $thresholdsPath -PathType Leaf)) { throw "The thresholds file is missing: $Thresholds" }
$thresholdsSha256 = (Get-FileHash -LiteralPath $thresholdsPath -Algorithm SHA256).Hash.ToLowerInvariant()
$limits = (Get-Content -LiteralPath $thresholdsPath -Raw | ConvertFrom-Json).sessions.G2
foreach ($key in 'defaultLaunches', 'maxGpuProcessExits', 'maxFallbackRelaunches', 'minEncoderSessionsDuringExport') {
    if ($null -eq $limits.$key -or -not ([string]$limits.$key -match '^-?\d+$')) {
        throw "sessions.G2.$key is not registered; no acceptance run can start while it is null."
    }
}

function ConvertTo-EncoderTotal {
    # Sums the nvidia-smi rows, one per GPU. A row that is not a whole number is a harness error, never a zero.
    param([AllowEmptyCollection()][string[]]$Lines)
    if ($Lines.Count -eq 0) { throw [HarnessError]::new('nvidia-smi printed no encoder rows.') }
    $total = 0
    foreach ($line in $Lines) {
        $text = $line.Trim()
        if ($text -notmatch '^\d+$') { throw [HarnessError]::new('nvidia-smi gave an answer that is not a session count.') }
        $total += [int]$text
    }
    return $total
}

function ConvertTo-ExitCodeHex {
    # Unsigned 32-bit hex (plan section 10e): -1073740791 and 3221226505 both give 0xC0000409.
    param([Parameter(Mandatory = $true)][long]$Code)
    return ('0x{0:X8}' -f [uint32]($Code -band 0xFFFFFFFFL))
}

function Get-EncoderSessionTotal {
    $command = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $command) { throw [HarnessError]::new('nvidia-smi is not on PATH; the encoder count cannot be measured.') }
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& nvidia-smi --query-gpu=encoder.stats.sessionCount --format=csv,noheader 2>&1 | ForEach-Object { [string]$_ })
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    return ConvertTo-EncoderTotal -Lines $lines
}

function Get-EncoderContext {
    # The before and after counts are context only, so a failed read is shown as text and never fails the run.
    try { return [string](Get-EncoderSessionTotal) } catch { return $_.Exception.Message }
}

function Get-TestInstallProcesses {
    # Matched by executable path, so a JOY Media the operator runs from another folder is never counted or stopped.
    return @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'joy-media.exe'" |
        Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $appExe) } |
        Select-Object ProcessId, CommandLine)
}

function Get-WerCrashCodes {
    # Read-only. The Application Error events for joy-media.exe in the window. Only the exception code is kept, never a path or a message.
    param([datetime]$Start, [datetime]$End)
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error'; StartTime = $Start; EndTime = $End } -ErrorAction SilentlyContinue)
    $codes = New-Object System.Collections.Generic.List[string]
    foreach ($event in $events) {
        $message = [string]$event.Message
        if ($message -notmatch 'joy-media\.exe') { continue }
        if ($message -match 'Exception code:\s*(0x[0-9a-fA-F]+)') {
            $codes.Add((ConvertTo-ExitCodeHex -Code ([Convert]::ToInt64($Matches[1].Substring(2), 16))))
        }
        else {
            $codes.Add('unknown')
        }
    }
    return , $codes.ToArray()
}

function Read-GpuAcceptanceRecords {
    # One JSON line per event, written by the wrapper spec. A missing file returns $null, which is a harness error.
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $launches = New-Object System.Collections.Generic.List[object]
    $exits = New-Object System.Collections.Generic.List[object]
    foreach ($line in @(Get-Content -LiteralPath $Path)) {
        if ($line.Trim() -eq '') { continue }
        $record = $line | ConvertFrom-Json
        if ($record.event -eq 'launch') { $launches.Add($record) }
        elseif ($record.event -eq 'gpu-child-process-gone') { $exits.Add($record) }
    }
    return [pscustomobject]@{ launches = $launches.ToArray(); exits = $exits.ToArray() }
}

function Read-SpecOutcome {
    param([string]$ReportPath)
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

function New-RunRecord {
    # The one shape of a run, used by the real runs and by -SelfTest, so the aggregation is tested on the same data.
    param(
        [int]$Run,
        [string]$HarnessError,
        [bool]$SpecPassed,
        [bool]$TimedOut,
        $ExitCode,
        [int]$Launches,
        [bool]$FallbackArgument,
        [bool]$FallbackMarkerSeen,
        [int]$GpuExitsListener,
        [string[]]$WerExceptionCodes,
        $EncoderMax,
        [string]$EncoderBefore,
        [string]$EncoderAfter,
        [int]$LeftoversStopped,
        [double]$Seconds,
        [string]$ReportName
    )
    $werCount = $WerExceptionCodes.Count
    $unexplained = [math]::Max(0, $werCount - $GpuExitsListener)
    $failed = -not [string]::IsNullOrEmpty($HarnessError)
    return [pscustomobject]@{
        run = $Run
        harnessError = $(if ($failed) { $HarnessError } else { $null })
        specPassed = $SpecPassed
        timedOut = $TimedOut
        exitCode = $ExitCode
        launches = $Launches
        defaultLaunch = ($Launches -ge 1) -and (-not $FallbackArgument)
        fallbackRelaunchSeen = $FallbackMarkerSeen -or $FallbackArgument
        gpuExitsListener = $GpuExitsListener
        werExceptionCodes = $WerExceptionCodes
        unexplainedWerExits = $unexplained
        gpuExitsTotal = $GpuExitsListener + $unexplained
        encoderMaxDuringRun = $(if ($failed) { $null } else { $EncoderMax })
        encoderBefore = $EncoderBefore
        encoderAfter = $EncoderAfter
        leftoversStopped = $LeftoversStopped
        seconds = $Seconds
        report = $ReportName
    }
}

function Invoke-SpecRun {
    # One run of one spec. CollectGpu is set for the acceptance spec, whose listener writes the GPU record.
    param([int]$Run, [string]$Spec, [string]$Stem, [bool]$CollectGpu)
    $reportPath = Join-Path $outFull "$Stem.json"
    $gpuPath = Join-Path $outFull "$Stem.gpu.jsonl"
    $env:PLAYWRIGHT_JSON_OUTPUT_NAME = $reportPath
    if ($CollectGpu) { $env:JOY_MEDIA_GPU_ACCEPTANCE_OUT = $gpuPath }
    else { Remove-Item -Path Env:JOY_MEDIA_GPU_ACCEPTANCE_OUT -ErrorAction SilentlyContinue }

    $encoderBefore = Get-EncoderContext
    $argumentLine = '"{0}" test --config {1} {2} --retries=0 --reporter=json' -f $playwrightCli, $configPath, $Spec
    $started = Get-Date
    $process = Start-Process -FilePath $nodeExe -ArgumentList $argumentLine -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $outFull "$Stem.stdout.log") `
        -RedirectStandardError (Join-Path $outFull "$Stem.stderr.log")

    $deadline = $started.AddSeconds($SpecTimeoutSeconds)
    $maxConcurrent = 0
    $fallbackSeen = $false
    $encoderMax = $null
    $harnessError = $null
    try {
        while (-not $process.HasExited -and (Get-Date) -lt $deadline) {
            $appProcesses = @(Get-TestInstallProcesses)
            if ($appProcesses.Count -gt $maxConcurrent) { $maxConcurrent = $appProcesses.Count }
            if (@($appProcesses | Where-Object { [string]$_.CommandLine -like "*$fallbackArgument*" }).Count -gt 0) { $fallbackSeen = $true }
            # Every poll is a measurement. A non-numeric answer stops this run as a harness error (plan section 10d, G0 item 4).
            $sample = Get-EncoderSessionTotal
            if ($null -eq $encoderMax -or $sample -gt $encoderMax) { $encoderMax = $sample }
            Start-Sleep -Milliseconds $pollMilliseconds
        }
    }
    catch {
        if ($_.Exception -isnot [HarnessError]) { throw }
        $harnessError = $_.Exception.Message
    }

    $timedOut = -not $process.HasExited
    if ($timedOut -or $null -ne $harnessError) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
    $exitCode = $null
    if (-not $timedOut -and $null -eq $harnessError) { $exitCode = $process.ExitCode }

    # A relaunched instance can outlive the spec. Stop what this run left behind so the next run starts clean.
    $leftovers = @(Get-TestInstallProcesses)
    foreach ($leftover in $leftovers) { & taskkill.exe /PID $leftover.ProcessId /T /F | Out-Null }
    $ended = Get-Date
    $encoderAfter = Get-EncoderContext

    $outcome = Read-SpecOutcome -ReportPath $reportPath
    if (-not $outcome.reported -and $null -eq $harnessError) { $harnessError = 'Playwright wrote no JSON report.' }

    $launches = 0
    $fallbackArgumentLaunch = $false
    $listenerExits = 0
    $werCodes = @()
    if ($CollectGpu) {
        $gpu = Read-GpuAcceptanceRecords -Path $gpuPath
        if ($null -eq $gpu) {
            if ($null -eq $harnessError) { $harnessError = 'the acceptance spec wrote no GPU record' }
        }
        else {
            $launches = $gpu.launches.Count
            $fallbackArgumentLaunch = @($gpu.launches | Where-Object { $_.fallbackArgument }).Count -gt 0
            $listenerExits = $gpu.exits.Count
        }
        try {
            $werCodes = Get-WerCrashCodes -Start $started -End $ended
        }
        catch {
            if ($null -eq $harnessError) { $harnessError = 'the Windows Error Reporting query failed' }
        }
    }

    $specPassed = [bool]($outcome.reported -and (-not $timedOut) -and ($null -eq $harnessError) -and ($exitCode -eq 0) -and
        ($outcome.expected -gt 0) -and ($outcome.unexpected -eq 0) -and ($outcome.skipped -eq 0))

    return New-RunRecord -Run $Run -HarnessError $harnessError -SpecPassed $specPassed -TimedOut $timedOut -ExitCode $exitCode `
        -Launches $launches -FallbackArgument $fallbackArgumentLaunch -FallbackMarkerSeen $fallbackSeen `
        -GpuExitsListener $listenerExits -WerExceptionCodes $werCodes -EncoderMax $encoderMax `
        -EncoderBefore $encoderBefore -EncoderAfter $encoderAfter -LeftoversStopped $leftovers.Count `
        -Seconds ([math]::Round(($ended - $started).TotalSeconds, 1)) -ReportName (Split-Path -Leaf $reportPath)
}

function Invoke-AcceptanceLoop {
    # Runs the executor up to Count times. Three consecutive harness errors end the loop; app failures never do.
    param([scriptblock]$Executor, [int]$Count)
    $records = New-Object System.Collections.Generic.List[object]
    $consecutive = 0
    $stopReason = $null
    for ($run = 1; $run -le $Count; $run++) {
        $record = & $Executor $run
        $records.Add($record)
        if ($null -ne $record.harnessError) { $consecutive++ } else { $consecutive = 0 }
        Write-Host ('run {0}: specPassed={1} launches={2} fallback={3} gpuExits={4} encoderMax={5} harnessError={6}' -f `
            $run, $record.specPassed, $record.launches, $record.fallbackRelaunchSeen, $record.gpuExitsTotal, $record.encoderMaxDuringRun, $record.harnessError)
        if ($consecutive -ge $harnessErrorLimit) {
            $stopReason = "$harnessErrorLimit consecutive harness errors after run $run"
            break
        }
    }
    return [pscustomobject]@{ records = $records.ToArray(); stopReason = $stopReason }
}

function New-AcceptanceSteps {
    # The five steps of plan section 10d, G0 item 4. Any run without a measurement makes the step fail.
    param([object[]]$Records, $Limits, $ExportRecord)
    $healthy = @($Records | Where-Object { $null -eq $_.harnessError })
    $allHealthy = $healthy.Count -eq $Records.Count
    $completed = @($healthy | Where-Object { $_.specPassed -and $_.defaultLaunch }).Count
    $gpuExits = [int](($healthy | Measure-Object -Property gpuExitsTotal -Sum).Sum)
    $fallbackRuns = @($healthy | Where-Object { $_.fallbackRelaunchSeen }).Count
    $measured = @($Records | Where-Object { $null -ne $_.encoderMaxDuringRun })
    $encoderMin = $null
    if ($measured.Count -gt 0) { $encoderMin = [int](($measured | Measure-Object -Property encoderMaxDuringRun -Minimum).Minimum) }
    $encoderPass = ($measured.Count -eq $Records.Count) -and ($null -ne $encoderMin) -and ($encoderMin -ge [int]$Limits.minEncoderSessionsDuringExport)
    $exportPassed = ($null -ne $ExportRecord) -and [bool]$ExportRecord.specPassed
    return @(
        [pscustomobject]@{
            id = 'default-launches'
            result = $(if ($completed -eq [int]$Limits.defaultLaunches) { 'pass' } else { 'fail' })
            measurement = $completed
            unit = 'runs'
        }
        [pscustomobject]@{
            id = 'gpu-process-exits'
            result = $(if ($allHealthy -and $gpuExits -le [int]$Limits.maxGpuProcessExits) { 'pass' } else { 'fail' })
            measurement = $gpuExits
            unit = 'exits'
        }
        [pscustomobject]@{
            id = 'fallback-relaunches'
            result = $(if ($allHealthy -and $fallbackRuns -le [int]$Limits.maxFallbackRelaunches) { 'pass' } else { 'fail' })
            measurement = $fallbackRuns
            unit = 'runs'
        }
        [pscustomobject]@{
            id = 'encoder-sessions-during-export'
            result = $(if ($encoderPass) { 'pass' } else { 'fail' })
            measurement = $encoderMin
            unit = 'sessions'
        }
        [pscustomobject]@{
            id = 'export-spec'
            result = $(if ($exportPassed) { 'pass' } else { 'fail' })
            measurement = $(if ($null -ne $ExportRecord) { [int][bool]$ExportRecord.specPassed } else { $null })
            unit = 'spec'
        }
    )
}

function Invoke-SelfTest {
    # Scripted runs through the same loop and aggregation, with no app and no GPU. Returns $true when every check holds.
    $failures = New-Object System.Collections.Generic.List[string]
    function Assert-Same($Actual, $Expected, [string]$Name) {
        if ($Actual -ne $Expected) { $failures.Add("${Name}: expected '$Expected', got '$Actual'") }
    }
    function Assert-Throws([scriptblock]$Action, [string]$Name) {
        try { & $Action; $failures.Add("${Name}: no error was raised") }
        catch { if ($_.Exception -isnot [HarnessError]) { $failures.Add("${Name}: wrong error type") } }
    }

    Assert-Same (ConvertTo-EncoderTotal -Lines @('2', '3')) 5 'two GPUs are summed'
    Assert-Same (ConvertTo-EncoderTotal -Lines @('0')) 0 'a real zero is a number'
    Assert-Throws { ConvertTo-EncoderTotal -Lines @('2', 'Not Supported') } 'a non-numeric row is a harness error'
    Assert-Throws { ConvertTo-EncoderTotal -Lines @() } 'no rows is a harness error'
    Assert-Same (ConvertTo-ExitCodeHex -Code -1073740791) '0xC0000409' 'the negative form normalises'
    Assert-Same (ConvertTo-ExitCodeHex -Code 3221226505) '0xC0000409' 'the unsigned form normalises'

    $scripted = @(
        @{ error = $null; spec = $true; launches = 1; fallback = $false; marker = $false; exits = 0; wer = @(); encoder = 2 }
        @{ error = $null; spec = $true; launches = 1; fallback = $false; marker = $false; exits = 1; wer = @('0xC0000409'); encoder = 2 }
        @{ error = $null; spec = $true; launches = 2; fallback = $true; marker = $true; exits = 0; wer = @(); encoder = 1 }
        @{ error = $null; spec = $true; launches = 1; fallback = $false; marker = $false; exits = 0; wer = @(); encoder = 0 }
        @{ error = 'nvidia-smi gave an answer that is not a session count.'; spec = $false; launches = 1; fallback = $false; marker = $false; exits = 0; wer = @(); encoder = $null }
    )
    $executor = {
        param($run)
        $s = $scripted[$run - 1]
        New-RunRecord -Run $run -HarnessError $s.error -SpecPassed $s.spec -TimedOut $false -ExitCode 0 -Launches $s.launches `
            -FallbackArgument $s.fallback -FallbackMarkerSeen $s.marker -GpuExitsListener $s.exits -WerExceptionCodes $s.wer `
            -EncoderMax $s.encoder -EncoderBefore '0' -EncoderAfter '0' -LeftoversStopped 0 -Seconds 1 -ReportName 'selftest'
    }
    $loop = Invoke-AcceptanceLoop -Executor $executor -Count $scripted.Count
    $exportRecord = [pscustomobject]@{ specPassed = $true }
    $steps = New-AcceptanceSteps -Records $loop.records -Limits $limits -ExportRecord $exportRecord
    Assert-Same ($steps[0].result) 'fail' 'default-launches fails: only 3 runs are clean default launches'
    Assert-Same ($steps[0].measurement) 3 'default-launches counts 3 clean runs'
    Assert-Same ($steps[1].result) 'fail' 'gpu-process-exits fails: one exit, and a harness error'
    Assert-Same ($steps[1].measurement) 1 'gpu-process-exits totals the listener exit'
    Assert-Same ($steps[2].result) 'fail' 'fallback-relaunches fails: one relaunch'
    Assert-Same ($steps[2].measurement) 1 'fallback-relaunches counts the relaunched run'
    Assert-Same ($steps[3].result) 'fail' 'encoder step fails: a run has no measurement and the minimum is 0'
    Assert-Same ($steps[3].measurement) 0 'encoder step minimum ignores the harness-error run'
    Assert-Same ($steps[4].result) 'pass' 'export-spec passes when its run passed'

    $stopping = @(
        @{ error = 'x' }, @{ error = 'x' }, @{ error = 'x' }, @{ error = $null }
    )
    $stopLoop = Invoke-AcceptanceLoop -Count $stopping.Count -Executor {
        param($run)
        New-RunRecord -Run $run -HarnessError $stopping[$run - 1].error -SpecPassed $false -TimedOut $false -ExitCode $null -Launches 0 `
            -FallbackArgument $false -FallbackMarkerSeen $false -GpuExitsListener 0 -WerExceptionCodes @() -EncoderMax $null `
            -EncoderBefore '' -EncoderAfter '' -LeftoversStopped 0 -Seconds 0 -ReportName 'selftest'
    }
    Assert-Same $stopLoop.records.Count 3 'three consecutive harness errors end the loop after run 3'
    if ($null -eq $stopLoop.stopReason) { $failures.Add('the stop reason is recorded') }

    $result = [pscustomobject]@{
        passed = ($failures.Count -eq 0)
        failures = $failures.ToArray()
        thresholdsSha256 = $thresholdsSha256
        steps = $steps
    }
    New-Item -ItemType Directory -Force -Path $outFull | Out-Null
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outFull 'selftest-result.json') -Encoding UTF8
    if ($result.passed) { Write-Host 'SELFTEST PASS' } else { Write-Host ('SELFTEST FAIL: ' + ($failures -join '; ')) }
    return $result.passed
}

if ($SelfTest) {
    $selfTestPassed = Invoke-SelfTest
    exit ([int](-not $selfTestPassed))
}

if (-not $InstallRoot) { throw 'InstallRoot is required for a real run.' }
if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) { throw "InstallRoot is not a folder: $InstallRoot" }
$appExe = Join-Path (Resolve-Path -LiteralPath $InstallRoot).Path 'joy-media.exe'
if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) { throw "joy-media.exe is missing from $InstallRoot." }

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
foreach ($spec in $acceptanceSpec, $exportSpec) {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $spec) -PathType Leaf)) { throw "Spec is missing: $spec" }
}

Write-Output "app under test: joy-media.exe"
Write-Output "node: $nodeExe"
Write-Output "pnpm: $((Get-Command pnpm).Source)"
Write-Output "thresholds sha256: $thresholdsSha256"
Write-Output "encoder sessions now: $(Get-EncoderContext)"
$running = @(Get-TestInstallProcesses)
if ($running.Count -gt 0) {
    throw "The test install is already running (PIDs $($running.ProcessId -join ', ')). Close it first. This harness does not count or stop processes it did not start."
}
if ($PreflightOnly) {
    Write-Output "preflight ok; nothing was started. Runs: $Runs; spec: $acceptanceSpec; then $exportSpec once."
    return
}

New-Item -ItemType Directory -Force -Path $outFull | Out-Null
$env:JOY_MEDIA_TEST_EXECUTABLE = $appExe

$loop = Invoke-AcceptanceLoop -Count $Runs -Executor {
    param($run)
    Invoke-SpecRun -Run $run -Spec $acceptanceSpec -Stem ('run-{0:D3}' -f $run) -CollectGpu $true
}
$exportRecord = $null
if ($null -eq $loop.stopReason) {
    $exportRecord = Invoke-SpecRun -Run 0 -Spec $exportSpec -Stem 'export-spec' -CollectGpu $false
}
$steps = New-AcceptanceSteps -Records $loop.records -Limits $limits -ExportRecord $exportRecord

$stepsPath = Join-Path $outFull 'steps.json'
$steps | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $stepsPath -Encoding UTF8
$summary = [pscustomobject]@{
    installedApp = 'joy-media.exe'
    thresholdsSha256 = $thresholdsSha256
    runsRequested = $Runs
    runsExecuted = $loop.records.Count
    stopReason = $loop.stopReason
    harnessErrors = @($loop.records | Where-Object { $null -ne $_.harnessError }).Count
    steps = $steps
    runs = $loop.records
}
$summaryPath = Join-Path $outFull 'summary.json'
$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
Write-Output "steps: $stepsPath"
Write-Output "summary: $summaryPath"
