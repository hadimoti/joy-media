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

Before each run the system-wide encoder count must be zero. If it is not, the run is a harness error and no app starts.
The GPU record of each run is removed before the run starts, so an old record cannot hide a missing one.

Three consecutive harness errors (not app failures) end the loop. App failures never stop it, so every run is recorded.

Raw reports and logs go to -OutDir, which must be outside the repository.

-PreflightOnly checks the paths and tools and prints the plan without starting anything.
-SelfTest checks the conversion and aggregation logic against scripted runs, and runs the real spawn and poll path against a scripted spec process and a stub nvidia-smi. It needs no app and no GPU. It needs Node: -NodeDirectory when given, otherwise node on PATH.

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
# WER writes its crash event a few seconds after the crash, so each run's window runs on for this grace period.
$werGraceSeconds = 10
# Set only by -SelfTest: a scripted process stands in for Playwright, and the grace period is skipped.
$script:SelfTestSpecRunner = $null

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

function Get-EncoderBaselineError {
    # A run starts only when no encoder session is open. The count is system-wide, so another encoder user would count as the app.
    param([int]$Count)
    if ($Count -gt 0) { return "$Count encoder session(s) were open before the run. Close the other encoder users, then rerun." }
    return $null
}

function Get-TestInstallProcesses {
    # Matched by executable path, so a JOY Media the operator runs from another folder is never counted or stopped.
    return @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'joy-media.exe'" |
        Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $appExe) } |
        Select-Object ProcessId, CommandLine)
}

