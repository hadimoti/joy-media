# T-R01: the sample media the app ships for its two sample projects.
#
# Five small files made with ffmpeg from synthetic sources (no third-party footage):
# three 30 s videos (intro, product, outro), a product still and a 30 s audio bed.
# They are built in the path-guarded fixture folder first, then copied into the app's
# public reference folder, which the sample projects' asset ids point at.
#
# Usage: pwsh tooling/qa/fixtures/make-sample-media.ps1
#        pwsh tooling/qa/fixtures/make-sample-media.ps1 -OutDir <guarded folder> -AppDir <public reference folder>

param(
  [string]$OutDir = 'C:\jgp\v111\fixtures',
  [string]$AppDir = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'fixture-path.ps1')

$OutDir = Resolve-FixtureOutDir -Path $OutDir
$repoAppDir = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot '..\..\..\apps\editor-web\public\media\reference')
)
if ($AppDir -eq '') {
  $AppDir = $repoAppDir
}
$AppDir = [System.IO.Path]::GetFullPath($AppDir)
# The copy target is restricted to the repo's own reference folder; any other -AppDir is refused.
if ($AppDir -ne $repoAppDir) {
  throw "-AppDir must be the repo folder $repoAppDir, not $AppDir"
}

$work = Join-Path $OutDir 'sample-media'
New-Item -ItemType Directory -Path $work -Force | Out-Null
New-Item -ItemType Directory -Path $AppDir -Force | Out-Null

function Invoke-Ffmpeg {
  param([string[]]$Arguments)
  & ffmpeg -hide_banner -v error -y -fflags +bitexact @Arguments
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed: $($Arguments -join ' ')" }
}

# One 30 s vertical video per sample, at the size the sample assets declare (1080 x 1920).
# The bitrate keeps each file in the few-hundred-KB range.
$videos = @(
  @{ name = 'asset-intro.mp4'; source = 'testsrc2=size=1080x1920:rate=30' },
  @{ name = 'asset-product.mp4'; source = 'mandelbrot=size=1080x1920:rate=30' },
  @{ name = 'asset-outro.mp4'; source = 'gradients=size=1080x1920:rate=30:speed=0.02' }
)
foreach ($video in $videos) {
  $path = Join-Path $work $video.name
  Invoke-Ffmpeg -Arguments @(
    '-f', 'lavfi', '-i', $video.source,
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=30',
    '-t', '30', '-ac', '2', '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
    '-b:v', '90k', '-maxrate', '110k', '-bufsize', '220k',
    '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart',
    $path
  )
}

# The product still: one picture, small.
$still = Join-Path $work 'product-still.png'
Invoke-Ffmpeg -Arguments @('-f', 'lavfi', '-i', 'testsrc2=size=1024x1024:rate=1', '-frames:v', '1', $still)

# The audio bed for the showcase: 30 s, stereo, AAC.
$audio = Join-Path $work 'showcase-audio-asset.m4a'
Invoke-Ffmpeg -Arguments @(
  '-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*220*t)+0.1*sin(2*PI*277.18*t)|0.2*sin(2*PI*220*t)+0.1*sin(2*PI*329.63*t):s=48000:d=30',
  '-c:a', 'aac', '-b:a', '48k', $audio
)

$names = @('asset-intro.mp4', 'asset-product.mp4', 'asset-outro.mp4', 'product-still.png', 'showcase-audio-asset.m4a')
$total = 0
foreach ($name in $names) {
  Copy-Item -LiteralPath (Join-Path $work $name) -Destination (Join-Path $AppDir $name) -Force
  $size = (Get-Item -LiteralPath (Join-Path $AppDir $name)).Length
  $total += $size
  Write-Output ("{0} {1}" -f $name, $size)
}
Write-Output "total $total bytes in $AppDir"
