import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalControlPlane } from '@joy-media/api';
import { createRenderBundle } from '@joy-media/render-planner';
import { executeLeasedExport } from './export-job.js';
import { StaticWorkerMediaResolver } from './worker-media-resolver.js';
describe('Worker/control-plane export integration', () => {
  it('pairs, leases, renders, verifies, completes, and replays events', async () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    api.createProject(owner, 'project', 'Reference');
    api.pairWorker(owner, 'worker');
    api.helloWorker('worker', ['render.export'], [], 100);
    const now = Date.now();
    api.enqueue(owner, 'job', 'project', 'render.export', now);
    expect(api.lease('worker', now + 1)?.id).toBe('job');
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-integration-'));
    await executeLeasedExport(
      {
        complete: (workerId, jobId, receipt) => api.complete(workerId, jobId, Date.now(), receipt),
      },
      'worker',
      'job',
      createRenderBundle({
        timelineProject: timelineProject(),
        visualProject: visualProject(),
        outputPreset: 'social-h264-aac',
        seed: 'integration',
      }),
      { outputDirectory: directory, mediaResolver: resolver(directory), frameLimit: 2 },
    );
    expect(api.eventsAfter(owner, 'project', 0).map((event) => event.type)).toEqual([
      'queued',
      'leased',
      'completed',
    ]);
  });
  it('recovers from an expired Worker lease without accepting stale completion', async () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    api.createProject(owner, 'project', 'Reference');
    api.pairWorker(owner, 'worker-old');
    api.pairWorker(owner, 'worker-new');
    api.helloWorker('worker-old', ['render.export'], [], 100);
    api.helloWorker('worker-new', ['render.export'], [], 100);
    const now = Date.now();
    api.enqueue(owner, 'job', 'project', 'render.export', now);
    expect(api.lease('worker-old', now + 1, 5)?.leaseOwner).toBe('worker-old');
    expect(api.lease('worker-new', now + 6, 30_000)?.leaseOwner).toBe('worker-new');
    expect(() => api.complete('worker-old', 'job', now + 7)).toThrow(
      expect.objectContaining({ code: 'LEASE_NOT_OWNED' }),
    );
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-recovered-export-'));
    await executeLeasedExport(
      {
        complete: (workerId, jobId, receipt) => api.complete(workerId, jobId, Date.now(), receipt),
      },
      'worker-new',
      'job',
      createRenderBundle({
        timelineProject: timelineProject(),
        visualProject: visualProject(),
        outputPreset: 'social-h264-aac',
        seed: 'recovered',
      }),
      { outputDirectory: directory, mediaResolver: resolver(directory), frameLimit: 2 },
    );
    expect(api.eventsAfter(owner, 'project', 0).at(-1)?.type).toBe('completed');
  });
});

function resolver(directory: string): StaticWorkerMediaResolver {
  const mediaPath = join(directory, 'private.mp4');
  writeFileSync(mediaPath, 'private media');
  return new StaticWorkerMediaResolver({ 'asset:clip': mediaPath });
}

function timelineProject() {
  return {
    schemaVersion: 0,
    id: 'timeline',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 64,
        height: 36,
        frameRate: { num: 30, den: 1 },
        durationUs: 100_000,
        tracks: [
          {
            id: 'track',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip',
                startUs: 0,
                durationUs: 100_000,
                assetId: 'clip',
                sourceInUs: 0,
              },
            ],
          },
        ],
      },
    },
  } as const;
}

function visualProject() {
  return {
    schemaVersion: 1,
    id: 'project',
    title: 'Reference',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 64,
        height: 36,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 100_000,
        background: '#000000',
        tracks: [],
      },
    },
    assets: { clip: { id: 'clip', kind: 'video', displayName: 'Clip' } },
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments: {},
    pluginData: {},
    audio: {
      clips: { clip: { gain: 0.75, pan: 0, mute: false, solo: false } },
      buses: [],
      effects: [],
    },
  } as const;
}
