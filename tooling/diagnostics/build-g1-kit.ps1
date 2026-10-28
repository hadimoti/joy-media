<#
.SYNOPSIS
Builds the G1 kit for the attended GPU diagnosis (plan section 10d, G0 item 6). The kit goes outside the repository.

.DESCRIPTION
Builds the instrumented app at the current commit, which must be clean, and assembles it as a portable folder: the pinned
Electron runtime with electron.exe renamed to joy-media.exe, as package-installer.mjs does, and the app in resources\app.
It also copies the diagnostic tools into a `tree` folder that mirrors the repository paths, so each tool's "outside the
repository" check works. It writes SHA256SUMS.txt over every file in the kit, and kit.txt with the commit.

It runs no diagnostic and starts no app. Nothing in the kit is a setup executable, and nothing is installed on this PC.

.PARAMETER OutDir
The kit folder. It must lie outside the repository.

.PARAMETER PnpmDirectory
The folder that holds pnpm (pnpm 11.15.0, as the repository pins). It is added to PATH for the builds.

.EXAMPLE
pwsh -NoProfile -File tooling/diagnostics/build-g1-kit.ps1 -OutDir 'D:\joy-g1-kit' -PnpmDirectory 'D:\pnpm'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutDir,
    [string]$PnpmDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$outFull = [System.IO.Path]::GetFullPath($OutDir)
