import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ProviderUnavailableError } from '@joy-media/provider-sdk';
import { join } from 'node:path';
import { LocalDatabase } from '../store/local-database.js';
import { createJobOrchestrator } from '../jobs/job-orchestrator.js';
import type { DispatchJob } from '../jobs/job-dispatch.js';
import {
  createLocalOriginalWriter,
  MAX_LOCAL_ORIGINAL_BYTES,
  MAX_ORIGINAL_CHUNK_BYTES,
} from './local-originals.js';
import { createMediaChannelHandlers, MEDIA_CHANNELS, publicJobError } from './media-channel.js';
import type { AssetLibraryPort } from '../store/asset-library.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(
  library?: AssetLibraryPort,
  whisper?: {
    endpoint?: string;
    modelId?: string;
  },
) {
  const db = new LocalDatabase({ filePath: ':memory:', now: () => 'T0' });
  let ids = 0;
  const orchestrator = createJobOrchestrator({
    store: db.jobDispatch,
    now: () => 'T0',
    newId: () => `job-${++ids}`,
    newLeaseToken: () => 'lease-token',
  });
  const originalsDir = mkdtempSync(join(tmpdir(), 'joy-media-originals-'));
  tempDirs.push(originalsDir);
  const handlers = createMediaChannelHandlers({
    orchestrator,
    jobStore: db.jobDispatch,
    projectDocuments: db.projectDocuments,
    assets: db.localAssets,
    originals: createLocalOriginalWriter({ directory: originalsDir, assets: db.localAssets }),
    ...(library === undefined ? {} : { library }),
    ...(whisper === undefined
      ? {}
      : {
          whisper: {
            getEndpoint: () =>
              whisper.endpoint === undefined
                ? undefined
                : { endpoint: whisper.endpoint, modelId: whisper.modelId ?? 'faster-whisper' },
          },
        }),
  });
  return { db, orchestrator, handlers };
}

function validWhisperPayload() {
  return { language: 'en-US', media: new Uint8Array([1, 2, 3]), mediaType: 'audio/wav' };
}

async function listenWhisperServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Server> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function closeWhisperServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

const DOCUMENT = { schemaVersion: 1, clips: [] };

describe('publicJobError', () => {
  it('keeps a plain Worker error, and withholds one that names a file', () => {
    expect(publicJobError('source is not a video')).toBe('source is not a video');
    expect(publicJobError("ENOENT: no such file, open 'C:\\Users\\HadiMoti\\clip.mp4'")).toBe(
      'The job failed. Its details are not shown here.',
    );
    expect(publicJobError(undefined)).toBeUndefined();
  });
});

