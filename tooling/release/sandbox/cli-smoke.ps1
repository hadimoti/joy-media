param(
    [string]$OutputDirectory = 'C:\out'
)

$ErrorActionPreference = 'Stop'
$outputPath = Join-Path $OutputDirectory 'cli-smoke.json'
$work = 'C:\work'
$fixture = 'C:\in\offline-smoke-project.json'
$checks = New-Object System.Collections.ArrayList

function Add-Check([string]$Id, [bool]$Passed, [string]$Detail) {
    $result = if ($Passed) { 'pass' } else { 'fail' }
    [void]$checks.Add([ordered]@{ id = $Id; result = $result; detail = $Detail })
}

function Invoke-Cli([string]$CommandName, [string[]]$Arguments) {
    try {
        $lines = & $CommandName @Arguments 2>&1
        $exitCode = $LASTEXITCODE
        $text = (@($lines | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine).Trim()
        return [ordered]@{ exitCode = $exitCode; output = $text }
    } catch {
        return [ordered]@{ exitCode = 1; output = $_.Exception.Message }
    }
}

# The `joy` check runs in Command Prompt, not in this PowerShell. Windows PowerShell adds .CPL to PATHEXT,
# and the machine PATH (System32) comes before the user PATH, so here `joy` resolves to System32\joy.cpl
# (Game Controllers) and never reaches bin\joy.cmd: the check came back empty in every Sandbox run.
# A new Command Prompt uses the system PATHEXT, where `joy` is the JOY Media CLI.
function Invoke-CommandPromptCli([string]$CommandName, [string[]]$Arguments) {
    try {
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
        $startInfo.Arguments = '/d /c ' + (@($CommandName) + @($Arguments) -join ' ')
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $pathExt = [Environment]::GetEnvironmentVariable('PATHEXT', 'Machine')
        if (-not $pathExt) { $pathExt = '.COM;.EXE;.BAT;.CMD' }
        $startInfo.EnvironmentVariables['PATHEXT'] = $pathExt
        $startInfo.EnvironmentVariables['Path'] = $env:Path
        $process = [System.Diagnostics.Process]::Start($startInfo)
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(120000)) {
            try { $process.Kill() } catch { }
            return [ordered]@{ exitCode = 1; output = 'Command Prompt timed out after 120 s' }
        }
        $process.WaitForExit()
        return [ordered]@{ exitCode = $process.ExitCode; output = ($stdout.Result + $stderr.Result).Trim() }
    } catch {
        return [ordered]@{ exitCode = 1; output = $_.Exception.Message }
    }
}

function Parse-JsonOutput([string]$Output) {
    try { return $Output | ConvertFrom-Json -ErrorAction Stop } catch { return $null }
}

function Render-WroteManifest($Result) {
    if ($Result.exitCode -ne 0) { return $false }
    foreach ($line in [regex]::Split($Result.output, '\r?\n')) {
        try {
            $event = $line | ConvertFrom-Json -ErrorAction Stop
            if ($event.type -eq 'complete' -and $event.manifestWritten -eq $true) {
                return (Test-Path -LiteralPath $event.artifactPath -PathType Leaf)
            }
        } catch { }
    }
    return $false
}

if (-not (Test-Path -LiteralPath $fixture -PathType Leaf)) {
    throw "Offline smoke fixture is missing: $fixture"
}
New-Item -ItemType Directory -Force -Path $work, $OutputDirectory | Out-Null

# This is a fresh shell after install. Re-read the persisted User PATH instead of inheriting the
# lifecycle shell's stale environment, and keep doctor from probing any configured remote edge.
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ';'
$env:JOY_MEDIA_EDGE_URL = 'off'

$joyVersion = Invoke-CommandPromptCli 'joy' @('--version')
Add-Check 'joy-cmd-version-reported' (
    $joyVersion.exitCode -eq 0 -and $joyVersion.output -match '^JOY Media CLI v\d+\.\d+\.\d+$'
) $joyVersion.output

$joyMediaVersion = Invoke-Cli 'joy-media' @('--version')
Add-Check 'joy-media-cmd-version-reported' (
    $joyMediaVersion.exitCode -eq 0 -and $joyMediaVersion.output -match '^JOY Media CLI v\d+\.\d+\.\d+$'
) $joyMediaVersion.output

$doctor = Invoke-Cli 'joy-media' @('doctor', '--json')
$doctorJson = Parse-JsonOutput $doctor.output
$doctorOk = $doctor.exitCode -eq 0 -and $null -ne $doctorJson -and $doctorJson.ok -eq $true
Add-Check 'doctor-json-reported' $doctorOk $doctor.output

$entryRenderDir = Join-Path $work 'a14-render'
$entryRender = Invoke-Cli 'joy-media' @(
    'render', '--project', $fixture, '--out', $entryRenderDir, '--json'
)
$entryManifest = Render-WroteManifest $entryRender
Add-Check 'render-entrypoint-wrote-manifest' $entryManifest $entryRender.output

$database = Join-Path $work 'offline-smoke.sqlite'
$import = Invoke-Cli 'joy-media' @(
    'project', 'import', $fixture, '--sqlite-path', $database, '--json'
)
$importJson = Parse-JsonOutput $import.output
$importOk = $import.exitCode -eq 0 -and $null -ne $importJson -and
    $importJson.id -eq 'sandbox-offline-smoke'

$exportPath = Join-Path $work 'offline-smoke-export.json'
$export = Invoke-Cli 'joy-media' @(
    'project', 'export', 'sandbox-offline-smoke', '--output', $exportPath,
    '--sqlite-path', $database, '--json'
)
$exportJson = Parse-JsonOutput $export.output
$exportOk = $export.exitCode -eq 0 -and $null -ne $exportJson -and
    $exportJson.id -eq 'sandbox-offline-smoke' -and
    (Test-Path -LiteralPath $exportPath -PathType Leaf)
$roundTripOk = $importOk -and $exportOk
$roundTripDetail = 'import: ' + $import.output + ' | export: ' + $export.output

$offlineRenderDir = Join-Path $work 'offline-smoke-render'
$offlineRender = Invoke-Cli 'joy-media' @(
    'render', '--project', $exportPath, '--out', $offlineRenderDir, '--json'
)
$offlineRenderOk = Render-WroteManifest $offlineRender
$offlineCliOk = $doctorOk -and $offlineRenderOk

$record = [ordered]@{
    schema = 'joy-media.cli-smoke/1'
    checks = @($checks.ToArray())
    offline = [ordered]@{
        projectRoundTrip = [ordered]@{
            result = if ($roundTripOk) { 'pass' } else { 'fail' }
            detail = $roundTripDetail
        }
        doctor = [ordered]@{
            result = if ($doctorOk) { 'pass' } else { 'fail' }
            detail = $doctor.output
        }
        render = [ordered]@{
            result = if ($offlineRenderOk) { 'pass' } else { 'fail' }
            detail = $offlineRender.output
        }
        cliResult = if ($offlineCliOk) { 'pass' } else { 'fail' }
    }
}

[IO.File]::WriteAllText(
    $outputPath,
    (($record | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
)
if (@($checks.ToArray() | Where-Object { $_.result -ne 'pass' }).Count -gt 0) { exit 1 }
if (-not $roundTripOk -or -not $offlineCliOk) { exit 1 }
exit 0
