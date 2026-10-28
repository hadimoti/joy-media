<#
.SYNOPSIS
Runs MfProbe --encode once for each hardware H.264 encoder, each in its own process, and writes one line per encoder (plan section 10d, G1 step 8).

.DESCRIPTION
Attended G1 tool. It is not run in G0, and it runs only with the owner present (-OwnerPresent), because the encode activates the GPU encoders.
Each encoder runs in its own probe process, so a fault in one encoder cannot affect the next. A process that does not exit within -TimeoutSeconds
is killed and recorded as "timeout", and the next encoder still runs. Each record holds the start and end time (UTC) of its process, so the owner
can match each sampler window to its encoder. The process exit code is normalised to 0x%08X (plan section 10e). The probe's JSON line is kept as
text. The output file must lie outside the repository.

.EXAMPLE
pwsh -NoProfile -File tooling/diagnostics/mf-probe/run-mf-encode.ps1 -Probe 'C:\JoyMediaG1\kit\tree\tooling\diagnostics\mf-probe\mf-probe.exe' `
  -OutFile 'C:\JoyMediaG1\logs\mf-encode.jsonl' -OwnerPresent
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Probe,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [switch]$OwnerPresent,
    [ValidateRange(5, 600)][int]$TimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $OwnerPresent) { throw 'Run this only with the owner present (G1, F77). Pass -OwnerPresent to confirm that.' }
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
$outFull = [System.IO.Path]::GetFullPath($OutFile)
if ($outFull.StartsWith($repoRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutFile must be outside the repository; the encoder results stay on this PC.'
}
$probePath = (Resolve-Path -LiteralPath $Probe).Path

# The enumeration, one JSON line per encoder. The default mode is the listing.
$listing = @(& $probePath 2>$null | Where-Object { $_ -match '"event":"encoder"' })
$indices = @($listing | ForEach-Object { [int](ConvertFrom-Json -InputObject $_).index })
if ($indices.Count -eq 0) { throw 'No hardware H.264 encoder is listed; nothing to encode.' }

Set-Content -LiteralPath $outFull -Value @() -Encoding UTF8
$count = 0
foreach ($index in $indices) {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new($probePath)
    $startInfo.ArgumentList.Add('--encode')
    $startInfo.ArgumentList.Add([string]$index)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startedUtc = [DateTime]::UtcNow
    $process = [System.Diagnostics.Process]::Start($startInfo)
    # Both streams are read while the process runs, so a full pipe cannot stall the encoder.
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $null = $process.StandardError.ReadToEndAsync()
    $timedOut = -not $process.WaitForExit($TimeoutSeconds * 1000)
    if ($timedOut) {
        $process.Kill($true)
        $null = $process.WaitForExit(10000)
    }
    $endedUtc = [DateTime]::UtcNow
    $probeLine = @($stdoutTask.Result -split "`r?`n" | Where-Object { $_ -match '"index"' }) | Select-Object -Last 1
    # A crash code is negative as a signed value, so the mask is 64-bit. A 32-bit mask throws on it.
    $exitCode = if ($timedOut) { 'timeout' } else { '0x{0:X8}' -f [uint32]([long]$process.ExitCode -band 0xFFFFFFFFL) }
    $record = [ordered]@{
        index = $index
        exitCode = $exitCode
        startedUtc = $startedUtc.ToString('o')
        endedUtc = $endedUtc.ToString('o')
        probe = $probeLine
    }
    # Each line is written as soon as it exists, so a later failure cannot lose the earlier results.
    Add-Content -LiteralPath $outFull -Value ($record | ConvertTo-Json -Compress -Depth 4) -Encoding UTF8
    $process.Dispose()
    $count++
}
Write-Output "wrote $count encoder result(s) to $outFull"