if ($outFull -eq $repoRoot -or $outFull.StartsWith($repoRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutDir must be outside the repository; the kit holds a build and raw tooling output.'
}
if ($PnpmDirectory) { $env:PATH = (Resolve-Path -LiteralPath $PnpmDirectory).Path + ';' + $env:PATH }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm is not on PATH. Pass -PnpmDirectory.' }

Push-Location $repoRoot
try {
    $dirty = @(git status --porcelain)
    if ($dirty.Count -gt 0) { throw 'The working tree is not clean. Commit the G0 work first; the kit is built at a commit.' }
    $commit = (git rev-parse HEAD).Trim()

    if (Test-Path -LiteralPath $outFull) { throw "The kit folder already exists: $outFull. Choose a new folder." }
    New-Item -ItemType Directory -Path $outFull | Out-Null

    # 1. The instrumented app. The builds are plain compilation; nothing is launched.
    pnpm --filter @joy-media/editor-web build
    if ($LASTEXITCODE -ne 0) { throw "editor-web build failed with exit code $LASTEXITCODE." }
    pnpm --filter @joy-media/worker build
    if ($LASTEXITCODE -ne 0) { throw "worker build failed with exit code $LASTEXITCODE." }
    pnpm --filter @joy-media/desktop build
    if ($LASTEXITCODE -ne 0) { throw "desktop build failed with exit code $LASTEXITCODE." }
    $packageFolder = Join-Path $outFull 'package'
    node apps/desktop/scripts/package-release.mjs --unpacked --instrumented --out $packageFolder
    if ($LASTEXITCODE -ne 0) { throw "package-release.mjs failed with exit code $LASTEXITCODE." }

    # 2. The portable app: the pinned Electron runtime, renamed to joy-media.exe, with the app in resources\app.
    Push-Location (Join-Path $repoRoot 'apps\desktop')
    try { $electronExe = (node -e "process.stdout.write(require('electron'))").Trim() }
    finally { Pop-Location }
    $electronDist = Split-Path -Parent $electronExe
    $appFolder = Join-Path $outFull 'app'
    New-Item -ItemType Directory -Path $appFolder -Force | Out-Null
    Get-ChildItem -LiteralPath $electronDist -Force | Copy-Item -Destination $appFolder -Recurse -Force
    Rename-Item -LiteralPath (Join-Path $appFolder 'electron.exe') -NewName 'joy-media.exe'
    Remove-Item -LiteralPath (Join-Path $appFolder 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue
    $resourcesApp = Join-Path $appFolder 'resources\app'
    New-Item -ItemType Directory -Path $resourcesApp -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $packageFolder 'joy-media-unpacked') -Force |
        Copy-Item -Destination $resourcesApp -Recurse -Force
    Remove-Item -LiteralPath $packageFolder -Recurse -Force

    # 3. The tools, under a tree that mirrors the repository, so each tool's "outside the repository" check is correct.
    $tree = Join-Path $outFull 'tree'
    $diagnostics = Join-Path $tree 'tooling\diagnostics'
    $probeFolder = Join-Path $diagnostics 'mf-probe'
    $src = Join-Path $diagnostics 'src'
    $stageProbe = Join-Path $tree 'tests\desktop\gpu-probe'
    $desktopFolder = Join-Path $tree 'apps\desktop'
    foreach ($folder in $probeFolder, $src, $stageProbe, $desktopFolder) {
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
    }
    pwsh -NoProfile -File (Join-Path $repoRoot 'tooling\diagnostics\mf-probe\build-mf-probe.ps1') -OutDir $probeFolder
    if ($LASTEXITCODE -ne 0) { throw "build-mf-probe.ps1 failed with exit code $LASTEXITCODE." }
    Copy-Item -Path (Join-Path $repoRoot 'tooling\diagnostics\mf-probe\run-mf-encode.ps1') -Destination $probeFolder
    Copy-Item -Path (Join-Path $repoRoot 'tooling\diagnostics\src\gpu-inventory.ts') -Destination $src
    Copy-Item -Path (Join-Path $repoRoot 'tooling\diagnostics\src\redact-gpu-report.ts') -Destination $src
    Copy-Item -Path (Join-Path $repoRoot 'tooling\diagnostics\sample-encoder-sessions.ps1') -Destination $diagnostics
    Copy-Item -Path (Join-Path $repoRoot 'tooling\diagnostics\read-wer-events.ps1') -Destination $diagnostics
    foreach ($name in 'run-stage-probe.mjs', 'probe-main.cjs', 'probe-stages.js', 'probe-page.html', 'fake-stage-page.html') {
        Copy-Item -Path (Join-Path $repoRoot "tests\desktop\gpu-probe\$name") -Destination $stageProbe
    }
    # The stage runner reads the pinned Electron version from the desktop manifest next to it in this tree.
    Copy-Item -Path (Join-Path $repoRoot 'apps\desktop\package.json') -Destination $desktopFolder

    # 4. The record: the commit, the pinned runtime, the thresholds digest, and a SHA-256 over every file in the kit.
    $manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'apps\desktop\package.json') -Raw | ConvertFrom-Json
    # The pin may sit under either section, as the stage probe reads it.
    $electronPin = @($manifest.devDependencies, $manifest.dependencies) |
        Where-Object { $null -ne $_ -and ($_.PSObject.Properties.Name -contains 'electron') } |
        ForEach-Object { $_.electron } | Select-Object -First 1
    $thresholdsSha256 = (Get-FileHash -LiteralPath (Join-Path $repoRoot 'docs\qa\attended\model-thresholds.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    $kitRecord = @(
        "commit: $commit"
        "built-utc: $((Get-Date).ToUniversalTime().ToString('o'))"
        "build: instrumented (package-release.mjs --unpacked --instrumented)"
        "electron: $electronPin"
        "thresholds-sha256: $thresholdsSha256"
        "node: $(node --version)"
    )
    Set-Content -LiteralPath (Join-Path $outFull 'kit.txt') -Value $kitRecord -Encoding UTF8
    $sums = Get-ChildItem -LiteralPath $outFull -Recurse -File | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } | Sort-Object FullName |
        ForEach-Object {
            $relative = $_.FullName.Substring($outFull.Length + 1).Replace('\', '/')
            '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relative
        }
    Set-Content -LiteralPath (Join-Path $outFull 'SHA256SUMS.txt') -Value $sums -Encoding UTF8
    Write-Output "kit: $outFull ($($sums.Count) files, commit $commit)"
}
finally {
    Pop-Location
}