function Get-WerCrashCodes {
    # Read-only. The Application Error events for joy-media.exe in the window. Only the exception code is kept, never a path or a message.
    # A failed query is an error, not zero crashes. Only "no events matched" is an empty answer.
    param([datetime]$Start, [datetime]$End)
    try {
        $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error'; StartTime = $Start; EndTime = $End } -ErrorAction Stop)
    }
    catch {
        if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { $events = @() } else { throw }
    }
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
    if ($CollectGpu) {
        # A record left by an earlier run in this folder would hide a missing record, so it is removed first.
        Remove-Item -LiteralPath $gpuPath -Force -ErrorAction SilentlyContinue
        $env:JOY_MEDIA_GPU_ACCEPTANCE_OUT = $gpuPath
    }
    else { Remove-Item -Path Env:JOY_MEDIA_GPU_ACCEPTANCE_OUT -ErrorAction SilentlyContinue }

    $encoderBefore = Get-EncoderContext
    if ($CollectGpu) {
        $baselineError = $null
        try { $baselineError = Get-EncoderBaselineError -Count (Get-EncoderSessionTotal) }
        catch { $baselineError = $_.Exception.Message }
        if ($null -ne $baselineError) {
            return New-RunRecord -Run $Run -HarnessError $baselineError -SpecPassed $false -TimedOut $false -ExitCode $null `
                -Launches 0 -FallbackArgument $false -FallbackMarkerSeen $false -GpuExitsListener 0 -WerExceptionCodes @() `
                -EncoderMax $null -EncoderBefore $encoderBefore -EncoderAfter '' -LeftoversStopped 0 -Seconds 0 -ReportName ''
        }
    }
    if ($null -ne $script:SelfTestSpecRunner) {
        # -SelfTest only: a scripted process stands in for Playwright. The loop, the sampling and the records are the real ones.
        $runnerExe = $script:SelfTestSpecRunner.Exe
        $argumentLine = & $script:SelfTestSpecRunner.Arguments $Stem
    }
    else {
        $runnerExe = $nodeExe
        $argumentLine = '"{0}" test --config {1} {2} --retries=0 --reporter=json' -f $playwrightCli, $configPath, $Spec
    }
    $started = Get-Date
    $process = Start-Process -FilePath $runnerExe -ArgumentList $argumentLine -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
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

    # Timed out means the deadline passed while the process still ran. A harness error ends the wait early, so it is not a timeout.
    $timedOut = (-not $process.HasExited) -and ($null -eq $harnessError) -and ((Get-Date) -ge $deadline)
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
    }
    # The window runs on for the grace period, so a crash event written a few seconds late still lands in its own run.
    # Every run reads Windows Error Reporting. The export run has no listener, so its events count as its GPU exits.
    $graceSeconds = if ($null -ne $script:SelfTestSpecRunner) { 0 } else { $werGraceSeconds }
    Start-Sleep -Seconds $graceSeconds
    try {
        $werCodes = Get-WerCrashCodes -Start $started -End (Get-Date)
    }
    catch {
        if ($null -eq $harnessError) { $harnessError = 'the Windows Error Reporting query failed' }
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

function Get-ExportExits {
    # The export run has no listener, so the Windows Error Reporting crashes it produced are its GPU exits. A record without the field counts none.
    param($ExportRecord)
    if (($null -ne $ExportRecord) -and ($ExportRecord.PSObject.Properties.Name -contains 'gpuExitsTotal')) { return [int]$ExportRecord.gpuExitsTotal }
    return 0
}

function New-AcceptanceSteps {
    # The five steps of plan section 10d, G0 item 4. Any run without a measurement makes the step fail.
    param([object[]]$Records, $Limits, $ExportRecord)
    $healthy = @($Records | Where-Object { $null -eq $_.harnessError })
    $allHealthy = $healthy.Count -eq $Records.Count
    $completed = @($healthy | Where-Object { $_.specPassed -and $_.defaultLaunch }).Count
    $gpuExits = [int](($healthy | Measure-Object -Property gpuExitsTotal -Sum).Sum) + (Get-ExportExits $ExportRecord)
    $fallbackRuns = @($healthy | Where-Object { $_.fallbackRelaunchSeen }).Count
    $measured = @($Records | Where-Object { $null -ne $_.encoderMaxDuringRun })
    $encoderMin = $null
    if ($measured.Count -gt 0) { $encoderMin = [int](($measured | Measure-Object -Property encoderMaxDuringRun -Minimum).Minimum) }
    $encoderPass = ($measured.Count -eq $Records.Count) -and ($null -ne $encoderMin) -and ($encoderMin -ge [int]$Limits.minEncoderSessionsDuringExport)
    $exportPassed = ($null -ne $ExportRecord) -and [bool]$ExportRecord.specPassed
    # An export run that did not measure cleanly does not pass the GPU step, even when its partial count is zero.
    $exportClean = ($null -eq $ExportRecord) -or ($ExportRecord.PSObject.Properties.Name -notcontains 'harnessError') -or ($null -eq $ExportRecord.harnessError)
    return @(
        [pscustomobject]@{
            id = 'default-launches'
            result = $(if (($Records.Count -eq [int]$Limits.defaultLaunches) -and ($completed -eq $Records.Count)) { 'pass' } else { 'fail' })
            measurement = $completed
            unit = 'runs'
        }
        [pscustomobject]@{
            id = 'gpu-process-exits'
            result = $(if ($allHealthy -and $exportClean -and $gpuExits -le [int]$Limits.maxGpuProcessExits) { 'pass' } else { 'fail' })
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

    Assert-Same (Get-EncoderBaselineError -Count 0) $null 'a clean encoder count starts a run'
    if ($null -eq (Get-EncoderBaselineError -Count 2)) { $failures.Add('an open encoder session refuses the run') }
    $thirtyOne = @(1..([int]$limits.defaultLaunches + 1) | ForEach-Object {
            New-RunRecord -Run $_ -HarnessError $null -SpecPassed $true -TimedOut $false -ExitCode 0 -Launches 1 -FallbackArgument $false `
                -FallbackMarkerSeen $false -GpuExitsListener 0 -WerExceptionCodes @() -EncoderMax 1 -EncoderBefore '0' -EncoderAfter '0' `
                -LeftoversStopped 0 -Seconds 1 -ReportName 'selftest'
        })
    $moreRuns = New-AcceptanceSteps -Records $thirtyOne -Limits $limits -ExportRecord $exportRecord
    Assert-Same ($moreRuns[0].result) 'fail' 'more runs than the registered count fail default-launches'

    # Exactly the registered number of clean runs passes. One failed spec among them fails the step.
    $thirty = @(1..([int]$limits.defaultLaunches) | ForEach-Object {
            New-RunRecord -Run $_ -HarnessError $null -SpecPassed $true -TimedOut $false -ExitCode 0 -Launches 1 -FallbackArgument $false `
                -FallbackMarkerSeen $false -GpuExitsListener 0 -WerExceptionCodes @() -EncoderMax 1 -EncoderBefore '0' -EncoderAfter '0' `
                -LeftoversStopped 0 -Seconds 1 -ReportName 'selftest'
        })
    $thirtySteps = @(New-AcceptanceSteps -Records $thirty -Limits $limits -ExportRecord $exportRecord)
    Assert-Same ($thirtySteps[0].result) 'pass' 'exactly the registered clean runs pass default-launches'
    $oneFailed = @($thirty)
    $oneFailed[0] = New-RunRecord -Run 1 -HarnessError $null -SpecPassed $false -TimedOut $false -ExitCode 1 -Launches 1 `
        -FallbackArgument $false -FallbackMarkerSeen $false -GpuExitsListener 0 -WerExceptionCodes @() -EncoderMax 1 `
        -EncoderBefore '0' -EncoderAfter '0' -LeftoversStopped 0 -Seconds 1 -ReportName 'selftest'
    $oneFailedSteps = @(New-AcceptanceSteps -Records $oneFailed -Limits $limits -ExportRecord $exportRecord)
    Assert-Same ($oneFailedSteps[0].result) 'fail' 'a failed spec among the registered runs fails default-launches'
    # A GPU exit in the export run is a GPU exit of the session.
    $exportExit = [pscustomobject]@{ specPassed = $true; gpuExitsTotal = 1 }
    $exitSteps = @(New-AcceptanceSteps -Records $thirty -Limits $limits -ExportRecord $exportExit)
    Assert-Same ($exitSteps[1].result) 'fail' 'an exit in the export run fails gpu-process-exits'

    # End to end through the real spec-run path: the poll loop, the sampling and the records. A scripted process stands in for
    # Playwright, and a function stands in for nvidia-smi. No app and no GPU are used.
    New-Item -ItemType Directory -Force -Path $outFull | Out-Null
    $appExe = Join-Path $outFull 'no-app\joy-media.exe'
    $script:fakeSpecPath = Join-Path $PSScriptRoot 'selftest-fake-spec.mjs'
    $script:fakeScenario = 'clean'
    $script:shimAnswers = @('0')
    $script:shimCalls = 0
    # -NodeDirectory when given, otherwise node on PATH. The scripted spec process runs under it.
    if ($NodeDirectory) {
        $selfTestNode = Join-Path (Resolve-Path -LiteralPath $NodeDirectory).Path 'node.exe'
        if (-not (Test-Path -LiteralPath $selfTestNode -PathType Leaf)) { throw "node.exe is missing from $NodeDirectory." }
    }
    else {
        $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
        if (-not $nodeCommand) { throw 'node is not on PATH. Pass -NodeDirectory, the folder that holds node.exe, for -SelfTest too.' }
        $selfTestNode = $nodeCommand.Source
    }
    $script:SelfTestSpecRunner = @{
        Exe = $selfTestNode
        Arguments = { param([string]$stem) '"' + $script:fakeSpecPath + '" ' + $script:fakeScenario }
    }
    function Get-WerCrashCodes {
        # The scripted Windows Error Reporting answer for the run in progress.
        param($Start, $End)
        return , @($script:shimWer)
    }
    function nvidia-smi {
        # The first two calls are the pre-run context and the baseline, both 0. The later calls answer the scripted values.
        $script:shimCalls++
        if ($script:shimCalls -le 2) { return '0' }
        return $script:shimAnswers[[math]::Min($script:shimCalls - 3, $script:shimAnswers.Count - 1)]
    }
    $cases = @(
        @{ name = 'clean'; answers = @('2', '2'); wer = @(); collect = $true }
        @{ name = 'gpu-exit'; answers = @('2'); wer = @(); collect = $true }
        @{ name = 'relaunch'; answers = @('1'); wer = @(); collect = $true }
        @{ name = 'non-numeric'; answers = @('Not Supported'); wer = @(); collect = $true }
        @{ name = 'wer-exit'; answers = @('2'); wer = @('0xC0000409'); collect = $true }
        @{ name = 'export'; answers = @('0'); wer = @('0xC0000409'); collect = $false }
    )
    $e2e = @{}
    $runNumber = 0
    foreach ($case in $cases) {
        $runNumber++
        $script:fakeScenario = $case.name
        $script:shimAnswers = $case.answers
        $script:shimCalls = 0
        $script:shimWer = $case.wer
        $e2e[$case.name] = @(Invoke-SpecRun -Run $runNumber -Spec 'selftest' -Stem ('selftest-' + $case.name) -CollectGpu $case.collect) | Select-Object -Last 1
    }
    $script:SelfTestSpecRunner = $null
    $clean = $e2e['clean']
    if (($null -ne $clean.harnessError) -or (-not $clean.specPassed) -or ($clean.launches -ne 1) -or ($clean.encoderMaxDuringRun -ne 2) -or ($clean.gpuExitsTotal -ne 0)) {
        $failures.Add("end-to-end clean run: harnessError=$($clean.harnessError) specPassed=$($clean.specPassed) launches=$($clean.launches) encoderMax=$($clean.encoderMaxDuringRun) exits=$($clean.gpuExitsTotal)")
    }
    $gpuExit = $e2e['gpu-exit']
    if (($gpuExit.gpuExitsListener -ne 1) -or ($gpuExit.gpuExitsTotal -ne 1)) {
        $failures.Add("end-to-end GPU exit: listener=$($gpuExit.gpuExitsListener) total=$($gpuExit.gpuExitsTotal)")
    }
    $relaunch = $e2e['relaunch']
    if (($relaunch.launches -ne 2) -or (-not $relaunch.fallbackRelaunchSeen) -or $relaunch.defaultLaunch) {
        $failures.Add("end-to-end relaunch: launches=$($relaunch.launches) fallback=$($relaunch.fallbackRelaunchSeen) default=$($relaunch.defaultLaunch)")
    }
    $nonNumeric = $e2e['non-numeric']
    if (($null -eq $nonNumeric.harnessError) -or ($nonNumeric.harnessError -notlike '*not a session count*')) {
        $failures.Add("end-to-end non-numeric answer: harnessError=$($nonNumeric.harnessError)")
    }

    if ($nonNumeric.timedOut) { $failures.Add('end-to-end non-numeric answer: a harness error is not a timeout') }
    $werExit = $e2e['wer-exit']
    if (($werExit.gpuExitsListener -ne 0) -or ($werExit.gpuExitsTotal -ne 1)) {
        $failures.Add("end-to-end unexplained WER exit: listener=$($werExit.gpuExitsListener) total=$($werExit.gpuExitsTotal)")
    }
    $exportRun = $e2e['export']
    if (($exportRun.gpuExitsTotal -ne 1) -or ($null -ne $exportRun.harnessError)) {
        $failures.Add("end-to-end export run WER exit: total=$($exportRun.gpuExitsTotal) harnessError=$($exportRun.harnessError)")
    }

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
# The same gate as a run, so a preflight that would fail every run says so here.
$baselineNow = $null
try { $baselineNow = Get-EncoderBaselineError -Count (Get-EncoderSessionTotal) } catch { $baselineNow = $_.Exception.Message }
$running = @(Get-TestInstallProcesses)
if ($running.Count -gt 0) {
    throw "The test install is already running (PIDs $($running.ProcessId -join ', ')). Close it first. This harness does not count or stop processes it did not start."
}
if ($Runs -ne [int]$limits.defaultLaunches) {
    Write-Warning "-Runs is $Runs, but the registered count is $($limits.defaultLaunches). default-launches passes only at the registered count, so this run is diagnostic only."
}
if ($PreflightOnly) {
    if ($null -ne $baselineNow) { throw "preflight failed: $baselineNow" }
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
