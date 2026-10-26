# Builds the Media Foundation enumeration probe with the .NET Framework C# 5 compiler that build-installer.ps1 already uses,
# so nothing new is installed. The executable goes to a folder outside the repository.
# Usage: build-mf-probe.ps1 [-OutDir <folder>]
param(
    [string]$OutDir = (Join-Path $env:TEMP 'joy-media-mf-probe')
)
$ErrorActionPreference = 'Stop'

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { throw "csc.exe not found at $csc." }

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$output = Join-Path $OutDir 'mf-probe.exe'
& $csc /nologo /target:exe /platform:x64 /optimize+ "/out:$output" (Join-Path $PSScriptRoot 'MfProbe.cs')
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE." }
Write-Output $output
