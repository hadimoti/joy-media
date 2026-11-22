import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  maskingAvailabilityFromEnvironment,
  readMaskDerivative,
  runMaskingJob,
} from './local-masking.js';

// Independent of `process.cwd()` (which is `apps/worker` under `pnpm --filter @joy-media/worker
// test`, not the repo root) so this fixture resolves the same way from any invocation.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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
    const sourcePath = join(repoRoot, 'apps', 'editor-web', 'public', 'assets', '24_pixel.png');
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

  const videoPayload = (provider: string) => ({
    schemaVersion: 1,
    provider,
    selection: { mode: 'subject' },
    edge: { featherPx: 2, expansionPx: 0, detail: 0.8, decontaminate: true },
    invert: false,
    output: 'cutout',
    video: { range: 'clip', direction: 'both', temporalConsistency: 0.85 },
  });

  it('refuses a video mask that selects BiRefNet before any runner starts', async () => {
    const derivativeDirectory = mkdtempSync(join(tmpdir(), 'joy-mask-video-'));
    try {
      await expect(
        runMaskingJob({
          jobId: 'job-video-birefnet',
          type: 'mask.video',
          assetId: 'source-video',
          sourcePath: join(derivativeDirectory, 'missing.mp4'),
          payload: videoPayload('birefnet'),
          runner: { command: process.execPath, prefixArgs: ['-e', 'process.exit(9)', '--'] },
          derivativeDirectory,
          cancelled: () => false,
          progress: async () => undefined,
        }),
      ).rejects.toThrow('BiRefNet masks still images only');
    } finally {
      rmSync(derivativeDirectory, { recursive: true, force: true });
    }
  });

  it('ends the whole runner tree when the job is cancelled, not only the router', async () => {
    const derivativeDirectory = mkdtempSync(join(tmpdir(), 'joy-mask-cancel-'));
    const pidFile = join(derivativeDirectory, 'grandchild.pid');
    // The router role: start the model script as a child, then wait for it. On Windows the child is detached
    // from Node's own job object, as the Python router's child is; elsewhere it stays in the router's group.
    const router = [
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      `const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:process.platform==='win32'});`,
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(g.pid));`,
      "g.on('exit',()=>process.exit(0));",
    ].join('');
    let grandchild: number | undefined;
    try {
      await runMaskingJob({
        jobId: 'job-cancel-tree',
        type: 'mask.video',
        assetId: 'source-video',
        sourcePath: join(derivativeDirectory, 'missing.mp4'),
        payload: videoPayload('auto'),
        runner: { command: process.execPath, prefixArgs: ['-e', router, '--'] },
        derivativeDirectory,
        cancelled: () => {
          if (!existsSync(pidFile)) return false;
          grandchild = Number(readFileSync(pidFile, 'utf8'));
          return Number.isInteger(grandchild) && grandchild > 0;
        },
        progress: async () => undefined,
      }).catch(() => undefined);
      expect(grandchild).toBeGreaterThan(0);
      await new Promise((done) => setTimeout(done, 500));
      expect(() => process.kill(grandchild ?? 0, 0)).toThrow();
    } finally {
      if (grandchild !== undefined) {
        try {
          process.kill(grandchild);
        } catch {
          /* already gone */
        }
      }
      rmSync(derivativeDirectory, { recursive: true, force: true });
    }
  }, 30_000);
});
