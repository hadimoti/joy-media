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
  it('transcribes through the desktop bridge without calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const media = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    const { bridge, calls } = fakeBridge({
      'desktop.media.speech.transcribe': {
        language: 'en-US',
        words: [{ text: 'hello', startUs: 10, endUs: 20 }],
        speakers: [],
        provenance: { providerId: 'joy.local-whisper', modelId: 'local-whisper', createdAt: 'T0' },
      },
    });
    const client = new BrowserControlPlaneClient(bridge);

    await expect(
      client.transcribeSpeech('en-US', { media, mediaType: 'audio/wav' }),
    ).resolves.toMatchObject({
      words: [{ text: 'hello', startUs: 10, endUs: 20 }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.channel).toBe('desktop.media.speech.transcribe');
    expect(calls[0]?.payload).toMatchObject({
      language: 'en-US',
      media: new Uint8Array([1, 2, 3]),
      mediaType: 'audio/wav',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('refuses oversized Whisper blobs before buffering or calling the desktop bridge', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const media = Object.create(Blob.prototype) as Blob;
    Object.defineProperties(media, {
      size: { value: 200 * 1024 * 1024 + 1 },
      type: { value: 'audio/wav' },
      arrayBuffer: { value: arrayBuffer },
    });
    const { bridge, calls } = fakeBridge({});
    const client = new BrowserControlPlaneClient(bridge);

    await expect(client.transcribeSpeech('en-US', { media })).rejects.toThrow(
      'Local Whisper media exceeds the 200 MB limit.',
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('removes library assets through the catalog IPC channel and reports its result', async () => {
    const id = `joylib-${'a'.repeat(64)}`;
    const { bridge, calls } = fakeBridge({
      'desktop.asset-library.remove-entry': { removed: false },
    });
    const client = new BrowserControlPlaneClient(bridge);

    await expect(client.deleteAsset('project-1', id)).resolves.toMatchObject({ removed: false });
    expect(calls).toEqual([{ channel: 'desktop.asset-library.remove-entry', payload: { id } }]);
  });

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

  it('reports a job the desktop is running as leased, not queued', async () => {
    const { bridge } = fakeBridge({
      'desktop.media.render.enqueue': { jobId: 'desktop-job-run' },
      'desktop.media.job.status': {
        id: 'desktop-job-run',
        jobType: 'render.export',
        status: 'running',
        progress: 0.4,
        cancelRequested: false,
      },
    });
    const client = new BrowserControlPlaneClient(bridge);
    await client.enqueueRenderExport('project-run', 'editor-job-run', 'asset-run', {
      timeline: [],
    });

    const [status] = await client.jobs('project-run');
    expect(status).toMatchObject({ id: 'editor-job-run', state: 'leased' });
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

  it('sends a large original in pieces, then asks the desktop to commit it', async () => {
    const { bridge, calls } = fakeBridge({
      'desktop.media.asset.upload-original-chunk': { assetId: 'asset-big' },
      'desktop.media.asset.upload-original-finish': { assetId: 'asset-big' },
    });
    const client = new BrowserControlPlaneClient(bridge, { chunkedAboveBytes: 4, chunkBytes: 2 });
    const progress: number[] = [];

    await client.uploadAssetOriginal(
      'project-big',
      { id: 'asset-big', sha256: 'e'.repeat(64), bytes: 5, descriptor: { mimeType: 'video/mp4' } },
      new Blob([new Uint8Array([1, 2, 3, 4, 5])]),
      (ratio) => progress.push(ratio),
    );

    const pieces = calls.filter(
      (call) => call.channel === 'desktop.media.asset.upload-original-chunk',
    );
    expect(pieces.map((call) => (call.payload as { offset: number }).offset)).toEqual([0, 2, 4]);
    expect(pieces.map((call) => (call.payload as { bytes: Uint8Array }).bytes)).toEqual([
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
      new Uint8Array([5]),
    ]);
    expect(calls.at(-1)?.channel).toBe('desktop.media.asset.upload-original-finish');
    expect(calls.some((call) => call.channel === 'desktop.media.asset.upload-original')).toBe(
      false,
    );
    expect(progress).toEqual([0.4, 0.8, 1, 1]);
  });

  it('asks the desktop to drop an unfinished upload when a piece fails', async () => {
    const { bridge, calls } = fakeBridge({
      'desktop.media.asset.upload-original-chunk': new Error('disk full'),
      'desktop.media.asset.upload-original-abort': { assetId: 'asset-big' },
    });
    const client = new BrowserControlPlaneClient(bridge, { chunkedAboveBytes: 4, chunkBytes: 2 });

    await expect(
      client.uploadAssetOriginal(
        'project-big',
        {
          id: 'asset-big',
          sha256: 'e'.repeat(64),
          bytes: 5,
          descriptor: { mimeType: 'video/mp4' },
        },
        new Blob([new Uint8Array([1, 2, 3, 4, 5])]),
      ),
    ).rejects.toThrow('disk full');
    expect(calls.at(-1)?.channel).toBe('desktop.media.asset.upload-original-abort');
  });

  it('still drops the upload when the final commit is refused', async () => {
    const { bridge, calls } = fakeBridge({
      'desktop.media.asset.upload-original-chunk': { assetId: 'asset-big' },
      'desktop.media.asset.upload-original-finish': new Error('checksum mismatch'),
      'desktop.media.asset.upload-original-abort': { assetId: 'asset-big' },
    });
    const client = new BrowserControlPlaneClient(bridge, { chunkedAboveBytes: 4, chunkBytes: 2 });

    await expect(
      client.uploadAssetOriginal(
        'project-big',
        {
          id: 'asset-big',
          sha256: 'e'.repeat(64),
          bytes: 5,
          descriptor: { mimeType: 'video/mp4' },
        },
        new Blob([new Uint8Array([1, 2, 3, 4, 5])]),
      ),
    ).rejects.toThrow('checksum mismatch');
    expect(calls.at(-1)?.channel).toBe('desktop.media.asset.upload-original-abort');
  });

  it('reports the failed piece, not a failed abort, when both fail', async () => {
    const { bridge } = fakeBridge({
      'desktop.media.asset.upload-original-chunk': new Error('disk full'),
      'desktop.media.asset.upload-original-abort': new Error('desktop is gone'),
    });
    const client = new BrowserControlPlaneClient(bridge, { chunkedAboveBytes: 4, chunkBytes: 2 });

    await expect(
      client.uploadAssetOriginal(
        'project-big',
        {
          id: 'asset-big',
          sha256: 'e'.repeat(64),
          bytes: 5,
          descriptor: { mimeType: 'video/mp4' },
        },
        new Blob([new Uint8Array([1, 2, 3, 4, 5])]),
      ),
    ).rejects.toThrow('disk full');
  });

  it('stops at the first failed piece and sends nothing after it', async () => {
    const { bridge, calls } = fakeBridge({
      'desktop.media.asset.upload-original-chunk': (payload: unknown) => {
        if ((payload as { offset: number }).offset === 2) throw new Error('disk full');
        return { assetId: 'asset-big' };
      },
      'desktop.media.asset.upload-original-abort': { assetId: 'asset-big' },
    });
    const client = new BrowserControlPlaneClient(bridge, { chunkedAboveBytes: 4, chunkBytes: 2 });

    await expect(
      client.uploadAssetOriginal(
        'project-big',
        {
          id: 'asset-big',
          sha256: 'e'.repeat(64),
          bytes: 5,
          descriptor: { mimeType: 'video/mp4' },
        },
        new Blob([new Uint8Array([1, 2, 3, 4, 5])]),
      ),
    ).rejects.toThrow('disk full');
    expect(calls.map((call) => call.channel)).toEqual([
      'desktop.media.asset.upload-original-chunk',
      'desktop.media.asset.upload-original-chunk',
      'desktop.media.asset.upload-original-abort',
    ]);
  });

  it('sends a file of exactly the threshold size in one message', async () => {
    const { bridge, calls } = fakeBridge({
      'desktop.media.asset.upload-original': { assetId: 'asset-edge' },
    });
    const client = new BrowserControlPlaneClient(bridge, { chunkedAboveBytes: 4, chunkBytes: 2 });

    await client.uploadAssetOriginal(
      'project-edge',
      { id: 'asset-edge', sha256: 'e'.repeat(64), bytes: 4, descriptor: { mimeType: 'video/mp4' } },
      new Blob([new Uint8Array([1, 2, 3, 4])]),
    );

    expect(calls.map((call) => call.channel)).toEqual(['desktop.media.asset.upload-original']);
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
