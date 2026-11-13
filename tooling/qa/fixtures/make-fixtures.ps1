# T-A04: the media fixture pack for the live tests.
#
# Builds the fixtures with ffmpeg only (the test sources are ffmpeg's own
# generators, so nothing is copied from the owner's folders), probes each
# output with ffprobe, and writes manifest.json next to them with size,
# duration, streams and SHA-256. Only this script and the manifest are
# committed. The media itself stays outside the repository.
#
# Usage:
#   pwsh tooling/qa/fixtures/make-fixtures.ps1 -OutDir C:\jgp\v111\fixtures
#   pwsh tooling/qa/fixtures/make-fixtures.ps1 -OutDir C:\jgp\v111\fixtures -CheckAgainst <older manifest.json>
#
# -CheckAgainst fails if any lossless item has a different SHA-256 from that
# manifest. Lossy items are not compared: their hashes depend on the encoder.

param(
  [string]$OutDir = 'C:\jgp\v111\fixtures',
  [string]$CheckAgainst = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Ffmpeg {
  param([string[]]$Arguments)
  & ffmpeg -hide_banner -v error -y -fflags +bitexact @Arguments
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed: $($Arguments -join ' ')" }
}

function Get-Field {
  param($Object, [string]$Name)
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Get-Probe {
  param([string]$Path)
  $json = & ffprobe -hide_banner -v error -print_format json -show_format -show_streams $Path
  if ($LASTEXITCODE -ne 0) { throw "ffprobe failed on $Path" }
  return ($json | ConvertFrom-Json)
}

# Each spec: the output name, whether it is lossless, the expected kind and the
# ffmpeg arguments that make it (the output path is appended).
$video = 'testsrc2'
$tone = 'sine=frequency=440:sample_rate=48000'
$specs = @(
  @{ name = 'h264-16x9-audio.mp4'; lossless = $false; kind = 'video';
     args = @('-f','lavfi','-i',"$video=size=1280x720:rate=30:duration=3",'-f','lavfi','-i',"${tone}:duration=3",'-ac','2','-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k') },
  @{ name = 'h264-16x9-silent.mp4'; lossless = $false; kind = 'video';
     args = @('-f','lavfi','-i',"$video=size=1280x720:rate=30:duration=3",'-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-an') },
  @{ name = 'h264-9x16-audio.mp4'; lossless = $false; kind = 'video';
     args = @('-f','lavfi','-i',"$video=size=1080x1920:rate=30:duration=3",'-f','lavfi','-i',"${tone}:duration=3",'-ac','2','-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k') },
  @{ name = 'h264-9x16-silent.mp4'; lossless = $false; kind = 'video';
     args = @('-f','lavfi','-i',"$video=size=1080x1920:rate=30:duration=3",'-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-an') },
  @{ name = 'h264-4x3-audio.mp4'; lossless = $false; kind = 'video';
     args = @('-f','lavfi','-i',"$video=size=960x720:rate=30:duration=3",'-f','lavfi','-i',"${tone}:duration=3",'-ac','2','-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k') },
  @{ name = 'h264-4x3-silent.mp4'; lossless = $false; kind = 'video';
     args = @('-f','lavfi','-i',"$video=size=960x720:rate=30:duration=3",'-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-an') },
  @{ name = 'h264-1x1-audio.mp4'; lossless = $false; kind = 'video';
     args = @('-f','lavfi','-i',"$video=size=720x720:rate=30:duration=3",'-f','lavfi','-i',"${tone}:duration=3",'-ac','2','-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k') },
  @{ name = 'h264-1x1-silent.mp4'; lossless = $false; kind = 'video';
     args = @('-f','lavfi','-i',"$video=size=720x720:rate=30:duration=3",'-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-an') },
  @{ name = 'h264-60fps-audio.mp4'; lossless = $false; kind = 'video';
     args = @('-f','lavfi','-i',"$video=size=1280x720:rate=60:duration=3",'-f','lavfi','-i',"${tone}:duration=3",'-ac','2','-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k') },
  @{ name = 'vp9-webm-audio.webm'; lossless = $false; kind = 'video';
     args = @('-f','lavfi','-i',"$video=size=1280x720:rate=30:duration=3",'-f','lavfi','-i',"${tone}:duration=3",'-ac','2','-c:v','libvpx-vp9','-b:v','1M','-deadline','realtime','-cpu-used','8','-threads','1','-pix_fmt','yuv420p','-c:a','libopus','-b:a','96k') },
  @{ name = 'untagged-sd.mp4'; lossless = $false; kind = 'video';
     args = @('-f','lavfi','-i',"$video=size=640x480:rate=25:duration=3",'-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-an') },
  @{ name = 'h264-1080p-10min.mp4'; lossless = $false; kind = 'video';
     args = @('-f','lavfi','-i',"$video=size=1920x1080:rate=12:duration=600",'-f','lavfi','-i',"${tone}:duration=600",'-ac','2','-c:v','libx264','-preset','ultrafast','-crf','30','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k') },
  @{ name = 'picture-8k.png'; lossless = $true; kind = 'picture';
     args = @('-f','lavfi','-i',"$video=size=7680x4320:rate=1",'-frames:v','1') },
  @{ name = 'picture-tiny.png'; lossless = $true; kind = 'picture';
     args = @('-f','lavfi','-i','color=c=0x2a6fdb:size=16x16:rate=1','-frames:v','1') },
  @{ name = 'picture-1080.jpg'; lossless = $false; kind = 'picture';
     args = @('-f','lavfi','-i',"$video=size=1920x1080:rate=1",'-frames:v','1','-q:v','3') },
  @{ name = 'picture-720-lossless.webp'; lossless = $true; kind = 'picture';
     args = @('-f','lavfi','-i',"$video=size=1280x720:rate=1",'-frames:v','1','-c:v','libwebp','-lossless','1') },
  @{ name = 'picture-tiny.webp'; lossless = $false; kind = 'picture';
     args = @('-f','lavfi','-i','color=c=0xdb6f2a:size=8x8:rate=1','-frames:v','1','-c:v','libwebp','-q:v','80') },
  @{ name = 'audio-stereo.wav'; lossless = $true; kind = 'audio';
     args = @('-f','lavfi','-i',"${tone}:duration=3",'-ac','2','-c:a','pcm_s16le') },
  @{ name = 'audio-silent.wav'; lossless = $true; kind = 'audio';
     args = @('-f','lavfi','-i','anullsrc=r=48000:cl=stereo:d=3','-c:a','pcm_s16le') },
  @{ name = 'audio-clipped.wav'; lossless = $true; kind = 'audio';
     args = @('-f','lavfi','-i','aevalsrc=3*sin(2*PI*440*t)|3*sin(2*PI*440*t):s=48000:d=3','-c:a','pcm_s16le') },
  @{ name = 'audio-mp3.mp3'; lossless = $false; kind = 'audio';
     args = @('-f','lavfi','-i',"${tone}:duration=3",'-ac','2','-c:a','libmp3lame','-b:a','128k') },
  @{ name = 'audio-aac.m4a'; lossless = $false; kind = 'audio';
     args = @('-f','lavfi','-i',"${tone}:duration=3",'-ac','2','-c:a','aac','-b:a','128k') }
)

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$ffmpegVersion = (& ffmpeg -version | Select-Object -First 1)

$items = foreach ($spec in $specs) {
  $path = Join-Path $OutDir $spec.name
  Invoke-Ffmpeg -Arguments ($spec.args + @($path))
  $probe = Get-Probe -Path $path
  $file = Get-Item -LiteralPath $path
  $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  $streams = foreach ($s in $probe.streams) {
    [ordered]@{
      type = Get-Field $s 'codec_type'
      codec = Get-Field $s 'codec_name'
      width = Get-Field $s 'width'
      height = Get-Field $s 'height'
      pixFmt = Get-Field $s 'pix_fmt'
      frameRate = Get-Field $s 'avg_frame_rate'
      sampleRate = Get-Field $s 'sample_rate'
      channels = Get-Field $s 'channels'
      colorSpace = Get-Field $s 'color_space'
      colorPrimaries = Get-Field $s 'color_primaries'
      colorTransfer = Get-Field $s 'color_transfer'
    }
  }
  [ordered]@{
    file = $spec.name
    kind = $spec.kind
    lossless = $spec.lossless
    bytes = $file.Length
    sha256 = $hash
    formatName = Get-Field $probe.format 'format_name'
    durationSeconds = [double](Get-Field $probe.format 'duration')
    streams = @($streams)
  }
}

$manifest = [ordered]@{
  task = 'T-A04'
  generator = $ffmpegVersion
  items = @($items)
}
$manifestPath = Join-Path $OutDir 'manifest.json'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Output "wrote $($items.Count) items and $manifestPath"

# Acceptance checks: every item probed, and the video rows match their spec.
$missing = $items | Where-Object { $_.streams.Count -eq 0 }
if ($missing) { throw "no streams in: $($missing.file -join ', ')" }

if ($CheckAgainst -ne '') {
  $older = Get-Content -LiteralPath $CheckAgainst -Raw | ConvertFrom-Json
  $mismatch = @()
  foreach ($item in $items | Where-Object { $_.lossless }) {
    $before = $older.items | Where-Object { $_.file -eq $item.file }
    if ($null -eq $before -or $before.sha256 -ne $item.sha256) { $mismatch += $item.file }
  }
  if ($mismatch.Count -gt 0) { throw "lossless hash changed: $($mismatch -join ', ')" }
  Write-Output 'lossless hashes match the earlier manifest'
}
