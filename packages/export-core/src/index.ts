import { spawnSync } from 'node:child_process';
export interface RenderManifest {
  readonly projectId: string;
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly durationUs: number;
  readonly preset: 'social-h264-aac';
}
export function freezeManifest(manifest: RenderManifest): RenderManifest {
  if (
    !Number.isSafeInteger(manifest.revision) ||
    manifest.revision < 0 ||
    !Number.isSafeInteger(manifest.width) ||
    !Number.isSafeInteger(manifest.height) ||
    manifest.width < 1 ||
    manifest.height < 1 ||
    !Number.isFinite(manifest.frameRate) ||
    manifest.frameRate <= 0 ||
    !Number.isSafeInteger(manifest.durationUs) ||
    manifest.durationUs < 1
  )
    throw new RangeError('render manifest is invalid');
  return Object.freeze({ ...manifest });
}
/** Arguments only: no shell interpolation or project-controlled executable paths. */
export function ffmpegArgs(manifest: RenderManifest, outputPath: string): readonly string[] {
  const frozen = freezeManifest(manifest);
  const durationSeconds = (frozen.durationUs / 1_000_000).toFixed(6);
  return [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${frozen.width}x${frozen.height}:r=${frozen.frameRate}`,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-t',
    durationSeconds,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    outputPath,
  ];
}
export function renderFixture(manifest: RenderManifest, outputPath: string): void {
  const result = spawnSync('ffmpeg', ffmpegArgs(manifest, outputPath), {
    shell: false,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`ffmpeg export failed: ${result.stderr}`);
}
export interface ExportProbe {
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly width: number;
  readonly height: number;
}
export function verifyExport(outputPath: string): ExportProbe {
  const result = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name,width,height',
      '-of',
      'json',
      outputPath,
    ],
    { shell: false, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`ffprobe verification failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as {
    streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
  };
  const video = parsed.streams.find((stream) => stream.codec_type === 'video');
  const audio = parsed.streams.find((stream) => stream.codec_type === 'audio');
  if (
    video === undefined ||
    audio === undefined ||
    video.width === undefined ||
    video.height === undefined
  )
    throw new Error('export is missing required H.264/AAC streams');
  return {
    videoCodec: video.codec_name,
    audioCodec: audio.codec_name,
    width: video.width,
    height: video.height,
  };
}