describe('desktop.media channels', () => {
  it('declares every media channel once', () => {
    expect(new Set(MEDIA_CHANNELS).size).toBe(MEDIA_CHANNELS.length);
    expect(MEDIA_CHANNELS).toHaveLength(16);
    expect(MEDIA_CHANNELS).toContain('desktop.media.asset.upload-original-chunk');
    expect(MEDIA_CHANNELS).toContain('desktop.media.asset.upload-original-finish');
    expect(MEDIA_CHANNELS).toContain('desktop.media.asset.upload-original-abort');
  });

  it('connects localhost through 127.0.0.1 while preserving the Host header and saved model provenance', async () => {
    const server = await listenWhisperServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ words: [{ word: 'hello', start: 0.1, end: 0.4 }] }));
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Missing test server address');
      let host: string | undefined;
      server.once('request', (request) => {
        host = request.headers.host;
      });
      const { handlers } = setup(undefined, {
        endpoint: `http://localhost:${address.port}/v1`,
        modelId: 'whisper-large-v3',
      });

      await expect(
        handlers['desktop.media.speech.transcribe']({
          language: 'en-US',
          media: new Uint8Array([1, 2, 3]),
          mediaType: 'audio/wav',
        }),
      ).resolves.toMatchObject({
        ok: true,
        data: {
          language: 'en-US',
          words: [{ text: 'hello', startUs: 100_000, endUs: 400_000 }],
          provenance: { modelId: 'whisper-large-v3' },
        },
      });
      expect(host).toBe(`localhost:${address.port}`);
    } finally {
      await closeWhisperServer(server);
    }
  });

  it.each([
    ['unset', undefined],
    ['IPv6 loopback', 'http://[::1]:1234/v1'],
    ['public host', 'https://speech.example/v1'],
    ['localhost subdomain that resolves to loopback', 'http://whisper.localhost:1234/v1'],
    ['other name', 'http://speech.example:1234/v1'],
  ])('refuses %s without making a request', async (_label, endpoint) => {
    const server = await listenWhisperServer((_request, response) => response.end('{}'));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Missing test server address');
      let requestCount = 0;
      server.on('request', () => requestCount++);
      const { handlers } = setup(undefined, {
        ...(endpoint === undefined ? {} : { endpoint }),
      });
      await expect(
        handlers['desktop.media.speech.transcribe'](validWhisperPayload()),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(requestCount).toBe(0);
    } finally {
      await closeWhisperServer(server);
    }
  });

  it('treats a redirect response as an error', async () => {
    const server = await listenWhisperServer((_request, response) => {
      response.writeHead(302, { location: '/other' }).end();
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Missing test server address');
      const { handlers } = setup(undefined, { endpoint: `http://127.0.0.1:${address.port}/v1` });
      await expect(
        handlers['desktop.media.speech.transcribe'](validWhisperPayload()),
      ).rejects.toMatchObject({
        message: 'The local Whisper server could not process the media.',
      });
    } finally {
      await closeWhisperServer(server);
    }
  });

  it('refuses oversized media before making a request', async () => {
    const server = await listenWhisperServer((_request, response) => response.end('{}'));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Missing test server address');
      let requestCount = 0;
      server.on('request', () => requestCount++);
      const { handlers } = setup(undefined, { endpoint: `http://127.0.0.1:${address.port}/v1` });
      await expect(
        handlers['desktop.media.speech.transcribe']({
          ...validWhisperPayload(),
          media: new Uint8Array(200 * 1024 * 1024 + 1),
        }),
      ).rejects.toMatchObject({ message: 'Local Whisper media exceeds the 200 MB limit.' });
      expect(requestCount).toBe(0);
    } finally {
      await closeWhisperServer(server);
    }
  });

  it('refuses non-audio and non-video media types before making a request', async () => {
    const server = await listenWhisperServer((_request, response) => response.end('{}'));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Missing test server address');
      let requestCount = 0;
      server.on('request', () => requestCount++);
      const { handlers } = setup(undefined, { endpoint: `http://127.0.0.1:${address.port}/v1` });
      await expect(
        handlers['desktop.media.speech.transcribe']({
          ...validWhisperPayload(),
          mediaType: 'image/png',
        }),
      ).rejects.toMatchObject({ message: 'Local Whisper only accepts audio or video media.' });
      expect(requestCount).toBe(0);
    } finally {
      await closeWhisperServer(server);
    }
  });

  it('cuts off a streamed response after 64 MB', async () => {
    let closed = false;
    let resolveClosed!: () => void;
    const peerClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const server = await listenWhisperServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
      let sent = 0;
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      const interval = setInterval(() => {
        sent++;
        response.write(chunk);
      }, 2);
      response.on('close', () => {
        clearInterval(interval);
        closed = !response.writableEnded;
        if (closed) resolveClosed();
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Missing test server address');
      const { handlers } = setup(undefined, { endpoint: `http://127.0.0.1:${address.port}/v1` });
      await expect(
        handlers['desktop.media.speech.transcribe'](validWhisperPayload()),
      ).rejects.toMatchObject({
        message: 'The local Whisper server response exceeds the 64 MB limit.',
      });
      await peerClosed;
      expect(closed).toBe(true);
    } finally {
      await closeWhisperServer(server);
    }
  });

  it('rejects a response whose Content-Length exceeds 64 MB', async () => {
    let closed = false;
    const server = await listenWhisperServer((_request, response) => {
      response.on('close', () => {
        closed = !response.writableEnded;
      });
      response.writeHead(200, { 'content-length': String(64 * 1024 * 1024 + 1) }).flushHeaders();
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Missing test server address');
      const { handlers } = setup(undefined, { endpoint: `http://127.0.0.1:${address.port}/v1` });
      await expect(
        handlers['desktop.media.speech.transcribe'](validWhisperPayload()),
      ).rejects.toMatchObject({
        message: 'The local Whisper server response exceeds the 64 MB limit.',
      });
      await vi.waitFor(() => expect(closed).toBe(true));
    } finally {
      await closeWhisperServer(server);
    }
  });

  it('returns the fixed unavailable message when the request deadline expires', async () => {
    const server = await listenWhisperServer(() => undefined);
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Missing test server address');
      const { handlers } = setup(undefined, { endpoint: `http://127.0.0.1:${address.port}/v1` });
      const receivedRequest = new Promise<void>((resolve) =>
        server.once('request', () => resolve()),
      );
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const result = handlers['desktop.media.speech.transcribe'](validWhisperPayload());
      const unavailable = expect(result).rejects.toMatchObject({
        message: 'The local Whisper server could not process the media.',
      });
      await receivedRequest;
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      await unavailable;
    } finally {
      vi.useRealTimers();
      await closeWhisperServer(server);
    }
  });

  it('drops words with a negative start and refuses replies with no valid words', async () => {
    const server = await listenWhisperServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          words: [
            { word: 'bad', start: -0.1, end: 0.2 },
            { word: 'good', start: 0, end: 0.2, probability: 1.2 },
          ],
        }),
      );
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Missing test server address');
      const { handlers } = setup(undefined, { endpoint: `http://127.0.0.1:${address.port}/v1` });
      await expect(
        handlers['desktop.media.speech.transcribe'](validWhisperPayload()),
      ).resolves.toMatchObject({
        data: { words: [{ text: 'good', startUs: 0, endUs: 200_000 }] },
      });
    } finally {
      await closeWhisperServer(server);
    }
  });

  it('refuses Whisper replies that do not include timed words', async () => {
    const server = await listenWhisperServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ text: 'hello' }));
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Missing test server address');
      const { handlers } = setup(undefined, { endpoint: `http://127.0.0.1:${address.port}/v1` });
      await expect(
        handlers['desktop.media.speech.transcribe'](validWhisperPayload()),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
    } finally {
      await closeWhisperServer(server);
    }
  });

  it('validates catalog removal ids and passes valid ids through to the library', async () => {
    const removeEntry = vi.fn(async () => ({ removed: true }));
    const library: AssetLibraryPort = {
      addAsset: async () => ({ ok: true }),
      removeEntry,
    };
    const { handlers } = setup(library);
    const id = `joylib-${'a'.repeat(64)}`;

    await expect(handlers['desktop.asset-library.remove-entry']({ id })).resolves.toEqual({
      ok: true,
      data: { removed: true },
    });
    expect(removeEntry).toHaveBeenCalledWith(id);
    await expect(
      handlers['desktop.asset-library.remove-entry']({ id: '../catalog.json' }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/Invalid asset library entry id/),
    });
    expect(removeEntry).toHaveBeenCalledTimes(1);
  });

  it('returns a fixed safe message and logs unexpected catalog removal errors', async () => {
    const error = new Error('EACCES: C:\\private\\catalog.json.lock');
    const removeEntry = vi.fn(async () => {
      throw error;
    });
    const library: AssetLibraryPort = {
      addAsset: async () => ({ ok: true }),
      removeEntry,
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handlers } = setup(library);

    await expect(
      handlers['desktop.asset-library.remove-entry']({ id: `joylib-${'d'.repeat(64)}` }),
    ).resolves.toEqual({ ok: false, error: 'Catalog removal failed' });
    expect(log).toHaveBeenCalledWith('Catalog removal failed', error);
  });

  it('refuses a render before the Worker has reported the capability', () => {
    const { handlers } = setup();
    const result = handlers['desktop.media.render.enqueue']({
      refId: 'ref-1',
      payload: { timeline: [] },
    });
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('Worker has not reported its capabilities'),
    });
  });

  it('queues a render once the Worker has reported it, and reports its status', () => {
    const { orchestrator, handlers } = setup();
    orchestrator.hello('w-1', ['render.export']);
    const queued = handlers['desktop.media.render.enqueue']({
      refId: 'ref-1',
      payload: { timeline: [] },
    });
    expect(queued).toEqual({ ok: true, data: { jobId: 'job-1' } });
    const status = handlers['desktop.media.job.status']({ jobId: 'job-1' });
    expect(status).toMatchObject({ ok: true, data: { id: 'job-1', status: 'queued' } });
  });

  it('never returns a lease token, a worker id or a path in job status', () => {
    const { orchestrator, handlers } = setup();
    orchestrator.hello('w-1', ['render.export']);
    handlers['desktop.media.render.enqueue']({ refId: 'ref-1', payload: {} });
    const serialized = JSON.stringify(handlers['desktop.media.job.status']({ jobId: 'job-1' }));
    expect(serialized).not.toContain('lease-token');
    expect(serialized).not.toContain('w-1');
    expect(serialized).not.toContain('path');
  });

  it('cancels a queued job, and reports the result', () => {
    const { orchestrator, handlers } = setup();
    orchestrator.hello('w-1', ['render.export']);
    handlers['desktop.media.render.enqueue']({ refId: 'ref-1', payload: {} });
    const cancelled = handlers['desktop.media.job.cancel']({ jobId: 'job-1' });
    expect(cancelled).toMatchObject({ ok: true, data: { id: 'job-1', status: 'cancelled' } });
  });

  it('refuses an unknown job and an invalid job id', () => {
    const { handlers } = setup();
    expect(handlers['desktop.media.job.status']({ jobId: 'missing' })).toEqual({
      ok: false,
      error: 'Unknown job',
    });
    expect(handlers['desktop.media.job.status']({ jobId: '../escape' })).toEqual({
      ok: false,
      error: 'Invalid job id',
    });
  });

  it('refuses a render request with no reference or with a non-object payload', () => {
    const { orchestrator, handlers } = setup();
    orchestrator.hello('w-1', ['render.export']);
    expect(handlers['desktop.media.render.enqueue']({ payload: {} })).toEqual({
      ok: false,
      error: 'Invalid media request',
    });
    expect(handlers['desktop.media.render.enqueue']({ refId: 'ref-1', payload: [] })).toEqual({
      ok: false,
      error: 'Invalid media request',
    });
  });

  it('lists workers: none before a hello, then the reporting Worker', () => {
    const { orchestrator, handlers } = setup();
    expect(handlers['desktop.media.workers.list']({})).toEqual({ ok: true, data: [] });
    orchestrator.hello('w-1', ['render.export', 'audio.ml-denoise']);
    const listed = handlers['desktop.media.workers.list']({}) as {
      data: { workerId: string; capabilities: string[]; lastHelloAt: string }[];
    };
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({ workerId: 'w-1', lastHelloAt: 'T0' });
    expect([...listed.data[0]!.capabilities].sort()).toEqual(['audio.ml-denoise', 'render.export']);
  });

  it('refuses denoise, because the orchestrator does not dispatch audio.ml-denoise yet', () => {
    const { orchestrator, handlers } = setup();
    orchestrator.hello('w-1', ['audio.ml-denoise']);
    expect(handlers['desktop.media.audio.denoise']({ refId: 'ref-1', payload: {} })).toMatchObject({
      ok: false,
      error: expect.stringContaining('not available'),
    });
  });

  it('returns a finished derivative as bytes, after checking its checksum, and never its path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-media-channel-'));
    try {
      const bytes = Buffer.from('thumbnail-bytes');
      const path = join(dir, 'job-d-thumb.jpg');
      writeFileSync(path, bytes);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const { db, handlers } = setup();
      const job: DispatchJob = {
        id: 'job-d',
        kind: 'derivative:thumbnail',
        jobType: 'asset.thumbnail',
        refId: 'ref-1',
        status: 'done',
        createdAt: 'T0',
        updatedAt: 'T0',
        error: undefined,
        progress: 1,
        attempts: 1,
        workerId: 'w-1',
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        cancelRequested: false,
        derivative: { sha256, bytes: bytes.length, mimeType: 'image/jpeg', path },
        resultJson: undefined,
      };
      db.jobDispatch.insert(job);

      const result = await handlers['desktop.media.derivative.bytes']({ jobId: 'job-d' });
      expect(result).toMatchObject({
        ok: true,
        data: { mimeType: 'image/jpeg', sha256 },
      });
      expect(JSON.stringify(result)).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a derivative whose bytes no longer match the recorded checksum', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-media-channel-'));
    try {
      const path = join(dir, 'job-bad-thumb.jpg');
      writeFileSync(path, Buffer.from('tampered'));
      const { db, handlers } = setup();
      const job: DispatchJob = {
        id: 'job-bad',
        kind: 'derivative:thumbnail',
        jobType: 'asset.thumbnail',
        refId: 'ref-1',
        status: 'done',
        createdAt: 'T0',
        updatedAt: 'T0',
        error: undefined,
        progress: 1,
        attempts: 1,
        workerId: 'w-1',
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        cancelRequested: false,
        derivative: { sha256: 'a'.repeat(64), bytes: 8, mimeType: 'image/jpeg', path },
        resultJson: undefined,
      };
      db.jobDispatch.insert(job);
      const result = await handlers['desktop.media.derivative.bytes']({ jobId: 'job-bad' });
      expect(result).toEqual({ ok: false, error: 'Derivative failed its checksum' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a derivative file that is missing, without throwing', async () => {
    const { db, handlers } = setup();
    const job: DispatchJob = {
      id: 'job-missing',
      kind: 'derivative:thumbnail',
      jobType: 'asset.thumbnail',
      refId: 'ref-1',
      status: 'done',
      createdAt: 'T0',
      updatedAt: 'T0',
      error: undefined,
      progress: 1,
      attempts: 1,
      workerId: 'w-1',
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      cancelRequested: false,
      derivative: {
        sha256: 'a'.repeat(64),
        bytes: 3,
        mimeType: 'image/jpeg',
        path: join(tmpdir(), 'joy-media-channel-no-such-file.jpg'),
      },
      resultJson: undefined,
    };
    db.jobDispatch.insert(job);
    const result = await handlers['desktop.media.derivative.bytes']({ jobId: 'job-missing' });
    expect(result).toEqual({ ok: false, error: 'Derivative file is not available' });
  });

  it('reports not-yet-available for the channels whose local stores are not built', () => {
    const { handlers } = setup();
    for (const channel of ['desktop.media.preview.frame', 'desktop.media.audio.denoise'] as const) {
      const result = handlers[channel]({});
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('not available') });
    }
  });

  it('stores a project document, refuses a stale base, and reports a missing project', () => {
    const { handlers } = setup();
    expect(
      handlers['desktop.media.project.document.put']({
        projectId: 'proj-1',
        baseRevisionId: '',
        revisionId: 'rev-1',
        document: DOCUMENT,
      }),
    ).toEqual({ ok: true, data: { kind: 'saved', projectId: 'proj-1', revisionId: 'rev-1' } });
    expect(handlers['desktop.media.project.document.get']({ projectId: 'proj-1' })).toEqual({
      ok: true,
      data: { projectId: 'proj-1', revisionId: 'rev-1', document: DOCUMENT },
    });
    expect(
      handlers['desktop.media.project.document.put']({
        projectId: 'proj-1',
        baseRevisionId: 'rev-0',
        revisionId: 'rev-2',
        document: DOCUMENT,
      }),
    ).toEqual({ ok: true, data: { kind: 'conflict', revisionId: 'rev-1' } });
    expect(
      handlers['desktop.media.project.document.put']({
        projectId: 'proj-2',
        baseRevisionId: 'rev-1',
        revisionId: 'rev-2',
        document: DOCUMENT,
      }),
    ).toEqual({ ok: true, data: { kind: 'missing' } });
  });

  it('reads nothing for an unknown project or for an older revision', () => {
    const { handlers } = setup();
    handlers['desktop.media.project.document.put']({
      projectId: 'proj-1',
      baseRevisionId: '',
      revisionId: 'rev-1',
      document: DOCUMENT,
    });
    expect(handlers['desktop.media.project.document.get']({ projectId: 'missing' })).toEqual({
      ok: true,
      data: null,
    });
    expect(
      handlers['desktop.media.project.document.get']({ projectId: 'proj-1', revisionId: 'rev-0' }),
    ).toEqual({ ok: true, data: null });
  });

  it('refuses a document write with a bad project ID or a document that is not an object', () => {
    const { handlers } = setup();
    expect(
      handlers['desktop.media.project.document.put']({
        projectId: '../escape',
        baseRevisionId: '',
        revisionId: 'rev-1',
        document: DOCUMENT,
      }),
    ).toEqual({ ok: false, error: 'Invalid media request' });
    expect(
      handlers['desktop.media.project.document.put']({
        projectId: 'proj-1',
        baseRevisionId: '',
        revisionId: 'rev-1',
        document: [],
      }),
    ).toEqual({ ok: false, error: 'Invalid media request' });
  });

  it('refuses a Look Instances document over the same size cap as the document', () => {
    const { handlers } = setup();
    expect(
      handlers['desktop.media.project.document.put']({
        projectId: 'proj-1',
        baseRevisionId: '',
        revisionId: 'rev-1',
        document: DOCUMENT,
        lookInstances: { blob: 'x'.repeat(32 * 1024 * 1024) },
      }),
    ).toEqual({ ok: false, error: 'Invalid media request' });
  });

  it('says why an original is refused when it is larger than the local limit', () => {
    const { handlers } = setup();
    expect(
      handlers['desktop.media.asset.register']({
        id: 'asset-large',
        kind: 'video',
        displayName: 'large.mp4',
        sha256: 'a'.repeat(64),
        bytes: MAX_LOCAL_ORIGINAL_BYTES + 1,
      }),
    ).toEqual({ ok: false, error: 'The original is larger than the 5 GiB local limit' });
  });

  it('stores an original sent in pieces only when the finished file matches the registration', async () => {
    const { db, handlers } = setup();
    const bytes = Buffer.from('chunked-original-bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const registration = {
      id: 'asset-chunked',
      kind: 'video',
      displayName: 'clip.webm.stage',
      sha256,
      bytes: bytes.length,
      descriptor: { mimeType: 'video/webm' },
    };
    expect(handlers['desktop.media.asset.register'](registration)).toEqual({
      ok: true,
      data: { id: 'asset-chunked' },
    });

    expect(
      await handlers['desktop.media.asset.upload-original-chunk']({
        assetId: 'asset-chunked',
        offset: 3,
        bytes: new Uint8Array(bytes.subarray(3)),
      }),
    ).toEqual({ ok: false, error: 'Original upload is out of order' });
    expect(
      await handlers['desktop.media.asset.upload-original-chunk']({
        assetId: 'asset-chunked',
        offset: 0,
        bytes: new Uint8Array(bytes.subarray(0, 8)),
      }),
    ).toEqual({ ok: true, data: { assetId: 'asset-chunked' } });
    expect(
      await handlers['desktop.media.asset.upload-original-chunk']({
        assetId: 'asset-chunked',
        offset: 8,
        bytes: new Uint8Array(bytes.subarray(8)),
      }),
    ).toEqual({ ok: true, data: { assetId: 'asset-chunked' } });
    expect(
      await handlers['desktop.media.asset.upload-original-finish']({ assetId: 'asset-chunked' }),
    ).toEqual({ ok: true, data: { assetId: 'asset-chunked' } });

    const storedPath = db.localAssets.storedPath('asset-chunked');
    expect(storedPath).toBeDefined();
    expect(readFileSync(storedPath!).equals(bytes)).toBe(true);
  });

  it('refuses a malformed chunk or finish request before it reaches the disk', async () => {
    const { handlers } = setup();
    expect(
      await handlers['desktop.media.asset.upload-original-chunk']({
        assetId: 'asset-1',
        offset: -1,
        bytes: new Uint8Array(1),
      }),
    ).toEqual({ ok: false, error: 'Invalid media request' });
    expect(await handlers['desktop.media.asset.upload-original-finish']({})).toEqual({
      ok: false,
      error: 'Invalid media request',
    });
  });

  it('refuses a piece above the one-message limit, or one whose offset is not a whole number', async () => {
    const { handlers } = setup();
    expect(
      await handlers['desktop.media.asset.upload-original-chunk']({
        assetId: 'asset-1',
        offset: 0,
        bytes: new Uint8Array(MAX_ORIGINAL_CHUNK_BYTES + 1),
      }),
    ).toEqual({ ok: false, error: 'Invalid media request' });
    expect(
      await handlers['desktop.media.asset.upload-original-chunk']({
        assetId: 'asset-1',
        offset: 1.5,
        bytes: new Uint8Array(1),
      }),
    ).toEqual({ ok: false, error: 'Invalid media request' });
  });

  it('drops an unfinished upload when the renderer aborts it, so it cannot be finished', async () => {
    const { handlers } = setup();
    const bytes = Buffer.from('aborted-original-bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    handlers['desktop.media.asset.register']({
      id: 'asset-aborted',
      kind: 'video',
      displayName: 'clip.webm.stage',
      sha256,
      bytes: bytes.length,
      descriptor: { mimeType: 'video/webm' },
    });
    await handlers['desktop.media.asset.upload-original-chunk']({
      assetId: 'asset-aborted',
      offset: 0,
      bytes: new Uint8Array(bytes.subarray(0, 8)),
    });

    expect(
      await handlers['desktop.media.asset.upload-original-abort']({ assetId: 'asset-aborted' }),
    ).toEqual({ ok: true, data: { assetId: 'asset-aborted' } });
    expect(
      await handlers['desktop.media.asset.upload-original-finish']({ assetId: 'asset-aborted' }),
    ).toEqual({ ok: false, error: 'Original upload is incomplete' });
  });

  it('registers an asset, and stores an original only when it matches the registration', async () => {
    const { db, handlers } = setup();
    const bytes = Buffer.from('original-bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const registration = {
      id: 'asset-1',
      kind: 'video',
      displayName: 'clip.webm.stage',
      sha256,
      bytes: bytes.length,
      descriptor: { mimeType: 'video/webm', durationUs: 1_000_000 },
    };
    expect(handlers['desktop.media.asset.register'](registration)).toEqual({
      ok: true,
      data: { id: 'asset-1' },
    });
    expect(handlers['desktop.media.asset.register'](registration)).toEqual({
      ok: true,
      data: { id: 'asset-1' },
    });
    expect(
      handlers['desktop.media.asset.register']({ ...registration, sha256: 'b'.repeat(64) }),
    ).toEqual({ ok: false, error: 'Asset ID is already registered with other content' });
    expect(handlers['desktop.media.asset.register']({ ...registration, id: '../escape' })).toEqual({
      ok: false,
      error: 'Invalid media request',
    });

    const stored = await handlers['desktop.media.asset.upload-original']({
      assetId: 'asset-1',
      bytes: new Uint8Array(bytes),
    });
    expect(stored).toEqual({ ok: true, data: { assetId: 'asset-1' } });
    const storedPath = db.localAssets.storedPath('asset-1');
    expect(storedPath).toBeDefined();
    expect(readFileSync(storedPath!).equals(bytes)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(storedPath!);
    expect(db.localAssets.get('asset-1')?.descriptor).toEqual(registration.descriptor);

    expect(
      await handlers['desktop.media.asset.upload-original']({
        assetId: 'asset-1',
        bytes: new Uint8Array(Buffer.from('original-bytes-longer')),
      }),
    ).toEqual({ ok: false, error: 'Original size does not match its registration' });
    expect(
      await handlers['desktop.media.asset.upload-original']({
        assetId: 'asset-1',
        bytes: new Uint8Array(Buffer.from('ORIGINAL-BYTES')),
      }),
    ).toEqual({ ok: false, error: 'Original does not match its registered checksum' });
    expect(
      await handlers['desktop.media.asset.upload-original']({
        assetId: 'asset-unknown',
        bytes: new Uint8Array(bytes),
      }),
    ).toEqual({ ok: false, error: 'Asset is not registered' });
    expect(existsSync(storedPath!)).toBe(true);
  });

  it('reports a library failure after storing the uploaded original', async () => {
    let addedId: string | undefined;
    const { handlers, db } = setup({
      async addAsset(assetId) {
        addedId = assetId;
        return { ok: false, error: 'The asset library could not be updated: disk full' };
      },
      async removeEntry() {
        return { removed: false };
      },
    });
    const bytes = Buffer.from('original-bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    handlers['desktop.media.asset.register']({
      id: 'asset-2',
      kind: 'video',
      displayName: 'clip.webm',
      sha256,
      bytes: bytes.length,
    });
    expect(
      await handlers['desktop.media.asset.upload-original']({ assetId: 'asset-2', bytes }),
    ).toEqual({ ok: false, error: 'The asset library could not be updated: disk full' });
    expect(addedId).toBe('asset-2');
    expect(db.localAssets.storedPath('asset-2')).toBeDefined();
  });
});
