import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ControlPlaneError } from './control-plane.js';

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

function strengthToAfftdnNf(strength: number): number {
  return -25 - Math.min(1, Math.max(0, strength)) * 50;
}

/** Spectral denoise via ffmpeg afftdn (not ML). */
export function runSpectralDenoise(request: SpectralDenoiseRequest): SpectralDenoiseResult {
  if (typeof request.assetId !== 'string' || request.assetId.length === 0) {
    throw new ControlPlaneError('REQUEST_INVALID', 'assetId is required');
  }
  if (typeof request.mediaBase64 !== 'string' || request.mediaBase64.length === 0) {
    throw new ControlPlaneError('REQUEST_INVALID', 'mediaBase64 is required');
  }
  const strength = request.strength ?? 0.8;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(request.mediaBase64, 'base64');
  } catch {
    throw new ControlPlaneError('REQUEST_INVALID', 'mediaBase64 is invalid');
  }
  if (bytes.byteLength === 0) {
    throw new ControlPlaneError('REQUEST_INVALID', 'media bytes are empty');
  }

  const ffmpeg = process.env.JOY_MEDIA_FFMPEG ?? 'ffmpeg';
  const dir = mkdtempSync(join(tmpdir(), 'joy-api-denoise-'));
  const inputPath = join(dir, 'input.bin');
  const outputPath = join(dir, 'denoised.wav');
  try {
    writeFileSync(inputPath, bytes);
    const nf = strengthToAfftdnNf(strength);
    const result = spawnSync(
      ffmpeg,
      [
        '-y',
        '-i',
        inputPath,
        '-af',
        `afftdn=nf=${nf.toFixed(1)}`,
        '-ac',
        '1',
        '-ar',
        String(request.sampleRate ?? 48_000),
        '-f',
        'wav',
        outputPath,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (result.status !== 0 || !existsSync(outputPath)) {
      throw new ControlPlaneError(
        'PROVIDER_FAILED',
        `ffmpeg afftdn failed: ${(result.stderr || result.stdout || 'unknown').slice(0, 400)}`,
      );
    }
    const out = readFileSync(outputPath);
    return {
      assetId: `${request.assetId}-denoised-${randomUUID().slice(0, 8)}`,
      mimeType: 'audio/wav',
      bytesBase64: out.toString('base64'),
      method: 'ffmpeg-afftdn',
      strength,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
