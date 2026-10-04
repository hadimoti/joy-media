import { spawn, spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import { verifyExportAgainstManifest, type RenderManifest } from '@joy-media/export-core';
import type { FfmpegRenderPlan } from './ffmpeg-plan.js';

export interface FfmpegRunResult {
  readonly ffmpegVersion: string;
  readonly outputPath: string;
  readonly sha256: string;
  readonly probe: FfprobeSummary;
}

export interface FfprobeSummary {
  readonly width: number;
  readonly height: number;
  readonly durationUs: number;
  readonly videoCodec: string;
  readonly audioCodec: string | null;
  readonly videoStreamCount: number;
  readonly audioStreamCount: number;
  readonly frameRate: number;
}

export async function runFfmpegRender(options: {
  readonly plan: FfmpegRenderPlan;
  readonly outputPath: string;
  readonly preset: 'mp4' | 'webm' | 'prores';
  readonly onProgress?: (outTimeUs: number) => void;
}): Promise<FfmpegRunResult> {
  const executable = resolveFfmpegExecutable();
  const version = spawnSync(executable, ['-version'], { shell: false, encoding: 'utf8' });
  if (version.error || version.status !== 0) {
    throw new Error(
      `ffmpeg is unavailable (${version.error?.message ?? version.stderr.trim()}). Set JOY_FFMPEG to an executable path.`,
    );
  }
  const ffmpegVersion = version.stdout.split(/\r?\n/, 1)[0] ?? 'ffmpeg (unknown version)';
  const outputPath = options.outputPath;
  const extension = extname(outputPath);
  const tempPath = join(
    dirname(outputPath),
    `.${basename(outputPath, extension)}.${randomUUID()}.partial${extension}`,
  );
  let stderr = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, [...options.plan.args, tempPath], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const onInterrupt = () => child.kill('SIGINT');
      process.once('SIGINT', onInterrupt);
      let stdoutBuffer = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        const rows = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = rows.pop() ?? '';
        for (const row of rows) {
          const match = /^out_time_us=(\d+)$/.exec(row);
          if (match) options.onProgress?.(Number(match[1]));
        }
      });
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-16_000);
      });
      child.once('error', (error) => {
        process.removeListener('SIGINT', onInterrupt);
        reject(new Error(`Could not start ffmpeg: ${error.message}`));
      });
      child.once('close', (code, signal) => {
        process.removeListener('SIGINT', onInterrupt);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with ${signal ?? code}: ${stderr.trim()}`));
      });
    });
    const probe = probeOutput(tempPath);
    if (options.preset === 'mp4') {
      const manifest: RenderManifest = {
        projectId: 'cli-render',
        revision: 0,
        width: options.plan.width,
        height: options.plan.height,
        frameRate:
          Number(options.plan.fpsExpr.split('/')[0]) / Number(options.plan.fpsExpr.split('/')[1]),
        durationUs: options.plan.durationUs,
        preset: 'social-h264-aac',
      };
      verifyExportAgainstManifest(tempPath, manifest);
    }
    verifyProbe(options.plan, options.preset, probe);
    renameSync(tempPath, outputPath);
    const hash = createHash('sha256');
    const { createReadStream } = await import('node:fs');
    for await (const chunk of createReadStream(outputPath)) hash.update(chunk);
    return { ffmpegVersion, outputPath, sha256: hash.digest('hex'), probe };
  } catch (error) {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
    throw error;
  }
}

export function resolveFfmpegExecutable(): string {
  const configured = process.env.JOY_FFMPEG;
  return configured && configured.trim() ? configured : 'ffmpeg';
}

function probeOutput(path: string): FfprobeSummary {
  const result = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration',
      '-of',
      'json',
      path,
    ],
    { shell: false, encoding: 'utf8' },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `ffprobe verification failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  const parsed = JSON.parse(result.stdout) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }>;
    format?: { duration?: string };
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  if (!video?.width || !video.height || !video.codec_name)
    throw new Error('ffmpeg output has no valid video stream.');
  const durationSeconds = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
    throw new Error('ffmpeg output duration is missing or invalid.');
  const rate = (video.r_frame_rate ?? '').split('/').map(Number);
  if (!Number.isFinite(rate[0]) || !Number.isFinite(rate[1]) || !rate[1])
    throw new Error('ffmpeg output frame rate is invalid.');
  return {
    width: video.width,
    height: video.height,
    durationUs: Math.round(durationSeconds * 1_000_000),
    videoCodec: video.codec_name,
    audioCodec: streams.find((stream) => stream.codec_type === 'audio')?.codec_name ?? null,
    videoStreamCount: streams.filter((stream) => stream.codec_type === 'video').length,
    audioStreamCount: streams.filter((stream) => stream.codec_type === 'audio').length,
    frameRate: rate[0]! / rate[1]!,
  };
}

function verifyProbe(
  plan: FfmpegRenderPlan,
  preset: 'mp4' | 'webm' | 'prores',
  probe: FfprobeSummary,
): void {
  if (probe.width !== plan.width || probe.height !== plan.height)
    throw new Error(
      `Rendered dimensions ${probe.width}x${probe.height} do not match ${plan.width}x${plan.height}.`,
    );
  if (
    Math.abs(probe.durationUs - plan.durationUs) >
    Math.ceil(1_000_000 / (Number(plan.fpsExpr.split('/')[0]) / Number(plan.fpsExpr.split('/')[1])))
  )
    throw new Error(
      `Rendered duration ${probe.durationUs}us does not match project duration ${plan.durationUs}us.`,
    );
  if (
    preset === 'mp4' &&
    (probe.videoCodec !== 'h264' ||
      probe.audioCodec !== 'aac' ||
      probe.videoStreamCount !== 1 ||
      probe.audioStreamCount !== 1)
  )
    throw new Error(
      'MP4 output must contain exactly one H.264 video stream and one AAC audio stream.',
    );
}
