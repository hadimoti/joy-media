# Build script for joy-media-setup.exe using Microsoft .NET Framework C# compiler (csc.exe)
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$distReleases = Join-Path $repoRoot "apps\desktop\dist\releases"
$zipPath = Join-Path $distReleases "joy-media-windows-x64-v1.0.0.zip"
$outExe = Join-Path $distReleases "joy-media-setup.exe"
$srcCs = Join-Path $PSScriptRoot "Setup.cs"

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
