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

/** Identity LoadImage→SaveImage graph — proves Comfy is reachable without SD models. */
function identityComfyWorkflow(imageName: string): Record<string, unknown> {
  return {
    '1': {
      class_type: 'LoadImage',
      inputs: { image: imageName },
    },
    '2': {
      class_type: 'SaveImage',
      inputs: { images: ['1', 0], filename_prefix: 'joy-media' },
    },
  };
}

async function ensureComfyReachable(base: string, fetchFn: typeof fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchFn(`${base}/system_stats`);
  } catch (error) {
    throw new Error(
      `ComfyUI unreachable at ${base}: ${error instanceof Error ? error.message : 'error'}`,
    );
  }
  if (!response.ok) throw new Error(`ComfyUI system_stats failed (${response.status})`);
}

async function uploadComfyImage(
  base: string,
  filePath: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const bytes = readFileSync(filePath);
  const form = new FormData();
  form.append('image', new Blob([Uint8Array.from(bytes)], { type: 'image/png' }), 'joy-input.png');
  form.append('overwrite', 'true');
  const response = await fetchFn(`${base}/upload/image`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`ComfyUI image upload failed (${response.status})`);
  const json = (await response.json()) as { name?: string };
  if (typeof json.name !== 'string' || json.name.length === 0)
    throw new Error('ComfyUI upload did not return an image name');
  return json.name;
}

async function runComfyPrompt(
  base: string,
  workflow: Record<string, unknown>,
  fetchFn: typeof fetch,
  cancelled: () => boolean,
): Promise<{ readonly filename: string; readonly subfolder: string }> {
  const promptResponse = await fetchFn(`${base}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: `joy-worker-${Date.now()}` }),
  });
  if (!promptResponse.ok) throw new Error(`ComfyUI prompt rejected (${promptResponse.status})`);
  const promptJson = (await promptResponse.json()) as { prompt_id?: string };
  const promptId = promptJson.prompt_id;
  if (typeof promptId !== 'string' || promptId.length === 0)
    throw new Error('ComfyUI prompt_id missing');

  const deadline = Date.now() + Number(process.env.JOY_MEDIA_COMFY_TIMEOUT_MS ?? 120_000);
  while (Date.now() < deadline) {
    if (cancelled()) throw new Error('canceled');
    const historyResponse = await fetchFn(`${base}/history/${encodeURIComponent(promptId)}`);
    if (!historyResponse.ok) throw new Error(`ComfyUI history failed (${historyResponse.status})`);
    const historyJson = (await historyResponse.json()) as Record<string, unknown>;
    const entry = historyJson[promptId];
    if (entry !== undefined && typeof entry === 'object' && entry !== null) {
      const outputs = (entry as { outputs?: Record<string, unknown> }).outputs ?? {};
      for (const node of Object.values(outputs)) {
        if (node === null || typeof node !== 'object') continue;
        const images = (node as { images?: unknown }).images;
        if (!Array.isArray(images) || images.length === 0) continue;
        const first = images[0];
        if (first === null || typeof first !== 'object') continue;
        const filename = (first as { filename?: unknown }).filename;
        const subfolder = (first as { subfolder?: unknown }).subfolder;
        if (typeof filename === 'string' && filename.length > 0) {
          return {
            filename,
            subfolder: typeof subfolder === 'string' ? subfolder : '',
          };
        }
      }
      throw new Error('ComfyUI history completed without image outputs');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('ComfyUI prompt timed out');
}

function writeSolidPng(path: string): void {
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-f', 'lavfi', '-i', 'color=c=#e9b949:s=64x64:d=0.04', '-frames:v', '1', path],
    { encoding: 'utf8' },
  );
  if (result.status !== 0 || !existsSync(path))
    throw new Error(`ffmpeg solid PNG failed: ${(result.stderr || '').slice(0, 200)}`);
}

function convertSourceToPng(sourcePath: string, outPath: string): void {
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-i', sourcePath, '-frames:v', '1', '-vf', 'scale=512:-2', outPath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0 || !existsSync(outPath))
    throw new Error(`ffmpeg source→PNG failed: ${(result.stderr || '').slice(0, 200)}`);
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
  const base = (process.env.JOY_MEDIA_LOCAL_COMFY_URL ?? '').trim().replace(/\/$/, '');
  if (base.length === 0) throw new Error('JOY_MEDIA_LOCAL_COMFY_URL is not set');
  const fetchFn = options.fetch ?? fetch;
  const tempDir = mkdtempSync(join(tmpdir(), `joy-comfy-${options.jobId}-`));
  try {
    await options.progress(5);
    await ensureComfyReachable(base, fetchFn);
    if (options.cancelled()) throw new Error('canceled');
    await options.progress(15);
    const inputPng = join(tempDir, 'input.png');
    if (options.sourcePath !== undefined) convertSourceToPng(options.sourcePath, inputPng);
    else writeSolidPng(inputPng);
    await options.progress(30);
    const imageName = await uploadComfyImage(base, inputPng, fetchFn);
    await options.progress(45);
    const { filename, subfolder } = await runComfyPrompt(
      base,
      identityComfyWorkflow(imageName),
      fetchFn,
      options.cancelled,
    );
    await options.progress(75);
    const viewUrl = new URL(`${base}/view`);
    viewUrl.searchParams.set('filename', filename);
    if (subfolder.length > 0) viewUrl.searchParams.set('subfolder', subfolder);
    viewUrl.searchParams.set('type', 'output');
    const viewResponse = await fetchFn(viewUrl);
    if (!viewResponse.ok) throw new Error(`ComfyUI view failed (${viewResponse.status})`);
    const arrayBuffer = await viewResponse.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    if (bytes.length < 1) throw new Error('ComfyUI output is empty');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const assetId = options.assetId ?? `comfy-${options.jobId}`;
    const localRef = `gpu-${options.jobId}-${sha256.slice(0, 16)}`;
    retainDerivative(options.derivativeDirectory, localRef, 'png', bytes);
    await options.progress(100);
    return {
      kind: 'image.comfy',
      assetId,
      sha256,
      bytes: bytes.length,
      localRef,
      descriptor: { mimeType: 'image/png', width: 64, height: 64 },
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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
