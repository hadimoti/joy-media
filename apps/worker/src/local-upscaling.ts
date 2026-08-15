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
import type { UpscaleJobPayload } from '@joy-media/job-protocol';

export interface UpscalingRunner {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

export interface UpscalingAvailability {
  readonly image?: {
    readonly runner: UpscalingRunner;
    readonly modelId: string;
    readonly modelVersion: string;
    readonly modelReady: boolean;
  };
}

export interface UpscaleWorkerDerivative {
  readonly kind: 'upscale.image' | 'upscale.video';
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly localRef: string;
  readonly descriptor: {
    readonly mimeType: string;
    readonly width: number;
    readonly height: number;
    readonly durationUs?: number;
  };
  readonly modelId: string;
  readonly modelVersion: string;
}

export function upscalingAvailabilityFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): UpscalingAvailability {
  const value = env.JOY_MEDIA_UPSCALE_IMAGE_RUNNER?.trim();
  const runner = runnerOf(value, env.JOY_MEDIA_UPSCALE_IMAGE_PYTHON);
  if (runner === undefined) return {};
  const modelPath = env.JOY_MEDIA_REAL_ESRGAN_MODEL?.trim() ?? '';
  return {
    image: {
      runner,
      modelId: env.JOY_MEDIA_UPSCALE_IMAGE_MODEL?.trim() || 'realesrgan-x4plus',
      modelVersion: env.JOY_MEDIA_UPSCALE_IMAGE_MODEL_VERSION?.trim() || 'unqualified',
      modelReady: modelPath.length > 0 && existsSync(modelPath),
    },
  };
}

