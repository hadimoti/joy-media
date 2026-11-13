# Build script for joy-media-setup.exe using Microsoft .NET Framework C# compiler (csc.exe)
# Usage: build-installer.ps1 [-Version 1.1.1]
param(
    [string]$Version = "1.1.1"
)
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$distReleases = Join-Path $repoRoot "apps\desktop\dist\releases"
$zipPath = Join-Path $distReleases "joy-media-windows-x64-v$Version.zip"
$outExe = Join-Path $distReleases "joy-media-setup.exe"
$srcCs = Join-Path $PSScriptRoot "Setup.cs"
$srcUserPath = Join-Path $PSScriptRoot "UserPath.cs"

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
    "/resource:$zipPath,payload.zip" "/out:$outExe" $srcCs $srcUserPath

if ($LASTEXITCODE -ne 0) {
    throw "Compilation failed with code $LASTEXITCODE"
}

Write-Host "Successfully built $outExe ($((Get-Item $outExe).Length) bytes)."

# The packager writes SHA256SUMS.txt before this script builds the setup, so the setup's digest is added
# here. The release gate and the download check use that file as the checksum source, so a missing file
# stops the build. A line for the setup from an earlier build is replaced, because a rebuild gives a new
# file with a new digest. (SUMS-BLOCK-BEGIN)
$sumsPath = Join-Path $distReleases "SHA256SUMS.txt"
if (-not (Test-Path -LiteralPath $sumsPath -PathType Leaf)) {
    throw "SHA256SUMS.txt not found at $sumsPath. Run desktop packager first."
}
$sumsEntries = [System.Collections.Generic.List[string]]::new()
foreach ($line in (Get-Content -LiteralPath $sumsPath)) {
    if ($line.Trim() -ne "" -and $line -notmatch '\sjoy-media-setup\.exe$') { $sumsEntries.Add($line) }
}
$setupSha256 = (Get-FileHash -LiteralPath $outExe -Algorithm SHA256).Hash.ToLowerInvariant()
$sumsEntries.Add("$setupSha256  joy-media-setup.exe")
[IO.File]::WriteAllText($sumsPath, (($sumsEntries -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
Write-Host "Recorded joy-media-setup.exe in $sumsPath."
# (SUMS-BLOCK-END)

# The release manifest lists the setup exe as well. The packager writes the manifest before the setup exists,
# so the setup's entry is added here with the same digest as SHA256SUMS.txt. A rebuilt setup replaces its entry.
# (MANIFEST-BLOCK-BEGIN)
$manifestPath = Join-Path $distReleases "joy-media-release-manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "joy-media-release-manifest.json not found at $manifestPath. Run desktop packager first."
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$setupEntry = [pscustomobject]@{
    fileName = "joy-media-setup.exe"
    type     = "installer"
    byteSize = (Get-Item -LiteralPath $outExe).Length
    sha256   = (Get-FileHash -LiteralPath $outExe -Algorithm SHA256).Hash.ToLowerInvariant()
}
$otherArtifacts = @($manifest.artifacts | Where-Object { $_.fileName -ne "joy-media-setup.exe" })
$manifest.artifacts = @($otherArtifacts + $setupEntry)
[IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 10) + "`n"), [Text.UTF8Encoding]::new($false))
Write-Host "Recorded joy-media-setup.exe in $manifestPath."
# (MANIFEST-BLOCK-END)
