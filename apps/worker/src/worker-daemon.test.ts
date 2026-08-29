import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerControlPlaneClient } from './control-plane-client.js';
import { WorkerSessionExpiredError } from './control-plane-client.js';
import { WorkerDaemon } from './worker-daemon.js';
import { StaticLocalAssetSourceRegistry, WorkerRuntime } from './runtime.js';
import type { GpuPreviewHost } from './gpu-preview-host.js';

describe('WorkerDaemon', () => {
  it('stops on session expiry so a supervisor can restart through pairing', async () => {
    const client = {
      hello: async () => undefined,
      lease: async () => {
        throw new WorkerSessionExpiredError();
      },
      heartbeat: async () => ({ cancelRequested: false }),
      complete: async () => undefined,
      fail: async () => undefined,
    } as unknown as WorkerControlPlaneClient;
    const runtime = new WorkerRuntime(
      { workerId: 'worker-expired', createdAt: '2026-08-29T00:00:00.000Z' },
      { ffmpeg: false, ffprobe: false, comfy: false, mlDenoise: false, aiProviders: [] },
    );

    await expect(
      new WorkerDaemon(client, runtime).run({ pollIntervalMs: 1, stopped: () => false }),
    ).rejects.toBeInstanceOf(WorkerSessionExpiredError);
  });

  it('propagates preview-loop session expiry to the daemon supervisor', async () => {
    const client = {
      hello: async () => undefined,
      lease: async () => undefined,
      nextGpuPreview: async () => {
        throw new WorkerSessionExpiredError();
      },
      completeGpuPreview: async () => undefined,
    } as unknown as WorkerControlPlaneClient;
    const runtime = new WorkerRuntime(
      { workerId: 'worker-preview-expired', createdAt: '2026-08-29T00:00:00.000Z' },
      { ffmpeg: false, ffprobe: false, comfy: false, mlDenoise: false, aiProviders: [] },
    );
    const gpuPreviewHost = {
      render: async () => {
        throw new Error('unreachable');
      },
    } as unknown as GpuPreviewHost;

    await expect(
      new WorkerDaemon(client, runtime, gpuPreviewHost).run({
        pollIntervalMs: 1,
        stopped: () => false,
      }),
    ).rejects.toBeInstanceOf(WorkerSessionExpiredError);
  });

  it('bounds idle GPU preview polling to the configured supervisor cadence', async () => {
    let stop = false;
    let previewCalls = 0;
    const client = {
      hello: async () => undefined,
      lease: async () => undefined,
      nextGpuPreview: async () => {
        previewCalls += 1;
        return undefined;
      },
      completeGpuPreview: async () => undefined,
    } as unknown as WorkerControlPlaneClient;
    const runtime = new WorkerRuntime(
      { workerId: 'worker-preview-idle', createdAt: '2026-08-29T00:00:00.000Z' },
      { ffmpeg: false, ffprobe: false, comfy: false, mlDenoise: false, aiProviders: [] },
    );
    const gpuPreviewHost = {
      render: async () => {
        throw new Error('unreachable');
      },
    } as unknown as GpuPreviewHost;

    const stopTimer = setTimeout(() => {
      stop = true;
    }, 85);
    try {
      await new WorkerDaemon(client, runtime, gpuPreviewHost).run({
        pollIntervalMs: 1,
        gpuPreviewPollIntervalMs: 60,
        stopped: () => stop,
      });
    } finally {
      clearTimeout(stopTimer);
    }

    expect(previewCalls).toBeLessThanOrEqual(2);
  });

  it('cancels an active job when the preview session expires', async () => {
    let jobStarted = false;
    const client = {
      hello: async () => undefined,
      lease: async () => ({ id: 'job-active', projectId: 'project-1', type: 'fixture.thumbnail' }),
      nextGpuPreview: async () => {
        while (!jobStarted) await new Promise((resolve) => setTimeout(resolve, 1));
        throw new WorkerSessionExpiredError();
      },
      completeGpuPreview: async () => undefined,
      heartbeat: async () => ({ cancelRequested: false }),
      complete: async () => undefined,
      fail: async () => undefined,
    } as unknown as WorkerControlPlaneClient;
    const runtime = {
      hello: () => ({ capabilities: [] }),
      localAssetIds: () => [],
      log: { write: () => undefined },
      run: async (
        _job: unknown,
        options: {
          readonly cancelled: () => boolean;
          readonly progress: (value: number) => Promise<void>;
        },
      ) => {
        jobStarted = true;
        while (!options.cancelled()) await new Promise((resolve) => setTimeout(resolve, 1));
        return { state: 'canceled' as const };
      },
    } as unknown as WorkerRuntime;
    const gpuPreviewHost = {
      render: async () => {
        throw new Error('unreachable');
      },
    } as never;

    await expect(
      new WorkerDaemon(client, runtime, gpuPreviewHost).run({
        pollIntervalMs: 1,
        stopped: () => false,
      }),
    ).rejects.toBeInstanceOf(WorkerSessionExpiredError);
  });

  it('completes the Jobs-panel fixture smoke job without uploading a derivative', async () => {
    const calls: string[] = [];
    let stop = false;
    let leased = false;
    const client = {
      hello: async () => calls.push('hello'),
      lease: async () => {
        if (leased) return undefined;
        leased = true;
        return { id: 'fixture-job', projectId: 'project-1', type: 'fixture.thumbnail' };
      },
      heartbeat: async (_jobId: string, progress: number) => {
        calls.push(`progress:${progress}`);
        return { cancelRequested: false };
      },
      uploadDerivative: async () => calls.push('unexpected-upload'),
      complete: async (_jobId: string, result: { readonly kind: string }) => {
        calls.push(`complete:${result.kind}`);
        stop = true;
      },
      fail: async () => calls.push('fail'),
    } as unknown as WorkerControlPlaneClient;
    const runtime = new WorkerRuntime(
      { workerId: 'worker-fixture', createdAt: '2026-07-22T00:00:00.000Z' },
      { ffmpeg: false, ffprobe: false, comfy: false, mlDenoise: false, aiProviders: [] },
    );

    await new WorkerDaemon(client, runtime).run({ pollIntervalMs: 1, stopped: () => stop });

    expect(calls).toEqual([
      'hello',
      'progress:5',
      'progress:50',
      'progress:90',
      'progress:100',
      'complete:fixture.thumbnail',
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
});
