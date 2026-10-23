# Build script for joy-media-setup.exe using Microsoft .NET Framework C# compiler (csc.exe)
# Usage: build-installer.ps1 [-Version <desktop package version>]
param(
    [string]$Version = ""
)
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$desktopManifestPath = Join-Path (Split-Path -Parent $PSScriptRoot) "package.json"
$desktopManifest = Get-Content -LiteralPath $desktopManifestPath -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = [string]$desktopManifest.version
}
if ($desktopManifest.version -ne $Version) {
    throw "Desktop package version is '$($desktopManifest.version)' but -Version is '$Version'."
}
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
    $cscCommand = Get-Command csc.exe -ErrorAction SilentlyContinue
    if ($cscCommand) {
        $csc = $cscCommand.Source
    } else {
        $csc = $null
    }
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

# The packager has already written SHA256SUMS.txt, and the setup is built after it, so the setup's
# digest is appended here. The release gate uses this file as its independent checksum source, so a
# missing file or a second setup line stops the build instead of guessing.
$sumsPath = Join-Path $distReleases "SHA256SUMS.txt"
if (-not (Test-Path -LiteralPath $sumsPath -PathType Leaf)) {
    throw "SHA256SUMS.txt not found at $sumsPath. Run desktop packager first."
}
$sumsEntries = [System.Collections.Generic.List[string]]::new()
foreach ($line in (Get-Content -LiteralPath $sumsPath)) {
    if ($line.Trim() -ne "") { $sumsEntries.Add($line) }
}
if (@($sumsEntries | Where-Object { $_ -match '\sjoy-media-setup\.exe$' }).Count -gt 0) {
    throw "SHA256SUMS.txt already lists joy-media-setup.exe."
}
$setupSha256 = (Get-FileHash -LiteralPath $outExe -Algorithm SHA256).Hash.ToLowerInvariant()
$sumsEntries.Add("$setupSha256  joy-media-setup.exe")
[IO.File]::WriteAllText($sumsPath, (($sumsEntries -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
Write-Host "Recorded joy-media-setup.exe in $sumsPath."
