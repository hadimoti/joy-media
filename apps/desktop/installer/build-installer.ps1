# Build script for joy-media-setup.exe using Microsoft .NET Framework C# compiler (csc.exe)
# Usage: build-installer.ps1 [-Version 1.0.1]
param(
    [string]$Version = "1.0.0"
)
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$distReleases = Join-Path $repoRoot "apps\desktop\dist\releases"
$zipPath = Join-Path $distReleases "joy-media-windows-x64-v$Version.zip"
$outExe = Join-Path $distReleases "joy-media-setup.exe"
$srcCs = Join-Path $PSScriptRoot "Setup.cs"

# The installer displays and registers InstallerEngine.ProductVersion; refuse to embed a payload
# whose version does not match it so the Add/Remove Programs entry can never lie.
$sourceVersion = (Select-String -Path $srcCs -Pattern 'ProductVersion = "([^"]+)"').Matches[0].Groups[1].Value
if ($sourceVersion -ne $Version) {
    throw "Setup.cs ProductVersion is '$sourceVersion' but -Version is '$Version'. Update both together."
}

if (-not (Test-Path $zipPath)) {
    throw "Payload zip not found at $zipPath. Run desktop packager first."
}

$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    $csc = (Get-Command csc.exe -ErrorAction SilentlyContinue)?.Source
}
if (-not $csc -or -not (Test-Path $csc)) {
    throw "csc.exe compiler not found."
}

Write-Host "Compiling $outExe with payload $zipPath..."
& $csc /target:winexe /optimize+ /platform:x64 `
    /reference:System.dll,System.Core.dll,Microsoft.CSharp.dll,System.Drawing.dll,System.Windows.Forms.dll,System.IO.Compression.dll,System.IO.Compression.FileSystem.dll `
    "/resource:$zipPath,payload.zip" "/out:$outExe" $srcCs

if ($LASTEXITCODE -ne 0) {
    throw "Compilation failed with code $LASTEXITCODE"
}

Write-Host "Successfully built $outExe ($((Get-Item $outExe).Length) bytes)."
