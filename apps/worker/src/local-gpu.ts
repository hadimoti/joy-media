/**
 * Local PC GPU / ML job executors (ADR-0018).
 * Runs only when the Worker advertises `image.comfy` / `audio.ml-denoise`.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export interface LocalGpuReceipt {
  readonly kind: 'image.comfy' | 'audio.ml-denoise';
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly localRef: string;
  readonly descriptor: {
    readonly mimeType: string;
    readonly width?: number;
    readonly height?: number;
  };
}

export interface LocalGpuRunOptions {
  readonly jobId: string;
  readonly assetId?: string;
  readonly sourcePath?: string;
  readonly derivativeDirectory: string;
  readonly cancelled: () => boolean;
  readonly progress: (progress: number) => Promise<void>;
  readonly fetch?: typeof fetch;
}

function retainDerivative(
  derivativeDirectory: string,
  localRef: string,
  extension: string,
  bytes: Buffer,
): string {
  mkdirSync(derivativeDirectory, { recursive: true });
  const finalOutput = join(derivativeDirectory, `${localRef}.${extension}`);
  const temp = `${finalOutput}.tmp`;
  writeFileSync(temp, bytes);
  rmSync(finalOutput, { force: true });
  renameSync(temp, finalOutput);
  return finalOutput;
}

export async function runImageComfyJob(options: LocalGpuRunOptions): Promise<LocalGpuReceipt> {
  void options;
  throw new Error(
    'COMFYUI_UNAVAILABLE: identity Comfy workflows and solid PNG fallbacks are fixture-only; production image.comfy is not wired yet.',
  );
}

function writeNoisyFixtureWav(path: string): void {
  const result = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.4',
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=duration=0.4:color=white:amplitude=0.05',
      '-filter_complex',
      'amix=inputs=2:duration=shortest',
      path,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0 || !existsSync(path))
    throw new Error(`ffmpeg noisy fixture failed: ${(result.stderr || '').slice(0, 200)}`);
}

/**
 * ML denoise on the Worker PC. Prefers `JOY_MEDIA_ML_DENOISE_CMD` (DeepFilterNet
 * etc.); otherwise uses ffmpeg `arnndn` + RNNoise model (honest CPU ML path).
 */
export async function runAudioMlDenoiseJob(options: LocalGpuRunOptions): Promise<LocalGpuReceipt> {
  if ((process.env.JOY_MEDIA_LOCAL_ML_DENOISE ?? '').trim() !== '1')
    throw new Error('JOY_MEDIA_LOCAL_ML_DENOISE is not enabled');
  const tempDir = mkdtempSync(join(tmpdir(), `joy-ml-denoise-${options.jobId}-`));
  try {
    await options.progress(5);
    const inputWav = join(tempDir, 'input.wav');
    const outputWav = join(tempDir, 'output.wav');
    if (options.sourcePath !== undefined) {
      const convert = spawnSync(
        'ffmpeg',
        ['-y', '-i', options.sourcePath, '-ac', '1', '-ar', '48000', inputWav],
        { encoding: 'utf8' },
      );
      if (convert.status !== 0 || !existsSync(inputWav))
        throw new Error(`ffmpeg source→wav failed: ${(convert.stderr || '').slice(0, 200)}`);
    } else writeNoisyFixtureWav(inputWav);
    await options.progress(25);
    if (options.cancelled()) throw new Error('canceled');

    const customCmd = (process.env.JOY_MEDIA_ML_DENOISE_CMD ?? '').trim();
    if (customCmd.length > 0) {
      const result = spawnSync(customCmd, [inputWav, outputWav], {
        encoding: 'utf8',
        shell: true,
        timeout: Number(process.env.JOY_MEDIA_ML_DENOISE_TIMEOUT_MS ?? 120_000),
      });
      if (result.status !== 0 || !existsSync(outputWav))
        throw new Error(
          `ML denoise command failed: ${(result.stderr || result.stdout || '').slice(0, 300)}`,
        );
    } else {
      const model =
        process.env.JOY_MEDIA_RNNOISE_MODEL?.trim() || '/opt/joy-media/data/rnnoise/cb.rnnn';
      if (!existsSync(model)) throw new Error(`RNNoise model missing: ${model}`);
      const result = spawnSync(
        'ffmpeg',
        ['-y', '-i', inputWav, '-af', `arnndn=m=${model}`, outputWav],
        { encoding: 'utf8' },
      );
      if (result.status !== 0 || !existsSync(outputWav))
        throw new Error(`ffmpeg arnndn failed: ${(result.stderr || '').slice(0, 300)}`);
    }
    await options.progress(85);
    const bytes = readFileSync(outputWav);
    if (bytes.length < 1) throw new Error('ML denoise output is empty');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const assetId = options.assetId ?? `mldenoise-${options.jobId}`;
    const localRef = `gpu-${options.jobId}-${sha256.slice(0, 16)}`;
    retainDerivative(options.derivativeDirectory, localRef, 'wav', bytes);
    await options.progress(100);
    return {
      kind: 'audio.ml-denoise',
      assetId,
      sha256,
      bytes: bytes.length,
      localRef,
      descriptor: { mimeType: 'audio/wav' },
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function readGpuDerivative(
  derivativeDirectory: string,
  result: LocalGpuReceipt,
): Uint8Array {
  if (!/^gpu-[A-Za-z0-9._-]{1,110}$/.test(result.localRef))
    throw new Error('GPU derivative local reference is invalid');
  const extension = result.kind === 'image.comfy' ? 'png' : 'wav';
  const bytes = readFileSync(join(derivativeDirectory, `${result.localRef}.${extension}`));
  if (
    bytes.length !== result.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== result.sha256
  )
    throw new Error('retained GPU derivative integrity check failed');
  return bytes;
}
