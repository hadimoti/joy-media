import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlPlaneError } from './control-plane.js';

export const MAX_DENOISE_JSON_BYTES = 32 * 1024 * 1024;
export const MAX_DENOISE_MEDIA_BYTES = 24 * 1024 * 1024;
export const MAX_DENOISE_OUTPUT_BYTES = 24 * 1024 * 1024;
export const MAX_DENOISE_DURATION_SECONDS = 240;
export const DENOISE_TIMEOUT_MS = 60_000;

export interface SpectralDenoiseRequest {
  readonly assetId: string;
  readonly mediaBase64: string;
  readonly sampleRate?: number;
  readonly strength?: number;
}

export interface SpectralDenoiseResult {
  readonly assetId: string;
  readonly mimeType: string;
  readonly bytesBase64: string;
  readonly method: 'ffmpeg-afftdn';
  readonly strength: number;
}

export interface SpectralDenoiseRuntime {
  readonly ffmpeg?: string;
  readonly timeoutMs?: number;
  readonly spawn?: typeof spawn;
}

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}

const MAX_PROCESS_OUTPUT_CHARS = 16 * 1024;

function strengthToAfftdnNf(strength: number): number {
  return -25 - Math.min(1, Math.max(0, strength)) * 50;
}

/** Spectral denoise via ffmpeg afftdn (not ML). */
export async function runSpectralDenoise(
  request: SpectralDenoiseRequest,
  runtime: SpectralDenoiseRuntime = {},
): Promise<SpectralDenoiseResult> {
  if (typeof request.assetId !== 'string' || request.assetId.length === 0) {
    throw new ControlPlaneError('REQUEST_INVALID', 'assetId is required');
  }
  if (typeof request.mediaBase64 !== 'string' || request.mediaBase64.length === 0) {
    throw new ControlPlaneError('REQUEST_INVALID', 'mediaBase64 is required');
  }
  const strength = request.strength ?? 0.8;
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
    throw new ControlPlaneError('REQUEST_INVALID', 'strength must be between 0 and 1');
  }
  const sampleRate = request.sampleRate ?? 48_000;
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new ControlPlaneError('REQUEST_INVALID', 'sampleRate must be between 8000 and 192000');
  }
  const bytes = decodeMediaBase64(request.mediaBase64);

  const ffmpeg = runtime.ffmpeg ?? process.env.JOY_MEDIA_FFMPEG ?? 'ffmpeg';
  const timeoutMs = runtime.timeoutMs ?? DENOISE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('denoise timeout must be a positive safe integer');
  }
  const dir = await mkdtemp(join(tmpdir(), 'joy-api-denoise-'));
  const inputPath = join(dir, 'input.bin');
  const outputPath = join(dir, 'denoised.wav');
  try {
    await writeFile(inputPath, bytes);
    const nf = strengthToAfftdnNf(strength);
    const result = await runProcess(
      runtime.spawn ?? spawn,
      ffmpeg,
      [
        '-y',
        '-i',
        inputPath,
        '-t',
        String(MAX_DENOISE_DURATION_SECONDS),
        '-af',
        `afftdn=nf=${nf.toFixed(1)}`,
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        '-fs',
        String(MAX_DENOISE_OUTPUT_BYTES),
        '-f',
        'wav',
        outputPath,
      ],
      timeoutMs,
    );
    if (result.code !== 0) {
      const reason = result.output || `process exited with ${result.signal ?? result.code}`;
      throw new ControlPlaneError(
        'PROVIDER_FAILED',
        `ffmpeg afftdn failed: ${reason.slice(0, 400)}`,
      );
    }
    let outputBytes: number;
    try {
      outputBytes = (await stat(outputPath)).size;
    } catch {
      throw new ControlPlaneError('PROVIDER_FAILED', 'ffmpeg afftdn did not produce an output');
    }
    if (outputBytes === 0) {
      throw new ControlPlaneError('PROVIDER_FAILED', 'ffmpeg afftdn produced an empty output');
    }
    if (outputBytes > MAX_DENOISE_OUTPUT_BYTES)
      throw new ControlPlaneError(
        'PROVIDER_FAILED',
        'ffmpeg afftdn output exceeded the server size limit',
      );
    const out = await readFile(outputPath);
    if (out.byteLength > MAX_DENOISE_OUTPUT_BYTES)
      throw new ControlPlaneError(
        'PROVIDER_FAILED',
        'ffmpeg afftdn output exceeded the server size limit',
      );
    return {
      assetId: `${request.assetId}-denoised-${randomUUID().slice(0, 8)}`,
      mimeType: 'audio/wav',
      bytesBase64: out.toString('base64'),
      method: 'ffmpeg-afftdn',
      strength,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function decodeMediaBase64(value: string): Buffer {
  if (value.length === 0 || value.length % 4 !== 0) {
    throw new ControlPlaneError('REQUEST_INVALID', 'mediaBase64 is invalid');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const contentEnd = value.length - padding;
  if ((padding === 1 && contentEnd % 4 !== 3) || (padding === 2 && contentEnd % 4 !== 2)) {
    throw new ControlPlaneError('REQUEST_INVALID', 'mediaBase64 is invalid');
  }
  const decodedBytes = (value.length / 4) * 3 - padding;
  if (decodedBytes > MAX_DENOISE_MEDIA_BYTES) {
    throw new ControlPlaneError('REQUEST_INVALID', 'decoded media exceeds the size limit');
  }
  if (!hasCanonicalBase64Characters(value, contentEnd)) {
    throw new ControlPlaneError('REQUEST_INVALID', 'mediaBase64 is invalid');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength !== decodedBytes) {
    throw new ControlPlaneError('REQUEST_INVALID', 'mediaBase64 is invalid');
  }
  if (bytes.byteLength === 0) {
    throw new ControlPlaneError('REQUEST_INVALID', 'media bytes are empty');
  }
  return bytes;
}

function hasCanonicalBase64Characters(value: string, contentEnd: number): boolean {
  for (let index = 0; index < contentEnd; index++) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return false;
  }
  for (let index = contentEnd; index < value.length; index++) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

async function runProcess(
  launch: typeof spawn,
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ProcessResult> {
  const child = launch(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise<ProcessResult>((resolve, reject) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    const append = (chunk: unknown) => {
      if (output.length >= MAX_PROCESS_OUTPUT_CHARS) return;
      output += String(chunk).slice(0, MAX_PROCESS_OUTPUT_CHARS - output.length);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timeout.unref();
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      operation();
    };
    child.once('error', (error) =>
      finish(() =>
        reject(
          new ControlPlaneError(
            'PROVIDER_FAILED',
            `ffmpeg afftdn could not start: ${error.message.slice(0, 300)}`,
          ),
        ),
      ),
    );
    child.once('close', (code, signal) =>
      finish(() => {
        if (timedOut) {
          reject(new ControlPlaneError('PROVIDER_FAILED', 'ffmpeg afftdn timed out'));
          return;
        }
        resolve({ code, signal, output: output.trim() });
      }),
    );
  });
}
