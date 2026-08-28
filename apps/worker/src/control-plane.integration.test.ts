import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalControlPlane } from '@joy-media/api';
import { executeLeasedExport } from './export-job.js';
describe('Worker/control-plane export integration', () => {
  it('pairs, leases, renders, verifies, completes, and replays events', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    api.createProject(owner, 'project', 'Reference');
    api.pairWorker(owner, 'worker');
    const now = Date.now();
    api.enqueue(owner, 'job', 'project', 'render.export', now);
    const lease = api.lease('worker', now + 1);
    expect(lease?.id).toBe('job');
    const output = join(mkdtempSync(join(tmpdir(), 'joy-media-integration-')), 'output.mp4');
    executeLeasedExport(
      api,
      'worker',
      'job',
      {
        projectId: 'project',
        revision: 0,
        width: 64,
        height: 36,
        frameRate: 30,
        durationUs: 100_000,
        preset: 'social-h264-aac',
      },
      output,
      lease?.leaseToken,
    );
    expect(api.eventsAfter(owner, 'project', 0).map((event) => event.type)).toEqual([
      'queued',
      'leased',
      'completed',
    ]);
  });
  it('recovers from an expired Worker lease without accepting stale completion', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    api.createProject(owner, 'project', 'Reference');
    api.pairWorker(owner, 'worker-old');
    api.pairWorker(owner, 'worker-new');
    const now = Date.now();
    api.enqueue(owner, 'job', 'project', 'render.export', now);
    const oldLease = api.lease('worker-old', now + 1, 5);
    expect(oldLease?.leaseOwner).toBe('worker-old');
    const newLease = api.lease('worker-new', now + 6, 30_000);
    expect(newLease?.leaseOwner).toBe('worker-new');
    expect(() => api.complete('worker-old', 'job', now + 7)).toThrow(
      expect.objectContaining({ code: 'LEASE_NOT_OWNED' }),
    );
    const output = join(mkdtempSync(join(tmpdir(), 'joy-media-recovered-export-')), 'output.mp4');
    executeLeasedExport(
      api,
      'worker-new',
      'job',
      {
        projectId: 'project',
        revision: 0,
        width: 64,
        height: 36,
        frameRate: 30,
        durationUs: 100_000,
        preset: 'social-h264-aac',
      },
      output,
      newLease?.leaseToken,
    );
    expect(api.eventsAfter(owner, 'project', 0).at(-1)?.type).toBe('completed');
  });
});