export async function runUpscaleJob(options: {
  readonly jobId: string;
  readonly type: 'upscale.image' | 'upscale.video';
  readonly assetId: string;
  readonly sourcePath: string;
  readonly payload: unknown;
  readonly availability: UpscalingAvailability;
  readonly derivativeDirectory: string;
  readonly cancelled: () => boolean;
  readonly progress: (progress: number) => Promise<void>;
}): Promise<UpscaleWorkerDerivative> {
  const payload = validateUpscalePayload(options.payload, options.type);
  if (options.type !== 'upscale.image' || payload.mediaKind !== 'image')
    throw new Error('video upscaling is not qualified on this Worker');
  const model = options.availability.image;
  if (model === undefined || model.modelReady === false)
    throw new Error('image upscaling model is not installed');
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'joy-upscale-' + options.jobId + '-'));
  const extension =
    payload.output.mode === 'scale' && payload.output.imageFormat === 'jpeg' ? 'jpg' : 'png';
  const outputPath = join(temporaryDirectory, 'output.' + extension);
  const requestPath = join(temporaryDirectory, 'request.json');
  writeFileSync(
    requestPath,
    JSON.stringify({
      protocol: 'joy.upscaling.runner.v1',
      jobId: options.jobId,
      sourceKind: 'image',
      sourcePath: options.sourcePath,
      outputPath,
      modelId: model.modelId,
      modelVersion: model.modelVersion,
      settings: payload,
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  try {
    if (options.cancelled()) throw new Error('canceled');
    await options.progress(5);
    const completed = await runRunner(
      model.runner,
      ['--request', requestPath, '--output', outputPath],
      options.cancelled,
    );
    if (!completed || options.cancelled()) throw new Error('canceled');
    await options.progress(85);
    if (!existsSync(outputPath)) throw new Error('upscaling runner did not produce an output');
    const bytes = readFileSync(outputPath);
    if (bytes.length < 1) throw new Error('upscaling runner produced an empty output');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const safeJobId = options.jobId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 72);
    const localRef = 'upscale-' + safeJobId + '-' + sha256.slice(0, 16);
    mkdirSync(options.derivativeDirectory, { recursive: true });
    const finalPath = join(options.derivativeDirectory, localRef + '.' + extension);
    rmSync(finalPath, { force: true });
    renameSync(outputPath, finalPath);
    const descriptor = probeImage(finalPath, extension === 'jpg' ? 'image/jpeg' : 'image/png');
    await options.progress(100);
    return {
      kind: options.type,
      assetId: options.assetId,
      sha256,
      bytes: bytes.length,
      localRef,
      descriptor,
      modelId: model.modelId,
      modelVersion: model.modelVersion,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function readUpscaleDerivative(
  derivativeDirectory: string,
  receipt: UpscaleWorkerDerivative,
): Uint8Array {
  if (!/^upscale-[A-Za-z0-9._-]{1,120}$/.test(receipt.localRef))
    throw new Error('upscaling derivative reference is invalid');
  const extension = receipt.descriptor.mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const bytes = readFileSync(join(derivativeDirectory, receipt.localRef + '.' + extension));
  if (
    bytes.length !== receipt.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== receipt.sha256
  )
    throw new Error('retained upscaling derivative integrity check failed');
  return bytes;
}

function runnerOf(
  value: string | undefined,
  pythonValue: string | undefined,
): UpscalingRunner | undefined {
  if (value === undefined || value.length === 0 || value.length > 1_024) return undefined;
  if (extname(value).toLowerCase() === '.py') {
    const python = pythonValue?.trim();
    if (python === undefined || python.length === 0) return undefined;
    return { command: python, prefixArgs: [value] };
  }
  return { command: value, prefixArgs: [] };
}

async function runRunner(
  runner: UpscalingRunner,
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
    stderr = (stderr + chunk).slice(-2_000);
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
  if (code !== 0) throw new Error('upscaling runner failed (' + code + '): ' + stderr.trim());
  return true;
}

function validateUpscalePayload(
  value: unknown,
  type: 'upscale.image' | 'upscale.video',
): UpscaleJobPayload {
  const envelope = record(value);
  const candidate = record(envelope?.arguments) ?? envelope;
  const output = record(candidate?.output);
  const processing = record(candidate?.processing);
  const range = record(candidate?.range);
  if (
    candidate === undefined ||
    candidate.schemaVersion !== 1 ||
    candidate.mediaKind !== (type === 'upscale.image' ? 'image' : 'video') ||
    !['fast', 'quality'].includes(String(candidate.preset)) ||
    (candidate.modelId !== undefined &&
      (typeof candidate.modelId !== 'string' ||
        candidate.modelId.length < 1 ||
        candidate.modelId.length > 128 ||
        /[\\/:]/.test(candidate.modelId))) ||
    output === undefined ||
    !['scale', 'target'].includes(String(output.mode)) ||
    (output.mode === 'scale' &&
      (!([2, 4] as readonly unknown[]).includes(output.scale) ||
        (output.imageFormat !== undefined &&
          !['png', 'jpeg'].includes(String(output.imageFormat))))) ||
    (output.mode === 'target' && (!safeDimension(output.width) || !safeDimension(output.height))) ||
    processing === undefined ||
    !['auto', 'low-vram', 'maximum-quality'].includes(String(processing.memoryMode)) ||
    (processing.restorationStrength !== undefined &&
      !finiteInRange(processing.restorationStrength, 0, 1)) ||
    (processing.denoiseStrength !== undefined &&
      !finiteInRange(processing.denoiseStrength, 0, 1)) ||
    (processing.keepAudio !== undefined && typeof processing.keepAudio !== 'boolean') ||
    (range !== undefined &&
      (!nonNegativeSafeInteger(range.startUs) ||
        !nonNegativeSafeInteger(range.endUs) ||
        Number(range.endUs) <= Number(range.startUs) ||
        !['preview', 'full'].includes(String(range.purpose))))
  ) {
    throw new Error('upscaling job payload is invalid');
  }
  return candidate as unknown as UpscaleJobPayload;
}

function probeImage(path: string, mimeType: 'image/png' | 'image/jpeg') {
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      path,
    ],
    { shell: false, encoding: 'utf8' },
  );
  if (probe.status !== 0) throw new Error('FFprobe could not inspect upscaling output');
  const parsed = JSON.parse(probe.stdout) as { streams?: readonly unknown[] };
  const stream = record(parsed.streams?.[0]);
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1)
    throw new Error('upscaling output dimensions are invalid');
  return { mimeType, width, height };
}

function safeDimension(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 64 && Number(value) <= 16_384;
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
