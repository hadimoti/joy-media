import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  maskingAvailabilityFromEnvironment,
  readMaskDerivative,
  runMaskingJob,
} from './local-masking.js';

describe('local masking runner', () => {
  it('advertises only explicitly configured image/video runners', () => {
    expect(
      maskingAvailabilityFromEnvironment({
        JOY_MEDIA_MASKING_RUNNER: '/opt/joy/mask-runner',
        JOY_MEDIA_MASKING_CAPABILITIES: 'image,video',
      }),
    ).toEqual({
      image: { command: '/opt/joy/mask-runner', prefixArgs: [] },
      video: { command: '/opt/joy/mask-runner', prefixArgs: [] },
    });
    expect(maskingAvailabilityFromEnvironment({})).toEqual({});
  });

  it('runs a private JSON request, verifies the PNG, and retains an opaque result', async () => {
    const derivativeDirectory = mkdtempSync(join(tmpdir(), 'joy-mask-result-'));
    const sourcePath = join(
      process.cwd(),
      'apps',
      'editor-web',
      'public',
      'assets',
      '24_pixel.png',
    );
    const copyRunner = [
      "const fs=require('node:fs');",
      "const i=process.argv.indexOf('--request');",
      "const r=JSON.parse(fs.readFileSync(process.argv[i+1],'utf8'));",
      'fs.copyFileSync(r.sourcePath,r.outputPath);',
    ].join('');
    try {
      const result = await runMaskingJob({
        jobId: `job-${'long-'.repeat(30)}`,
        type: 'mask.image',
        assetId: 'source-image',
        sourcePath,
        payload: {
          arguments: {
            schemaVersion: 1,
            provider: 'birefnet',
            selection: { mode: 'subject' },
            edge: { featherPx: 2, expansionPx: 0, detail: 0.8, decontaminate: true },
            invert: false,
            output: 'matte',
          },
          generation: { providerId: 'local-worker' },
        },
        runner: { command: process.execPath, prefixArgs: ['-e', copyRunner, '--'] },
        derivativeDirectory,
        cancelled: () => false,
        progress: async () => undefined,
      });
      expect(result).toMatchObject({
        kind: 'mask.image',
        assetId: 'source-image',
        descriptor: { mimeType: 'image/png' },
      });
      expect(result.localRef).toMatch(/^mask-[A-Za-z0-9._-]+-[a-f0-9]{16}$/);
      expect(result.localRef.length).toBeLessThan(116);
      expect(existsSync(join(derivativeDirectory, `${result.localRef}.png`))).toBe(true);
      expect(readMaskDerivative(derivativeDirectory, result).byteLength).toBe(result.bytes);
      expect(JSON.stringify(result)).not.toContain(sourcePath);
    } finally {
      rmSync(derivativeDirectory, { recursive: true, force: true });
    }
  });
});
