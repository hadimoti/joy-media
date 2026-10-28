<#
.SYNOPSIS
Polls the NVIDIA encoder session count every 250 ms into a CSV until the owner stops it (plan section 10d, G1 kit).

.DESCRIPTION
Read-only: it runs one nvidia-smi query per poll and writes the timestamp, the sum over the GPUs, and a status. A non-numeric
answer is kept as its status, never as a zero. The sampler stops when the file `<OutFile>.stop` exists, or with Ctrl+C.
Run it in its own window during an export, and stop it with `New-Item <OutFile>.stop` once the export has finished.

.EXAMPLE
pwsh -NoProfile -File tooling/diagnostics/sample-encoder-sessions.ps1 -OutFile 'C:\JoyMediaG1\logs\encoder-baseline-default.csv'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutFile,
    [ValidateRange(100, 5000)][int]$PollMilliseconds = 250
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$outFull = [System.IO.Path]::GetFullPath($OutFile)
$stopFile = "$outFull.stop"
if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile -Force }
New-Item -ItemType Directory -Path (Split-Path -Parent $outFull) -Force | Out-Null
Set-Content -LiteralPath $outFull -Value 'timestamp_utc,encoder_sessions,status' -Encoding UTF8

while (-not (Test-Path -LiteralPath $stopFile)) {
    $timestamp = [DateTime]::UtcNow.ToString('o')
    $answer = $null
    $status = 'ok'
    try {
        $rows = @(& nvidia-smi --query-gpu=encoder.stats.sessionCount --format=csv,noheader 2>&1 | ForEach-Object { [string]$_ })
        $total = 0
        foreach ($row in $rows) {
            if ($row.Trim() -match '^\d+$') { $total += [int]$row.Trim() } else { $status = 'non-numeric'; break }
        }
        if ($status -eq 'ok') { $answer = $total }
    }
    catch {
        $status = 'query-failed'
    }
    Add-Content -LiteralPath $outFull -Value ('{0},{1},{2}' -f $timestamp, $answer, $status) -Encoding UTF8
    Start-Sleep -Milliseconds $PollMilliseconds
}
Write-Output "stopped: $outFull"
