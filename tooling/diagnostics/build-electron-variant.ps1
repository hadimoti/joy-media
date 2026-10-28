<#
.SYNOPSIS
Plans an Electron variant build for the bisect (plan section 10d, G0 item 8). It downloads nothing.

.DESCRIPTION
The variant downloads are GD3, an owner decision, and they are not made by G0. Without -GD3Approved this script prints the plan
and exits. With it, the script still stops, because the download step is a separate change that needs its own review.

.EXAMPLE
pwsh -NoProfile -File tooling/diagnostics/build-electron-variant.ps1 -ElectronVersion 44.3.0 -OutDir 'D:\joy-electron-variant'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ElectronVersion,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [switch]$GD3Approved
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$plan = @(
    "Electron variant for the bisect: $ElectronVersion, into $OutDir (outside the repository)."
    '1. Download the official Windows x64 runtime for that version (GD3), and check its SHA-256 against the release file.'
    '2. Copy it, rename electron.exe to joy-media.exe, and build the kit with build-g1-kit.ps1 pointed at it.'
    '3. Record the version, the hash, and the commit in kit.txt. Nothing is installed on the PC.'
)

if (-not $GD3Approved) {
    $plan | ForEach-Object { Write-Output $_ }
    Write-Output 'GD3 is not approved. Nothing was downloaded, and nothing was changed.'
    exit 0
}

throw 'The variant download is not implemented in G0. It needs GD3 and its own reviewed change.'
