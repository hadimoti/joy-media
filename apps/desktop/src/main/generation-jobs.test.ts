import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderBroker } from './providers/provider-broker.js';
import {
  createGenerationJobs,
  createPinnedGenerationDownloader,
  probeGeneratedMedia,
  type GenerationDownload,
  type GenerationJobs,
  type GenerationJobsOptions,
  type ProbedGeneratedMedia,
} from './generation-jobs.js';
import type { GenerationJobRecord, GenerationJobStore } from '../store/generation-job-store.js';
import type { ProviderProfile } from '../store/local-database.js';

const NOW = Date.UTC(2026, 10, 14);
const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const VIDEO_BYTES = Buffer.from('generated-video');

const PROFILE: ProviderProfile = {
  id: 'profile-1',
  provider: 'minimax',
  baseUrl: 'https://api.minimax.io/v1',
  modelId: 'chat-model',
  secretHandleId: 'secret-handle',
  createdAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
};

function memoryStore(seed: readonly GenerationJobRecord[] = []) {
  const rows = new Map(seed.map((job) => [job.id, job]));
  const history = new Map<string, string[]>();
  const store: GenerationJobStore = {
    save(job) {
      rows.set(job.id, { ...job });
      const states = history.get(job.id) ?? [];
      if (states.at(-1) !== job.state) states.push(job.state);
      history.set(job.id, states);
    },
    get(id) {
      const job = rows.get(id);
      return job === undefined ? undefined : { ...job };
    },
    list() {
      return [...rows.values()].map((job) => ({ ...job }));
    },
  };
  return { store, history, rows };
}

interface Harness {
  readonly manager: GenerationJobs;
  readonly store: ReturnType<typeof memoryStore>;
  readonly directory: string;
  readonly generatedDirectory: string;
  readonly broker: {
    readonly generateImage: ReturnType<typeof vi.fn>;
    readonly startVideo: ReturnType<typeof vi.fn>;
    readonly videoStatus: ReturnType<typeof vi.fn>;
    readonly cancelVideo: ReturnType<typeof vi.fn>;
    readonly videoFileLink: ReturnType<typeof vi.fn>;
  };
  readonly download: ReturnType<typeof vi.fn>;
  readonly probe: ReturnType<typeof vi.fn>;
}

const directories: string[] = [];
const managers: GenerationJobs[] = [];

function harness(
  options: {
    readonly seed?: readonly GenerationJobRecord[];
    readonly maxImageBytes?: number;
    readonly maxVideoBytes?: number;
    readonly imageBytes?: Buffer;
    readonly videoBytes?: Buffer;
    readonly download?: ReturnType<typeof vi.fn>;
    readonly probe?: ReturnType<typeof vi.fn>;
  } = {},
): Harness {
  const directory = mkdtempSync(path.join(process.cwd(), '.joy-generated-'));
  directories.push(directory);
  const generatedDirectory = path.join(directory, 'generated');
  const store = memoryStore(options.seed);
  const imageBytes = options.imageBytes ?? IMAGE_BYTES;
  const videoBytes = options.videoBytes ?? VIDEO_BYTES;
  const broker = {
    generateImage: vi.fn(async () => ({
      ok: true as const,
      data: {
        base64: imageBytes.toString('base64'),
        mimeType: 'image/png' as const,
        model: 'MiniMax-H3-Image',
        route: 'current' as const,
      },
    })),
    startVideo: vi.fn(async () => ({
      ok: true as const,
      data: { taskId: 'task-1', route: 'current' as const },
    })),
    videoStatus: vi.fn(async () => ({ ok: true as const, data: { status: 'queued' as const } })),
    cancelVideo: vi.fn(async () => ({ ok: true as const, data: { cancelled: true } })),
    videoFileLink: vi.fn(async () => ({
      ok: true as const,
      data: { downloadUrl: 'https://assets.example/generated-file' },
    })),
  };
  const download =
    options.download ??
    vi.fn(async (): Promise<GenerationDownload> => ({
      body: Readable.from([videoBytes]),
      contentLength: videoBytes.byteLength,
    }));
  const probe =
    options.probe ??
    vi.fn(async (): Promise<ProbedGeneratedMedia> => ({ kind: 'video', extension: 'mp4' }));
  let nextId = 0;
  const manager = createGenerationJobs({
    store: store.store,
    getProfile: (id) => (id === PROFILE.id ? PROFILE : undefined),
    broker: broker as unknown as GenerationJobsOptions['broker'],
    generatedDirectory,
    download,
    probe,
    now: () => Date.now(),
    newId: () => {
      nextId += 1;
      return `generation-${nextId}`;
    },
    ...(options.maxImageBytes === undefined ? {} : { maxImageBytes: options.maxImageBytes }),
    ...(options.maxVideoBytes === undefined ? {} : { maxVideoBytes: options.maxVideoBytes }),
  });
  managers.push(manager);
  return { manager, store, directory, generatedDirectory, broker, download, probe };
}

