import { describe, expect, it } from 'vitest';
import type { WorkerControlPlaneClient } from './control-plane-client.js';
import { WorkerDaemon } from './worker-daemon.js';
import { WorkerRuntime } from './runtime.js';

describe('WorkerDaemon', () => {
  it('announces capabilities, renews progress, and reports a fixture receipt', async () => {
    const calls: string[] = [];
    let stop = false;
    let leased = false;
    const client = {
      hello: async () => calls.push('hello'),
      lease: async () => {
        if (leased) return undefined;
        leased = true;
        return { id: 'job-1', projectId: 'project-1', type: 'fixture.thumbnail' };
      },
      heartbeat: async (_jobId: string, progress: number) => {
        calls.push(`progress:${progress}`);
        return { cancelRequested: false };
      },
      complete: async (_jobId: string, result: { readonly sha256: string }) => {
        calls.push(`complete:${result.sha256.length}`);
        stop = true;
      },
      fail: async () => calls.push('fail'),
    } as unknown as WorkerControlPlaneClient;
    const runtime = new WorkerRuntime(
      { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true },
    );

    await new WorkerDaemon(client, runtime).run({ pollIntervalMs: 1, stopped: () => stop });

    expect(calls).toEqual([
      'hello',
      'progress:5',
      'progress:50',
      'progress:90',
      'progress:100',
      'complete:64',
    ]);
  });
});
