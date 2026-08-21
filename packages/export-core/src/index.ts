import { spawn, spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
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

export interface StreamedRgbaExportResult {
  readonly frames: number;
}

export interface RenderRgbaFrameStreamOptions {
  /** Signed 16-bit little-endian stereo PCM at 48 kHz, streamed alongside video frames. */
  readonly pcmS16leStereo48000?: AsyncIterable<Uint8Array>;
}

/**
 * Encodes RGBA frames by writing each frame to FFmpeg stdin as it is produced.
 * Callers can render long projects lazily without concatenating every frame
 * into a single in-memory payload.
 */
export async function renderRgbaFrameStream(
  manifest: RenderManifest,
  frames: AsyncIterable<Uint8Array>,
  outputPath: string,
  options: RenderRgbaFrameStreamOptions = {},
): Promise<StreamedRgbaExportResult> {
  const frozen = freezeManifest(manifest);
  const bytesPerFrame = frozen.width * frozen.height * 4;
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${randomUUID()}.partial.mp4`,
  );
  let frameCount = 0;
  const hasProgramAudio = options.pcmS16leStereo48000 !== undefined;
  const audioInputArgs = hasProgramAudio
    ? ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:3']
    : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
  const child = spawn(
    'ffmpeg',
    [
      '-y',
      '-nostdin',
      '-v',
      'error',
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
      ...audioInputArgs,
      '-shortest',
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
    {
      shell: false,
      stdio: hasProgramAudio ? ['pipe', 'ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'],
    },
  );
  if (child.stdin === null || child.stderr === null)
    throw new Error('ffmpeg streaming pipes are unavailable');
  const videoInput = child.stdin;
  const errorOutput = child.stderr;
  const audioInput =
    hasProgramAudio && child.stdio[3] !== null && child.stdio[3] !== undefined
      ? (child.stdio[3] as Writable)
      : undefined;
  if (hasProgramAudio && audioInput === undefined)
    throw new Error('ffmpeg program audio pipe is unavailable');
  const stderr: Buffer[] = [];
  errorOutput.on('data', (chunk: Buffer) => stderr.push(chunk));
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const audioWrite =
    options.pcmS16leStereo48000 === undefined
      ? Promise.resolve()
      : writeChunks(options.pcmS16leStereo48000, audioInput!);
  try {
    for await (const frame of frames) {
      if (frame.length !== bytesPerFrame) {
        throw new RangeError(`every RGBA frame must contain exactly ${bytesPerFrame} bytes`);
      }
      frameCount++;
      if (!videoInput.write(Buffer.from(frame))) await once(videoInput, 'drain');
    }
    videoInput.end();
    await audioWrite;
    const status = await closed;
    if (frameCount === 0) throw new RangeError('at least one RGBA frame is required for export');
    if (status !== 0) {
      throw new Error(`ffmpeg streaming RGBA export failed: ${Buffer.concat(stderr).toString()}`);
    }
    renameSync(temporaryPath, outputPath);
    return { frames: frameCount };
  } catch (error) {
    if (!child.killed) child.kill();
    videoInput.destroy();
    audioInput?.destroy();
    await audioWrite.catch(() => undefined);
    await closed.catch(() => undefined);
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    throw error;
  }
}

async function writeChunks(chunks: AsyncIterable<Uint8Array>, stream: Writable): Promise<void> {
  try {
    for await (const chunk of chunks) {
      if (!stream.write(Buffer.from(chunk))) await once(stream, 'drain');
    }
    stream.end();
  } catch (error) {
    stream.destroy();
    throw error;
  }
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
  if (video.codec_name !== 'h264' || audio.codec_name !== 'aac')
    throw new Error(`export codecs must be h264/aac, got ${video.codec_name}/${audio.codec_name}`);
  return {
    videoCodec: video.codec_name,
    audioCodec: audio.codec_name,
    width: video.width,
    height: video.height,
  };
}
