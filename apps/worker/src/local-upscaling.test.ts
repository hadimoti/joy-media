import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readUpscaleDerivative,
  runUpscaleJob,
  upscalingAvailabilityFromEnvironment,
} from './local-upscaling.js';

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

  it('runs a private image request, verifies the output, and keeps only an opaque receipt', async () => {
    const derivativeDirectory = mkdtempSync(join(tmpdir(), 'joy-upscale-result-'));
    const sourcePath = join(
      process.cwd(),
      'apps',
      'editor-web',
      'public',
      'transitions',
      'preview',
      'zoom.png',
    );
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