async function waitForState(
  manager: GenerationJobs,
  jobId: string,
  expected: GenerationJobRecord['state'],
): Promise<void> {
  await vi.waitFor(() => expect(manager.status(jobId)?.state).toBe(expected), {
    interval: 5,
    timeout: 3_000,
  });
}

function pendingVideo(overrides: Partial<GenerationJobRecord> = {}): GenerationJobRecord {
  return {
    id: 'generation-1',
    kind: 'video',
    provider: 'minimax',
    profileId: PROFILE.id,
    model: 'MiniMax-H3-Lite',
    prompt: 'A quiet lake at dawn',
    state: 'queued',
    costNote: 'Provider pricing applies; JOY Media does not estimate the charge.',
    providerTaskId: 'task-1',
    route: 'current',
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

/** A download that sends one chunk and then stops sending, as a host can after the headers. */
function stalledBody(signal: AbortSignal): Readable {
  const body = new Readable({ read() {} });
  body.push(VIDEO_BYTES);
  signal.addEventListener('abort', () => body.destroy(), { once: true });
  return body;
}

/** A download that sends one byte every interval until it is aborted. */
function trickleBody(signal: AbortSignal, intervalMs: number): Readable {
  const body = new Readable({ read() {} });
  const timer = setInterval(() => body.push(Buffer.from('x')), intervalMs);
  signal.addEventListener(
    'abort',
    () => {
      clearInterval(timer);
      body.destroy();
    },
    { once: true },
  );
  return body;
}

const SUCCEEDED = { ok: true, data: { status: 'succeeded', fileId: 'file-1' } } as const;

describe('generation job manager', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.stop();
    vi.useRealTimers();
    const workspace = path.resolve(process.cwd());
    for (const directory of directories.splice(0)) {
      const resolved = path.resolve(directory);
      if (!resolved.startsWith(`${workspace}${path.sep}`)) {
        throw new Error('Refusing to remove a test directory outside the workspace');
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('streams a picture to user data, checks it, hashes it, and records each state change', async () => {
    const probe = vi.fn(async (): Promise<ProbedGeneratedMedia> => ({
      kind: 'image',
      extension: 'png',
    }));
    const { manager, store, generatedDirectory } = harness({ probe });

    const started = await manager.start({
      profileId: PROFILE.id,
      kind: 'image',
      prompt: 'a red square',
    });
    await waitForState(manager, started.id, 'completed');

    const job = manager.status(started.id);
    expect(job).toMatchObject({
      state: 'completed',
      model: 'MiniMax-H3-Image',
      filePath: path.join(generatedDirectory, 'generation-1.png'),
      sha256: createHash('sha256').update(IMAGE_BYTES).digest('hex'),
    });
    expect(readFileSync(job?.filePath ?? '')).toEqual(IMAGE_BYTES);
    expect(store.history.get(started.id)).toEqual([
      'queued',
      'running',
      'downloading',
      'completed',
    ]);
    expect(probe).toHaveBeenCalledOnce();
  });

  it('polls a video every ten seconds and downloads it as soon as the provider reports success', async () => {
    const { manager, store, broker, generatedDirectory } = harness();
    const started = await manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    expect(started.state).toBe('queued');

    broker.videoStatus.mockResolvedValueOnce({ ok: true, data: { status: 'running' } });
    await vi.advanceTimersByTimeAsync(10_000);
    await waitForState(manager, started.id, 'running');
    expect(broker.videoStatus).toHaveBeenCalledTimes(1);

    broker.videoStatus.mockResolvedValueOnce({
      ok: true,
      data: { status: 'succeeded', fileId: 'file-1' },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await waitForState(manager, started.id, 'completed');

    const job = manager.status(started.id);
    expect(job).toMatchObject({
      filePath: path.join(generatedDirectory, 'generation-1.mp4'),
      sha256: createHash('sha256').update(VIDEO_BYTES).digest('hex'),
    });
    expect(readFileSync(job?.filePath ?? '')).toEqual(VIDEO_BYTES);
    expect(store.history.get(started.id)).toEqual([
      'queued',
      'running',
      'downloading',
      'completed',
    ]);
    expect(broker.videoFileLink).toHaveBeenCalledWith({ profileId: PROFILE.id, fileId: 'file-1' });
    expect(JSON.stringify(job)).not.toContain('https://assets.example');
  });

  it('refuses insecure, credential-bearing, and private video download addresses before fetching', async () => {
    const resolveHost = vi.fn(async () => ['10.0.0.8']);
    const fallbackFetch = vi.fn(async () => new Response('unused'));
    const download = createPinnedGenerationDownloader({ resolveHost, fallbackFetch });
    const signal = new AbortController().signal;

    await expect(download('http://127.0.0.1/file', signal)).rejects.toThrow(/refused/i);
    const credentialUrl = 'https://user' + String.fromCharCode(64) + 'cdn.example/file';
    await expect(download(credentialUrl, signal)).rejects.toThrow(/refused/i);
    await expect(download('https://cdn.example/file', signal)).rejects.toThrow(/public addresses/i);

    expect(resolveHost).toHaveBeenCalledOnce();
    expect(fallbackFetch).not.toHaveBeenCalled();
  });

  it('asks the provider to cancel a queued task', async () => {
    const { manager, broker } = harness();
    const started = await manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });

    const cancelled = await manager.cancel(started.id);

    expect(broker.cancelVideo).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: PROFILE.id, taskId: 'task-1', route: 'current' }),
    );
    expect(cancelled?.state).toBe('cancelled');
  });

  it('abandons a running video locally without calling provider cancellation', async () => {
    const { manager, broker } = harness();
    const started = await manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    broker.videoStatus.mockResolvedValue({ ok: true, data: { status: 'running' } });
    await vi.advanceTimersByTimeAsync(10_000);
    await waitForState(manager, started.id, 'running');

    const abandoned = await manager.cancel(started.id);

    expect(abandoned?.state).toBe('abandoned-locally');
    expect(broker.cancelVideo).not.toHaveBeenCalled();
  });

  it('times out an unfinished video after fifteen minutes', async () => {
    const { manager, broker } = harness();
    const started = await manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    await waitForState(manager, started.id, 'timed-out');

    expect(broker.videoStatus.mock.calls.length).toBeLessThanOrEqual(90);
    expect(manager.status(started.id)?.state).toBe('timed-out');
  });

  it('aborts a status request that is still pending at the fifteen-minute deadline', async () => {
    const { manager, broker } = harness();
    broker.videoStatus.mockImplementation(() => new Promise(() => {}));
    const started = await manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(manager.status(started.id)?.state).toBe('timed-out');
    expect(broker.videoStatus.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });

  it('resumes polling for a queued provider task after restart', async () => {
    const h = harness({ seed: [pendingVideo()] });
    const manager = h.manager;
    h.broker.videoStatus.mockResolvedValue({ ok: true, data: { status: 'running' } });

    manager.resume();
    await vi.advanceTimersByTimeAsync(10_000);
    await waitForState(manager, 'generation-1', 'running');

    expect(h.broker.videoStatus).toHaveBeenCalledOnce();
  });

  it('refuses a downloaded video over the configured cap and leaves no result file', async () => {
    const tooLarge = Buffer.alloc(5);
    const download = vi.fn(async (): Promise<GenerationDownload> => ({
      body: Readable.from([tooLarge]),
    }));
    const { manager, broker, generatedDirectory } = harness({ maxVideoBytes: 4, download });
    const started = await manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    broker.videoStatus.mockResolvedValueOnce({
      ok: true,
      data: { status: 'succeeded', fileId: 'file-1' },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await waitForState(manager, started.id, 'failed');

    expect(readdirSync(generatedDirectory)).toEqual([]);
  });

  it('refuses an image over the configured cap and leaves no result file', async () => {
    const probe = vi.fn(async (): Promise<ProbedGeneratedMedia> => ({
      kind: 'image',
      extension: 'png',
    }));
    const { manager, generatedDirectory } = harness({
      maxImageBytes: 4,
      imageBytes: Buffer.alloc(5),
      probe,
    });
    const started = await manager.start({
      profileId: PROFILE.id,
      kind: 'image',
      prompt: 'a red square',
    });

    await waitForState(manager, started.id, 'failed');

    expect(readdirSync(generatedDirectory)).toEqual([]);
    expect(manager.status(started.id)?.filePath).toBeUndefined();
  });

  it('rejects a result whose ffprobe classification does not match the requested kind', async () => {
    const probe = vi.fn(async (): Promise<ProbedGeneratedMedia> => ({
      kind: 'image',
      extension: 'png',
    }));
    const { manager, broker, generatedDirectory } = harness({ probe });
    const started = await manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    broker.videoStatus.mockResolvedValueOnce({
      ok: true,
      data: { status: 'succeeded', fileId: 'file-1' },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await waitForState(manager, started.id, 'failed');

    expect(readdirSync(generatedDirectory)).toEqual([]);
  });

  it('refuses a third picture while two are active, and a second video while one is active', async () => {
    const { manager, broker } = harness();
    broker.generateImage.mockImplementation(() => new Promise(() => {}));
    const picture = { profileId: PROFILE.id, kind: 'image' as const, prompt: 'a red square' };
    const video = { profileId: PROFILE.id, kind: 'video' as const, prompt: 'a slow pan' };
    const refusal = 'Wait for the running picture or video to finish first.';

    await manager.start(picture);
    await manager.start(picture);
    await expect(manager.start(picture)).rejects.toThrow(refusal);

    await manager.start(video);
    await expect(manager.start(video)).rejects.toThrow(refusal);

    expect(manager.list()).toHaveLength(3);
  });

  it('fails a video download that sends no data for thirty seconds and removes the partial file', async () => {
    const download = vi.fn(async (_url: string, signal: AbortSignal) => ({
      body: stalledBody(signal),
    }));
    const { manager, broker, generatedDirectory } = harness({ download });
    const started = await manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    broker.videoStatus.mockResolvedValueOnce(SUCCEEDED);

    await vi.advanceTimersByTimeAsync(10_000);
    await waitForState(manager, started.id, 'downloading');
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForState(manager, started.id, 'failed');

    expect(manager.status(started.id)?.error).toBe(
      'The video download stopped sending data for 30 seconds.',
    );
    await vi.waitFor(() => expect(readdirSync(generatedDirectory)).toEqual([]));
  });

  it('fails a video download that runs past five minutes even while it keeps sending data', async () => {
    const download = vi.fn(async (_url: string, signal: AbortSignal) => ({
      body: trickleBody(signal, 10_000),
    }));
    const { manager, broker, generatedDirectory } = harness({ download });
    const started = await manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    broker.videoStatus.mockResolvedValueOnce(SUCCEEDED);

    await vi.advanceTimersByTimeAsync(10_000);
    await waitForState(manager, started.id, 'downloading');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await waitForState(manager, started.id, 'failed');

    expect(manager.status(started.id)?.error).toBe(
      'The video download took longer than five minutes.',
    );
    await vi.waitFor(() => expect(readdirSync(generatedDirectory)).toEqual([]));
  });

  it('cancels a video download in progress, stops the stream, and removes the partial file', async () => {
    const seen: { body?: Readable } = {};
    const download = vi.fn(async (_url: string, signal: AbortSignal) => {
      seen.body = stalledBody(signal);
      return { body: seen.body };
    });
    const { manager, broker, generatedDirectory } = harness({ download });
    const started = await manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    broker.videoStatus.mockResolvedValueOnce(SUCCEEDED);

    await vi.advanceTimersByTimeAsync(10_000);
    await waitForState(manager, started.id, 'downloading');
    await vi.waitFor(() => expect(readdirSync(generatedDirectory)).toHaveLength(1));

    const cancelled = await manager.cancel(started.id);

    expect(cancelled?.state).toBe('cancelled');
    expect(seen.body?.destroyed).toBe(true);
    await vi.waitFor(() => expect(readdirSync(generatedDirectory)).toEqual([]));
    expect(manager.status(started.id)?.state).toBe('cancelled');
    expect(broker.cancelVideo).not.toHaveBeenCalled();
  });

  it('fails with a plain message and deletes the temporary file when ffprobe is not installed', async () => {
    vi.stubEnv('PATH', '');
    try {
      const { manager, broker, generatedDirectory } = harness({
        probe: vi.fn(probeGeneratedMedia),
      });
      const started = await manager.start({
        profileId: PROFILE.id,
        kind: 'video',
        prompt: 'a slow pan',
      });
      broker.videoStatus.mockResolvedValueOnce(SUCCEEDED);

      await vi.advanceTimersByTimeAsync(10_000);
      await waitForState(manager, started.id, 'failed');

      expect(manager.status(started.id)?.error).toBe(
        'The media check tool is missing: ffprobe was not found.',
      );
      expect(readdirSync(generatedDirectory)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('stops a media check that is still running when cancel arrives and leaves no finished file', async () => {
    const probe = vi.fn(
      (_filePath: string, signal?: AbortSignal) =>
        new Promise<ProbedGeneratedMedia>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('media check aborted')), {
            once: true,
          });
        }),
    );
    const { manager, broker, generatedDirectory } = harness({ probe });
    const started = await manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    broker.videoStatus.mockResolvedValueOnce(SUCCEEDED);

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    const cancelled = await manager.cancel(started.id);

    expect(cancelled?.state).toBe('cancelled');
    await vi.waitFor(() => expect(readdirSync(generatedDirectory)).toEqual([]));
    expect(manager.status(started.id)?.filePath).toBeUndefined();
  });

  it('keeps polling through two failed status checks and fails on the third in a row', async () => {
    const { manager, broker } = harness();
    const started = await manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    broker.videoStatus
      .mockResolvedValueOnce({ ok: false, message: 'Provider busy.' })
      .mockRejectedValueOnce(new Error('Network reset.'));
    broker.videoStatus.mockResolvedValue({ ok: true, data: { status: 'running' } });

    await vi.advanceTimersByTimeAsync(30_000);
    await waitForState(manager, started.id, 'running');
    expect(manager.status(started.id)?.error).toBeUndefined();

    broker.videoStatus.mockResolvedValue({ ok: false, message: 'Provider busy.' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(manager.status(started.id)?.state).toBe('running');

    await vi.advanceTimersByTimeAsync(10_000);
    await waitForState(manager, started.id, 'failed');
    expect(manager.status(started.id)?.error).toBe('Provider busy.');
  });

  it('cancels the provider task when cancel arrives while the task is still being created', async () => {
    const { manager, broker } = harness();
    let resolveStart: (value: unknown) => void = () => undefined;
    broker.startVideo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    const starting = manager.start({ profileId: PROFILE.id, kind: 'video', prompt: 'a slow pan' });

    const cancelled = await manager.cancel('generation-1');
    expect(cancelled?.state).toBe('abandoned-locally');

    resolveStart({ ok: true, data: { taskId: 'task-late', route: 'current' } });
    await starting;

    expect(broker.cancelVideo).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-late', route: 'current' }),
    );
  });
});
