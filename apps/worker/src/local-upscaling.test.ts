import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  readUpscaleDerivative,
  runUpscaleJob,
  upscalingAvailabilityFromEnvironment,
} from './local-upscaling.js';

// Independent of `process.cwd()` (which is `apps/worker` under `pnpm --filter @joy-media/worker
// test`, not the repo root) so this fixture resolves the same way from any invocation.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('local upscaling runner', () => {
  it('advertises only an explicitly configured image runner', () => {
    expect(
      upscalingAvailabilityFromEnvironment({
        JOY_MEDIA_UPSCALE_IMAGE_RUNNER: '/opt/joy/realesrgan.py',
        JOY_MEDIA_UPSCALE_IMAGE_PYTHON: '/opt/joy/venv/bin/python',
        JOY_MEDIA_UPSCALE_IMAGE_MODEL: 'realesrgan-x4plus',
        JOY_MEDIA_UPSCALE_IMAGE_MODEL_VERSION: '2026.08',
      }),
    ).toMatchObject({
      image: {
        runner: { command: '/opt/joy/venv/bin/python', prefixArgs: ['/opt/joy/realesrgan.py'] },
        modelId: 'realesrgan-x4plus',
        modelVersion: '2026.08',
      },
    });
    expect(upscalingAvailabilityFromEnvironment({})).toEqual({});
  });

  it('readies a model only while its file matches the SHA-256 it was pinned to', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-upscale-model-'));
    const modelPath = join(directory, 'realesrgan-x4plus.pth');
    try {
      writeFileSync(modelPath, 'model weights fixture');
      const digest = createHash('sha256').update('model weights fixture').digest('hex');
      const readiness = (pin: string | undefined): boolean | undefined =>
        upscalingAvailabilityFromEnvironment({
          JOY_MEDIA_UPSCALE_IMAGE_RUNNER: '/opt/joy/realesrgan.py',
          JOY_MEDIA_UPSCALE_IMAGE_PYTHON: '/opt/joy/venv/bin/python',
          JOY_MEDIA_REAL_ESRGAN_MODEL: modelPath,
          ...(pin === undefined ? {} : { JOY_MEDIA_REAL_ESRGAN_MODEL_SHA256: pin }),
        }).image?.modelReady;

      expect(readiness(digest)).toBe(true);
      expect(readiness(digest.toUpperCase()), 'a pin in upper case names the same digest').toBe(
        true,
      );
      expect(readiness(undefined), 'a model with no pin is never run').toBe(false);
      expect(readiness('not-a-digest'), 'a malformed pin is refused').toBe(false);
      expect(readiness('0'.repeat(64)), 'a model with another digest is refused').toBe(false);

      writeFileSync(modelPath, 'swapped weights');
      expect(readiness(digest), 'a file swapped after pinning is refused').toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs a private image request, verifies the output, and keeps only an opaque receipt', async () => {
    const derivativeDirectory = mkdtempSync(join(tmpdir(), 'joy-upscale-result-'));
    const sourcePath = join(repoRoot, 'apps', 'editor-web', 'public', 'assets', '24_pixel.png');
    const copyRunner = [
      "const fs=require('node:fs');",
      "const i=process.argv.indexOf('--request');",
      "const r=JSON.parse(fs.readFileSync(process.argv[i+1],'utf8'));",
      'fs.copyFileSync(r.sourcePath,r.outputPath);',
    ].join('');
    try {
      const result = await runUpscaleJob({
        jobId: 'upscale-test',
        type: 'upscale.image',
        assetId: 'source-image',
        sourcePath,
        payload: {
          arguments: {
            schemaVersion: 1,
            mediaKind: 'image',
            preset: 'quality',
            output: { mode: 'scale', scale: 2, imageFormat: 'png' },
            processing: { memoryMode: 'auto' },
          },
        },
        availability: {
          image: {
            runner: { command: process.execPath, prefixArgs: ['-e', copyRunner, '--'] },
            modelId: 'test-model',
            modelVersion: 'test',
            modelReady: true,
          },
        },
        derivativeDirectory,
        cancelled: () => false,
        progress: async () => undefined,
      });
      expect(result).toMatchObject({
        kind: 'upscale.image',
        assetId: 'source-image',
        descriptor: { mimeType: 'image/png' },
        modelId: 'test-model',
      });
      expect(existsSync(join(derivativeDirectory, `${result.localRef}.png`))).toBe(true);
      expect(readUpscaleDerivative(derivativeDirectory, result).byteLength).toBe(result.bytes);
      expect(JSON.stringify(result)).not.toContain(sourcePath);
    } finally {
      rmSync(derivativeDirectory, { recursive: true, force: true });
    }
  });
});
