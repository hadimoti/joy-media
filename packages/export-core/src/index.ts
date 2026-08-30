import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
export type ExportPresetId =
  'social-h264-aac' | 'reels-1080' | 'shorts-1080' | 'youtube-1080' | 'high-bitrate';

export interface RenderManifest {
  readonly projectId: string;
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly durationUs: number;
  readonly preset: ExportPresetId;
}

export function dimensionsForPreset(
  preset: ExportPresetId,
  fallback: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } {
  switch (preset) {
    case 'reels-1080':
    case 'shorts-1080':
      return { width: 1080, height: 1920 };
    case 'youtube-1080':
      return { width: 1920, height: 1080 };
    case 'high-bitrate':
      return { width: Math.max(fallback.width, 1920), height: Math.max(fallback.height, 1080) };
    default:
      return fallback;
  }
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
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${randomUUID()}.partial.mp4`,
  );
  try {
    const result = spawnSync('ffmpeg', ffmpegArgs(manifest, temporaryPath), {
      shell: false,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`ffmpeg export failed: ${result.stderr}`);
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * Encodes already-evaluated RGBA frames through the same verified FFmpeg path
 * used by exports. It is the scene/reel boundary: callers provide pixels, not
 * DOM or project objects, and FFmpeg receives raw video over stdin.
 */
export function renderRgbaFrames(
  manifest: RenderManifest,
  frames: readonly Uint8Array[],
  outputPath: string,
): void {
  const frozen = freezeManifest(manifest);
  if (frames.length === 0) throw new RangeError('at least one RGBA frame is required for export');
  const bytesPerFrame = frozen.width * frozen.height * 4;
  if (frames.some((frame) => frame.length !== bytesPerFrame)) {
    throw new RangeError(`every RGBA frame must contain exactly ${bytesPerFrame} bytes`);
  }
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${randomUUID()}.partial.mp4`,
  );
  try {
    const result = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'rawvideo',
        '-pixel_format',
        'rgba',
        '-video_size',
        `${frozen.width}x${frozen.height}`,
        '-framerate',
        String(frozen.frameRate),
        '-i',
        'pipe:0',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=stereo',
        '-frames:v',
        String(frames.length),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        temporaryPath,
      ],
      { shell: false, input: Buffer.concat(frames.map((frame) => Buffer.from(frame))) },
    );
    if (result.status !== 0)
      throw new Error(`ffmpeg RGBA export failed: ${result.stderr.toString()}`);
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    throw error;
  }
}
export interface ExportProbe {
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly width: number;
  readonly height: number;
  readonly durationUs: number;
  readonly frameRate: number;
  readonly videoStreamCount: number;
  readonly audioStreamCount: number;
}
export function verifyExport(outputPath: string): ExportProbe {
  const result = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration',
      '-of',
      'json',
      outputPath,
    ],
    { shell: false, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`ffprobe verification failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as {
    streams: {
      codec_type: string;
      codec_name: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }[];
    format?: { duration?: string };
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
  if (video.codec_name !== 'h264' || audio.codec_name !== 'aac')
    throw new Error(`export codecs must be h264/aac, got ${video.codec_name}/${audio.codec_name}`);
  const durationSeconds = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
    throw new Error('export duration is missing or invalid');
  const frameRate = parseFrameRate(video.r_frame_rate);
  return {
    videoCodec: video.codec_name,
    audioCodec: audio.codec_name,
    width: video.width,
    height: video.height,
    durationUs: Math.round(durationSeconds * 1_000_000),
    frameRate,
    videoStreamCount: parsed.streams.filter((stream) => stream.codec_type === 'video').length,
    audioStreamCount: parsed.streams.filter((stream) => stream.codec_type === 'audio').length,
  };
}

/** Validate a completed export against the immutable render manifest. */
export function verifyExportAgainstManifest(
  outputPath: string,
  manifest: RenderManifest,
  durationToleranceUs = Math.ceil(1_000_000 / manifest.frameRate),
): ExportProbe {
  const expected = freezeManifest(manifest);
  const probe = verifyExport(outputPath);
  if (probe.width !== expected.width || probe.height !== expected.height)
    throw new Error(`export dimensions differ from manifest: ${probe.width}x${probe.height}`);
  if (Math.abs(probe.durationUs - expected.durationUs) > durationToleranceUs)
    throw new Error(
      `export duration differs from manifest by ${Math.abs(probe.durationUs - expected.durationUs)} µs`,
    );
  if (Math.abs(probe.frameRate - expected.frameRate) > 0.01)
    throw new Error(`export frame rate differs from manifest: ${probe.frameRate}`);
  if (probe.videoStreamCount !== 1 || probe.audioStreamCount !== 1)
    throw new Error('export must contain exactly one video and one audio stream');
  return probe;
}

function parseFrameRate(value: string | undefined): number {
  if (value === undefined) throw new Error('export frame rate is missing');
  const parts = value.split('/').map(Number);
  const numerator = parts[0] ?? Number.NaN;
  const denominator = parts[1] ?? 1;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0)
    throw new Error(`export frame rate is invalid: ${value}`);
  return numerator / denominator;
}

export function remuxBrowserMp4(
  inputPath: string,
  outputPath: string,
  frameRate = 30,
  frameCount?: number,
): ExportProbe {
  if (!Number.isFinite(frameRate) || frameRate <= 0 || frameRate > 120)
    throw new RangeError('browser remux frame rate is invalid');
  if (
    frameCount !== undefined &&
    (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount / frameRate > 86_400)
  )
    throw new RangeError('browser remux frame count is invalid');
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${randomUUID()}.partial.mp4`,
  );
  try {
    const normalizeTimeline =
      frameCount === undefined
        ? []
        : [
            '-vf',
            // CanvasCaptureMediaStreamTrack is realtime and may deliver one
            // fewer frame on a cold/software Chromium encoder. Keep the
            // authored cadence and clone the terminal decoded frame when the
            // recorder is short, so the remuxed contract is exactly the
            // manifest's frame count rather than silently truncating it.
            `setpts=N/(${frameRate}*TB),tpad=stop_mode=clone:stop=-1`,
            '-af',
            'asetpts=PTS-STARTPTS,apad',
            '-frames:v',
            String(frameCount),
            '-t',
            (frameCount / frameRate).toFixed(6),
          ];
    const result = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-i',
        inputPath,
        ...normalizeTimeline,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-r',
        String(frameRate),
        '-movflags',
        '+faststart',
        temporaryPath,
      ],
      { shell: false, encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(`ffmpeg remux failed: ${result.stderr}`);
    renameSync(temporaryPath, outputPath);
    return verifyExport(outputPath);
  } catch (error) {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    throw error;
  }
}
