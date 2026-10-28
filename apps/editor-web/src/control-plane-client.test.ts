import { describe, expect, it, vi } from 'vitest';
import {
  BrowserControlPlaneClient,
  BrowserControlPlaneRequestError,
} from './control-plane-client.js';
import type { DesktopMediaBridge } from './local-media-client.js';

// The client talks only to the desktop's local channels. A fake bridge records each call and
// answers from a table, so these tests never reach a network.

function fakeBridge(answers: Record<string, unknown | ((payload: unknown) => unknown)>) {
  const calls: { readonly channel: string; readonly payload: unknown }[] = [];
  const bridge: DesktopMediaBridge = {
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      const answer = answers[channel];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(payload) : answer;
    },
  };
  return { bridge, calls };
}

describe('BrowserControlPlaneClient on the local desktop channels', () => {
  it('saves a project document and maps each outcome to the editor contract', async () => {
    const { bridge } = fakeBridge({
      'desktop.media.project.document.put': (payload: unknown) => {
        const write = payload as { readonly baseRevisionId: string; readonly revisionId: string };
        if (write.baseRevisionId === 'stale') return { kind: 'conflict', revisionId: 'rev-1' };
        if (write.baseRevisionId === 'gone') return { kind: 'missing' };
        return { kind: 'saved', projectId: 'project-1', revisionId: write.revisionId };
      },
    });
    const client = new BrowserControlPlaneClient(bridge);
    const document = { schemaVersion: 1 } as never;

    await expect(
      client.syncProjectDocument('project-1', {
        baseRevisionId: '' as never,
        revisionId: 'rev-1' as never,
        document,
      }),
    ).resolves.toEqual({ projectId: 'project-1', revisionId: 'rev-1' });

    const conflict = await client
      .syncProjectDocument('project-1', {
        baseRevisionId: 'stale' as never,
        revisionId: 'rev-2' as never,
        document,
      })
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(BrowserControlPlaneRequestError);
    expect(conflict).toMatchObject({ status: 409, code: 'DOCUMENT_REVISION_CONFLICT' });

    const missing = await client
      .syncProjectDocument('project-1', {
        baseRevisionId: 'gone' as never,
        revisionId: 'rev-2' as never,
        document,
      })
      .catch((error: unknown) => error);
    expect(missing).toMatchObject({ status: 404, code: 'PROJECT_DOCUMENT_NOT_FOUND' });
  });

  it('reads a missing project document as undefined', async () => {
    const { bridge } = fakeBridge({ 'desktop.media.project.document.get': null });
    const client = new BrowserControlPlaneClient(bridge);
    await expect(client.projectDocument('project-missing')).resolves.toBeUndefined();
  });

  it('queues a render, maps its status, and cancels it, all by the editor job ID', async () => {
    const { bridge, calls } = fakeBridge({
      'desktop.media.render.enqueue': { jobId: 'desktop-job-1' },
      'desktop.media.job.status': {
        id: 'desktop-job-1',
        jobType: 'render.export',
        status: 'done',
        progress: 1,
        cancelRequested: false,
        derivative: { sha256: 'a'.repeat(64), bytes: 12, mimeType: 'video/mp4' },
      },
      'desktop.media.job.cancel': {
        id: 'desktop-job-2',
        jobType: 'render.export',
        status: 'cancelled',
        progress: 0,
        cancelRequested: true,
      },
      'desktop.media.derivative.bytes': {
        mimeType: 'video/mp4',
        sha256: 'a'.repeat(64),
        bytes: new Uint8Array([7, 8, 9]),
      },
    });
    const client = new BrowserControlPlaneClient(bridge);

    const queued = await client.enqueueRenderExport('project-r', 'editor-job-r1', 'asset-r1', {
      timeline: [],
    });
    expect(queued).toMatchObject({ id: 'editor-job-r1', state: 'queued' });
    expect(calls[0]).toEqual({
      channel: 'desktop.media.render.enqueue',
      payload: { refId: 'asset-r1', payload: { timeline: [] } },
    });

    const [status] = await client.jobs('project-r');
    expect(status).toMatchObject({ id: 'editor-job-r1', state: 'completed' });
    const [derivative] = await client.derivatives('project-r', 'asset-r1');
    expect(derivative).toMatchObject({ id: 'editor-job-r1', bytes: 12 });
    const bytes = await client.derivativeBytes('project-r', 'asset-r1', 'editor-job-r1');
    expect(bytes.type).toBe('video/mp4');
    expect(bytes.size).toBe(3);

    // Cancelling uses the desktop's job ID, never the editor's ID.
    await client.cancel('project-r', 'editor-job-r1');
    expect(calls.at(-1)).toEqual({
      channel: 'desktop.media.job.cancel',
      payload: { jobId: 'desktop-job-1' },
    });
  });

  it('uploads an original as bytes, and reads a derivative back as a blob', async () => {
    const { bridge, calls } = fakeBridge({
      'desktop.media.asset.register': { id: 'asset-u1' },
      'desktop.media.asset.upload-original': { assetId: 'asset-u1' },
    });
    const client = new BrowserControlPlaneClient(bridge);
    const registered = await client.registerAsset('project-u', {
      id: 'asset-u1',
      kind: 'video',
      displayName: 'clip.webm',
      sha256: 'c'.repeat(64),
      bytes: 3,
      descriptor: { mimeType: 'video/webm' },
      locations: [],
    });
    expect(registered).toMatchObject({
      id: 'asset-u1',
      projectId: 'project-u',
      cloudBacked: false,
    });

    await client.uploadAssetOriginal(
      'project-u',
      registered,
      new Blob([new Uint8Array([1, 2, 3])]),
    );
    const upload = calls.find((call) => call.channel === 'desktop.media.asset.upload-original');
    expect(upload?.payload).toMatchObject({ assetId: 'asset-u1' });
    expect((upload?.payload as { bytes: Uint8Array }).bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('lists the local worker from the desktop, with no pairing state', async () => {
    const { bridge } = fakeBridge({
      'desktop.media.workers.list': [
        {
          workerId: 'worker-local',
          capabilities: ['render.export'],
          lastHelloAt: '2026-10-28T10:00:00.000Z',
        },
      ],
    });
    const client = new BrowserControlPlaneClient(bridge);
    await expect(client.workers()).resolves.toEqual([
      {
        id: 'worker-local',
        paired: true,
        revoked: false,
        capabilities: ['render.export'],
        lastSeenAt: Date.parse('2026-10-28T10:00:00.000Z'),
      },
    ]);
  });

  it('refuses an operation that needs a service this build does not have', async () => {
    const { bridge, calls } = fakeBridge({});
    const client = new BrowserControlPlaneClient(bridge);
    await expect(client.retry('project-x', 'job-x')).rejects.toMatchObject({
      status: 501,
      code: 'NOT_AVAILABLE_LOCALLY',
      message: 'Retrying a job is not available in this build',
    });
    await expect(client.openGpuPreviewSession('project-x')).rejects.toMatchObject({
      code: 'NOT_AVAILABLE_LOCALLY',
    });
    expect(calls).toEqual([]);
  });

  it('refuses audio denoise locally with NOT_AVAILABLE_LOCALLY, without calling a channel', async () => {
    const { bridge, calls } = fakeBridge({});
    const client = new BrowserControlPlaneClient(bridge);
    await expect(
      client.denoiseAudio({
        projectId: 'project-d',
        operationId: 'op-1',
        assetId: 'asset-d',
        media: new Blob(),
      }),
    ).rejects.toMatchObject({ status: 501, code: 'NOT_AVAILABLE_LOCALLY' });
    expect(calls).toEqual([]);
  });

  it('makes no network request for any operation', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network is not allowed')));
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const { bridge } = fakeBridge({
        'desktop.media.workers.list': [],
        'desktop.media.project.document.get': null,
      });
      const client = new BrowserControlPlaneClient(bridge);
      await client.workers();
      await client.projectDocument('project-n');
      await client.ensureProject('project-n', 'Project N');
      await client.project('project-n');
      await client.assets('project-n');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});
