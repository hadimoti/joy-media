$ErrorActionPreference = 'Stop'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

New-Item -ItemType Directory -Path 'C:\tools' -Force | Out-Null

$artifactBaseUrl = $env:JOY_MEDIA_WINDOWS_ARTIFACT_BASE_URL
$corepackRegistry = $env:JOY_MEDIA_WINDOWS_COREPACK_NPM_REGISTRY
function Save-PinnedDownload([string]$RemoteUri, [string]$Destination) {
    $downloadUri = $RemoteUri
    if (-not [string]::IsNullOrWhiteSpace($artifactBaseUrl)) {
        $fileName = [IO.Path]::GetFileName(([Uri]$RemoteUri).AbsolutePath)
        $downloadUri = $artifactBaseUrl.TrimEnd('/') + '/' + $fileName
    }
    Invoke-WebRequest -UseBasicParsing -Uri $downloadUri -OutFile $Destination
}

Write-Host 'Installing pinned MinGit'
$gitArchive = Join-Path $env:TEMP ("MinGit-$($env:GIT_VERSION).$($env:GIT_RELEASE_REVISION)-64-bit.zip")
Save-PinnedDownload "https://github.com/git-for-windows/git/releases/download/v$($env:GIT_VERSION).windows.$($env:GIT_RELEASE_REVISION)/MinGit-$($env:GIT_VERSION).$($env:GIT_RELEASE_REVISION)-64-bit.zip" $gitArchive
$gitActual = (Get-FileHash -LiteralPath $gitArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($gitActual -ne $env:GIT_SHA256) { throw "MinGit hash mismatch: expected $($env:GIT_SHA256), got $gitActual" }
Remove-Item -LiteralPath 'C:\git' -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $gitArchive -DestinationPath 'C:\git' -Force
Remove-Item -LiteralPath $gitArchive -Force
if (-not (Test-Path -LiteralPath 'C:\git\cmd\git.exe')) { throw 'MinGit archive did not contain the required git.exe.' }

Write-Host 'Installing pinned FFmpeg'
$ffmpegArchive = Join-Path $env:TEMP 'ffmpeg-win64.zip'
Save-PinnedDownload $env:FFMPEG_URL $ffmpegArchive
$ffmpegActual = (Get-FileHash -LiteralPath $ffmpegArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ffmpegActual -ne $env:FFMPEG_SHA256) { throw "FFmpeg hash mismatch: expected $($env:FFMPEG_SHA256), got $ffmpegActual" }
$ffmpegExtract = Join-Path $env:TEMP 'joy-ffmpeg-extract'
Remove-Item -LiteralPath $ffmpegExtract -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $ffmpegArchive -DestinationPath $ffmpegExtract -Force
$ffmpegRoot = Get-ChildItem -LiteralPath $ffmpegExtract -Directory | Select-Object -First 1
if (-not $ffmpegRoot -or -not (Test-Path -LiteralPath (Join-Path $ffmpegRoot.FullName 'bin\ffmpeg.exe'))) { throw 'FFmpeg archive did not contain the expected bin layout.' }
Remove-Item -LiteralPath 'C:\ffmpeg' -Recurse -Force -ErrorAction SilentlyContinue
Move-Item -LiteralPath $ffmpegRoot.FullName -Destination 'C:\ffmpeg'
Remove-Item -LiteralPath $ffmpegExtract -Recurse -Force
Remove-Item -LiteralPath $ffmpegArchive -Force

Write-Host 'Installing pinned jq'
$jqPath = 'C:\tools\jq.exe'
$jqDownload = Join-Path $env:TEMP ("jq-$($env:JQ_VERSION)-win64.exe")
Save-PinnedDownload "https://github.com/jqlang/jq/releases/download/jq-$($env:JQ_VERSION)/jq-win64.exe" $jqDownload
$jqActual = (Get-FileHash -LiteralPath $jqDownload -Algorithm SHA256).Hash.ToLowerInvariant()
if ($jqActual -ne $env:JQ_SHA256) { throw "jq hash mismatch: expected $($env:JQ_SHA256), got $jqActual" }
Move-Item -LiteralPath $jqDownload -Destination $jqPath -Force

Write-Host 'Installing pinned Node.js'
$nodeArchive = Join-Path $env:TEMP ("node-v$($env:NODE_VERSION)-win-x64.zip")
Save-PinnedDownload "https://nodejs.org/dist/v$($env:NODE_VERSION)/node-v$($env:NODE_VERSION)-win-x64.zip" $nodeArchive
$nodeActual = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($nodeActual -ne $env:NODE_SHA256) { throw "Node.js hash mismatch: expected $($env:NODE_SHA256), got $nodeActual" }
$nodeExtract = Join-Path $env:TEMP 'joy-node-extract'
Remove-Item -LiteralPath $nodeExtract -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract -Force
$nodeRoot = Get-ChildItem -LiteralPath $nodeExtract -Directory | Select-Object -First 1
if (-not $nodeRoot -or -not (Test-Path -LiteralPath (Join-Path $nodeRoot.FullName 'node.exe'))) { throw 'Node archive did not contain the expected node.exe layout.' }
Remove-Item -LiteralPath 'C:\node' -Recurse -Force -ErrorAction SilentlyContinue
Move-Item -LiteralPath $nodeRoot.FullName -Destination 'C:\node'
Remove-Item -LiteralPath $nodeExtract -Recurse -Force
Remove-Item -LiteralPath $nodeArchive -Force
& 'C:\node\corepack.cmd' enable
$env:COREPACK_HOME = 'C:\corepack'
if (-not [string]::IsNullOrWhiteSpace($corepackRegistry)) {
    $env:COREPACK_NPM_REGISTRY = $corepackRegistry
}
& 'C:\node\corepack.cmd' install --global pnpm@11.15.0
if ($LASTEXITCODE -ne 0) { throw "Corepack failed to install pnpm (exit code $LASTEXITCODE)." }

Write-Host 'Installing pinned GitHub Actions runner'
$runnerArchive = Join-Path $env:TEMP ("actions-runner-win-x64-$($env:RUNNER_VERSION).zip")
Save-PinnedDownload "https://github.com/actions/runner/releases/download/v$($env:RUNNER_VERSION)/actions-runner-win-x64-$($env:RUNNER_VERSION).zip" $runnerArchive
$runnerActual = (Get-FileHash -LiteralPath $runnerArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($runnerActual -ne $env:RUNNER_SHA256) { throw "Runner hash mismatch: expected $($env:RUNNER_SHA256), got $runnerActual" }
Expand-Archive -LiteralPath $runnerArchive -DestinationPath 'C:\actions-runner' -Force
Remove-Item -LiteralPath $runnerArchive -Force
New-Item -ItemType Directory -Path 'C:\actions-runner\_work' -Force | Out-Null
