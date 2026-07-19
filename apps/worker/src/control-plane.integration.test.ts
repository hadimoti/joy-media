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
    api.enqueue(owner, 'job', 'project', 'render.export', 100);
    expect(api.lease('worker', 101)?.id).toBe('job');
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
    );
    expect(api.eventsAfter(owner, 'project', 0).map((event) => event.type)).toEqual([
      'queued',
      'leased',
      'completed',
    ]);
  });
});
