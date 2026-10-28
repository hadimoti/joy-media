<#
.SYNOPSIS
Runs MfProbe --encode once for each hardware H.264 encoder, each in its own process, and writes one line per encoder (plan section 10d, G1 step 8).

.DESCRIPTION
Attended G1 tool. It is not run in G0, and it runs only with the owner present, because the encode activates the GPU encoders.
Each encoder runs in its own probe process, so a fault in one encoder cannot affect the next. The process exit code is normalised
to 0x%08X (plan section 10e). The probe's JSON line is kept as text. The output file must lie outside the repository.

.EXAMPLE
pwsh -NoProfile -File tooling/diagnostics/mf-probe/run-mf-encode.ps1 -Probe 'C:\JoyMediaG1\kit\tree\tooling\diagnostics\mf-probe\mf-probe.exe' -OutFile 'C:\JoyMediaG1\logs\mf-encode.jsonl'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Probe,
    [Parameter(Mandatory = $true)][string]$OutFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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
    $output = @(& $probePath --encode $index 2>$null)
    # A crash code is negative as a signed value, so the mask is 64-bit. A 32-bit mask throws on it.
    $exitCode = [long]$LASTEXITCODE
    $probeLine = $output | Where-Object { $_ -match '"index"' } | Select-Object -Last 1
    $record = [ordered]@{
        index = $index
        exitCode = ('0x{0:X8}' -f [uint32]($exitCode -band 0xFFFFFFFFL))
        probe = $probeLine
    }
    # Each line is written as soon as it exists, so a later failure cannot lose the earlier results.
    Add-Content -LiteralPath $outFull -Value ($record | ConvertTo-Json -Compress -Depth 4) -Encoding UTF8
    $count++
}
Write-Output "wrote $count encoder result(s) to $outFull"
