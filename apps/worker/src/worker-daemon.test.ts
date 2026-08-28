import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerControlPlaneClient } from './control-plane-client.js';
import { WorkerDaemon } from './worker-daemon.js';
import { StaticLocalAssetSourceRegistry, WorkerRuntime } from './runtime.js';

describe('WorkerDaemon', () => {
  it('re-announces idle presence on a configurable interval', async () => {
    let helloCount = 0;
    let stop = false;
    const client = {
      hello: async () => {
        helloCount += 1;
        if (helloCount >= 2) stop = true;
      },
      lease: async () => undefined,
    } as unknown as WorkerControlPlaneClient;
    const runtime = {
      hello: () => ({ capabilities: ['render.export'] }),
      localAssetIds: () => [],
      log: { write: () => undefined },
    } as never;

    await new WorkerDaemon(client, runtime).run({
      pollIntervalMs: 0,
      presenceIntervalMs: 0,
      stopped: () => stop,
    });

    expect(helloCount).toBe(2);
  });

  it('reports runtime failures exactly once with an actionable message and sanitized diagnostics', async () => {
    const failures: string[] = [];
    const logs: string[] = [];
    let stop = false;
    let leased = false;
    const client = {
      hello: async () => undefined,
      lease: async () => {
        if (leased) return undefined;
        leased = true;
        return { id: 'runtime-job', projectId: 'project-1', type: 'render.export' };
      },
      fail: async (_jobId: string, error: string) => {
        failures.push(error);
        stop = true;
      },
    } as unknown as WorkerControlPlaneClient;
    const runtime = {
      hello: () => ({ capabilities: ['render.export'] }),
      localAssetIds: () => [],
      run: async () => {
        throw new Error('Bearer super-secret https://private.example/path password=secret');
      },
      log: { write: (message: string) => logs.push(message) },
    } as never;

    await new WorkerDaemon(client, runtime).run({ pollIntervalMs: 0, stopped: () => stop });

    expect(failures).toEqual([
      'Worker execution failed; inspect local Worker logs and retry the job',
    ]);
    expect(failures).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain('super-secret');
    expect(logs[0]).not.toContain('private.example');
    expect(logs[0]).not.toContain('secret');
  });

  it('reports control-plane failures once per leased job', async () => {
    const failures: string[] = [];
    let stop = false;
    let leased = false;
    const client = {
      hello: async () => undefined,
      lease: async () => {
        if (leased) return undefined;
        leased = true;
        return { id: 'control-plane-job', projectId: 'project-1', type: 'render.export' };
      },
      heartbeat: async () => {
        throw new Error('heartbeat unavailable');
      },
      fail: async (_jobId: string, error: string) => {
        failures.push(error);
        stop = true;
      },
    } as unknown as WorkerControlPlaneClient;
    const runtime = {
      hello: () => ({ capabilities: ['render.export'] }),
      localAssetIds: () => [],
      run: async (
        _job: unknown,
        options: { readonly progress: (progress: number) => Promise<void> },
      ) => {
        await options.progress(10);
        return { state: 'completed' as const, result: { kind: 'render.export' as const } };
      },
      log: { write: () => undefined },
    } as never;

    await new WorkerDaemon(client, runtime).run({ pollIntervalMs: 0, stopped: () => stop });

    expect(failures).toEqual([
      'Worker control-plane communication failed; check API connectivity and retry the job',
    ]);
  });
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
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: false, aiProviders: [] },
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

  it('uploads a completed render artifact before posting the render receipt', async () => {
    const calls: string[] = [];
    let stop = false;
    let leased = false;
    const client = {
      hello: async () => calls.push('hello'),
      lease: async () => {
        if (leased) return undefined;
        leased = true;
        return { id: 'render-job', projectId: 'project-1', type: 'render.export' };
      },
      heartbeat: async () => ({ cancelRequested: false }),
      uploadRenderArtifact: async (_jobId: string, _result: unknown, bytes: Uint8Array) => {
        expect(bytes).toEqual(new Uint8Array([7, 8]));
        calls.push('artifact');
      },
      complete: async () => {
        calls.push('complete');
        stop = true;
      },
      fail: async () => calls.push('fail'),
    } as unknown as WorkerControlPlaneClient;
    const runtime = {
      hello: () => ({ capabilities: ['render.export'] }),
      localAssetIds: () => [],
      run: async () => ({
        state: 'completed' as const,
        result: {
          kind: 'render.export' as const,
          outputRef: 'render-render-job-aaaaaaaaaaaaaaaa',
          reportRef: 'report-render-job',
          sha256: 'a'.repeat(64),
          bytes: 2,
        },
      }),
      readRenderArtifact: () => new Uint8Array([7, 8]),
      log: { write: () => undefined },
    } as never;
    await new WorkerDaemon(client, runtime).run({ pollIntervalMs: 1, stopped: () => stop });
    expect(calls).toEqual(['hello', 'artifact', 'complete']);
  });
});
