import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { MaskJobPayload } from '@joy-media/job-protocol';

export interface MaskingRunner {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

export interface MaskingAvailability {
  readonly image?: MaskingRunner;
  readonly video?: MaskingRunner;
}

export interface MaskWorkerDerivative {
  readonly kind: 'mask.image' | 'mask.video';
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly localRef: string;
  readonly descriptor: {
    readonly mimeType: 'image/png' | 'video/webm';
    readonly width?: number;
    readonly height?: number;
    readonly durationUs?: number;
  };
}

/**
 * A runner is explicitly configured on the owner machine. The default image
 * adapter is the bundled BiRefNet/rembg script; SAM 3/SAM 2 implementations
 * can implement the exact same JSON contract without exposing model paths.
 */
export function maskingAvailabilityFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): MaskingAvailability {
  const common = env.JOY_MEDIA_MASKING_RUNNER?.trim();
  const image = runnerOf(env.JOY_MEDIA_MASK_IMAGE_RUNNER?.trim() || common, env);
  const video = runnerOf(env.JOY_MEDIA_MASK_VIDEO_RUNNER?.trim() || common, env);
  const declared = new Set(
    (env.JOY_MEDIA_MASKING_CAPABILITIES ?? (common === undefined ? '' : 'image'))
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return {
    ...(image !== undefined && (declared.has('image') || env.JOY_MEDIA_MASK_IMAGE_RUNNER)
      ? { image }
      : {}),
    ...(video !== undefined && (declared.has('video') || env.JOY_MEDIA_MASK_VIDEO_RUNNER)
      ? { video }
      : {}),
  };
}

export async function runMaskingJob(options: {
  readonly jobId: string;
  readonly type: 'mask.image' | 'mask.video';
  readonly assetId: string;
  readonly sourcePath: string;
  readonly payload: unknown;
  readonly runner: MaskingRunner;
  readonly derivativeDirectory: string;
  readonly cancelled: () => boolean;
  readonly progress: (progress: number) => Promise<void>;
}): Promise<MaskWorkerDerivative> {
  const payload = validateMaskPayload(options.payload, options.type);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), `joy-mask-${options.jobId}-`));
  const extension = options.type === 'mask.image' ? 'png' : 'webm';
  const outputPath = join(temporaryDirectory, `output.${extension}`);
  const requestPath = join(temporaryDirectory, 'request.json');
  writeFileSync(
    requestPath,
    JSON.stringify({
      protocol: 'joy.masking.v1',
      jobId: options.jobId,
      sourceKind: options.type === 'mask.image' ? 'image' : 'video',
      sourcePath: options.sourcePath,
      outputPath,
      settings: payload,
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  try {
    if (options.cancelled()) throw new Error('canceled');
    await options.progress(5);
    const completed = await runRunner(
      options.runner,
      ['--request', requestPath, '--output', outputPath],
      options.cancelled,
    );
    if (!completed || options.cancelled()) throw new Error('canceled');
    await options.progress(85);
    if (!existsSync(outputPath)) throw new Error('masking runner did not produce an output');
    const bytes = readFileSync(outputPath);
    if (bytes.length < 1) throw new Error('masking runner produced an empty output');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const safeJobId = options.jobId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 72);
    const localRef = `mask-${safeJobId}-${sha256.slice(0, 16)}`;
    mkdirSync(options.derivativeDirectory, { recursive: true });
    const finalPath = join(options.derivativeDirectory, `${localRef}.${extension}`);
    rmSync(finalPath, { force: true });
    renameSync(outputPath, finalPath);
    const descriptor = probeMask(finalPath, options.type);
    await options.progress(100);
    return {
      kind: options.type,
      assetId: options.assetId,
      sha256,
      bytes: bytes.length,
      localRef,
      descriptor,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function readMaskDerivative(
  derivativeDirectory: string,
  receipt: MaskWorkerDerivative,
): Uint8Array {
  if (!/^mask-[A-Za-z0-9._-]{1,110}$/.test(receipt.localRef))
    throw new Error('mask derivative reference is invalid');
  const extension = receipt.kind === 'mask.image' ? 'png' : 'webm';
  const bytes = readFileSync(join(derivativeDirectory, `${receipt.localRef}.${extension}`));
  if (
    bytes.length !== receipt.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== receipt.sha256
  )
    throw new Error('retained mask derivative integrity check failed');
  return bytes;
}

function runnerOf(value: string | undefined, env: NodeJS.ProcessEnv): MaskingRunner | undefined {
  if (value === undefined || value.length === 0 || value.length > 1_024) return undefined;
  const python = env.JOY_MEDIA_MASKING_PYTHON?.trim();
  if (extname(value).toLowerCase() === '.py') {
    if (python === undefined || python.length === 0) return undefined;
    return { command: python, prefixArgs: [value] };
  }
  return { command: value, prefixArgs: [] };
}

async function runRunner(
  runner: MaskingRunner,
  args: readonly string[],
  cancelled: () => boolean,
): Promise<boolean> {
  const child = spawn(runner.command, [...runner.prefixArgs, ...args], {
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  while (child.exitCode === null) {
    if (cancelled()) {
      child.kill();
      await completed.catch(() => undefined);
      return false;
    }
    await sleep(50);
  }
  const code = await completed;
  if (code !== 0) throw new Error(`masking runner failed (${code}): ${stderr.trim()}`);
  return true;
}

function validateMaskPayload(value: unknown, type: 'mask.image' | 'mask.video'): MaskJobPayload {
  const envelope = record(value);
  const candidate = record(envelope?.arguments) ?? envelope;
  if (candidate === undefined) throw new Error('masking job payload is missing');
  const payload = candidate as Partial<MaskJobPayload>;
  const selection = record(payload.selection);
  const edge = record(payload.edge);
  const video = record(payload.video);
  const points = Array.isArray(selection?.points) ? selection.points : undefined;
  const box = record(selection?.box);
  const mode = selection?.mode;
  if (
    payload.schemaVersion !== 1 ||
    !['auto', 'sam3', 'sam2-grounded', 'birefnet'].includes(String(payload.provider)) ||
    !['subject', 'person', 'prompt', 'points', 'box'].includes(String(mode)) ||
    (mode === 'prompt' &&
      (typeof selection?.prompt !== 'string' ||
        selection.prompt.trim().length < 1 ||
        selection.prompt.length > 500)) ||
    (mode === 'points' &&
      (points === undefined ||
        points.length < 1 ||
        points.length > 64 ||
        points.some((point) => !validMaskPoint(point)))) ||
    (mode === 'box' && !validMaskBox(box)) ||
    (selection?.timeUs !== undefined && !nonNegativeSafeInteger(selection.timeUs)) ||
    !finiteInRange(edge?.featherPx, 0, 100) ||
    !finiteInRange(edge?.expansionPx, -100, 100) ||
    !finiteInRange(edge?.detail, 0, 1) ||
    typeof edge?.decontaminate !== 'boolean' ||
    typeof payload.invert !== 'boolean' ||
    !['matte', 'cutout'].includes(String(payload.output)) ||
    (type === 'mask.video' &&
      (video === undefined ||
        !['clip', 'in-out'].includes(String(video.range)) ||
        !['forward', 'backward', 'both'].includes(String(video.direction)) ||
        !finiteInRange(video.temporalConsistency, 0, 1) ||
        (video.inUs !== undefined && !nonNegativeSafeInteger(video.inUs)) ||
        (video.outUs !== undefined && !nonNegativeSafeInteger(video.outUs)) ||
        (video.inUs !== undefined &&
          video.outUs !== undefined &&
          Number(video.outUs) <= Number(video.inUs))))
  )
    throw new Error('masking job payload is invalid');
  return payload as MaskJobPayload;
}

function validMaskPoint(value: unknown): boolean {
  const point = record(value);
  return (
    point !== undefined &&
    finiteInRange(point.x, 0, 1) &&
    finiteInRange(point.y, 0, 1) &&
    (point.label === 'foreground' || point.label === 'background') &&
    (point.timeUs === undefined || nonNegativeSafeInteger(point.timeUs))
  );
}

function validMaskBox(value: Record<string, unknown> | undefined): boolean {
  return (
    value !== undefined &&
    finiteInRange(value.x, 0, 1) &&
    finiteInRange(value.y, 0, 1) &&
    finiteInRange(value.width, Number.EPSILON, 1) &&
    finiteInRange(value.height, Number.EPSILON, 1) &&
    Number(value.x) + Number(value.width) <= 1 &&
    Number(value.y) + Number(value.height) <= 1 &&
    (value.timeUs === undefined || nonNegativeSafeInteger(value.timeUs))
  );
}

function finiteInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function probeMask(
  path: string,
  type: 'mask.image' | 'mask.video',
): MaskWorkerDerivative['descriptor'] {
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height:format=duration',
      '-of',
      'json',
      path,
    ],
    { shell: false, encoding: 'utf8' },
  );
  if (probe.status !== 0) throw new Error('FFprobe could not inspect mask output');
  const parsed: unknown = JSON.parse(probe.stdout);
  const root = parsed as {
    streams?: readonly Record<string, unknown>[];
    format?: Record<string, unknown>;
  };
  const stream = root.streams?.[0];
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1)
    throw new Error('mask output dimensions are invalid');
  const durationSeconds = Number(root.format?.duration);
  const durationUs = Math.round(durationSeconds * 1_000_000);
  if (type === 'mask.video' && (!Number.isSafeInteger(durationUs) || durationUs <= 0))
    throw new Error('mask video duration is invalid');
  return {
    mimeType: type === 'mask.image' ? 'image/png' : 'video/webm',
    width,
    height,
    ...(type === 'mask.video' ? { durationUs } : {}),
  };
}
