import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerControlPlaneClient } from './control-plane-client.js';
import { WorkerDaemon } from './worker-daemon.js';
import { StaticLocalAssetSourceRegistry, WorkerRuntime } from './runtime.js';

describe('WorkerDaemon', () => {
  it('announces local assets, renews progress, and reports a real thumbnail receipt', async () => {
    const calls: string[] = [];
    let stop = false;
    let leased = false;
    const client = {
      hello: async () => calls.push('hello'),
      lease: async () => {
        if (leased) return undefined;
        leased = true;
        return {
          id: 'job-1',
          projectId: 'project-1',
          type: 'asset.thumbnail',
          assetId: 'asset-intro',
        };
      },
      heartbeat: async (_jobId: string, progress: number) => {
        calls.push(`progress:${progress}`);
        return { cancelRequested: false };
      },
      uploadDerivative: async (
        _jobId: string,
        result: { readonly sha256: string; readonly bytes: number },
        bytes: Uint8Array,
      ) => {
        expect(bytes.byteLength).toBe(result.bytes);
        calls.push(`upload:${result.sha256.length}`);
      },
      complete: async (_jobId: string, result: { readonly sha256: string }) => {
        calls.push(`complete:${result.sha256.length}`);
        stop = true;
      },
      fail: async () => calls.push('fail'),
    } as unknown as WorkerControlPlaneClient;
    const derivativeDirectory = mkdtempSync(join(tmpdir(), 'joy-media-daemon-'));
    const source = join(
      process.cwd(),
      'apps',
      'editor-web',
      'public',
      'media',
      'reference',
      'asset-intro.mp4',
    );
    const runtime = new WorkerRuntime(
      { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: false },
      {
        sources: new StaticLocalAssetSourceRegistry({ 'asset-intro': source }),
        derivativeDirectory,
      },
    );
    try {
      await new WorkerDaemon(client, runtime).run({ pollIntervalMs: 1, stopped: () => stop });
      expect(calls).toEqual([
        'hello',
        'progress:5',
        'progress:25',
        'progress:75',
        'progress:90',
        'progress:100',
        'upload:64',
        'complete:64',
      ]);
    } finally {
      rmSync(derivativeDirectory, { recursive: true, force: true });
    }
  });
});
