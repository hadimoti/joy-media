import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BoundedLog,
  JsonFileWorkerStore,
  StaticLocalAssetSourceRegistry,
  WorkerRuntime,
  detectMediaTools,
  getDeviceIdentity,
  localAssetSourcesFromEnvironment,
} from './runtime.js';
import type { UnsupportedWorkerJobError } from './runtime.js';
import { ffmpegFilterPath, gpuDerivativeLocalRef, rnnoiseFilter } from './local-gpu.js';

// Counts reads of the legacy provider file, which the Worker must never open. Every call passes through unchanged.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

// Independent of `process.cwd()` (which is `apps/worker` under `pnpm --filter @joy-media/worker
// test`, not the repo root) so this fixture resolves the same way from any invocation.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
describe('Worker runtime', () => {
  it('fails closed before invoking the unsupported OpenRouter text job', async () => {
    const runtime = new WorkerRuntime(
      { workerId: 'provider-worker', createdAt: '2026-01-01T00:00:00.000Z' },
      { ffmpeg: false, ffprobe: false, comfy: false, mlDenoise: false, aiBroker: true },
    );

    await expect(
      runtime.run(
        {
          id: 'job-text.openrouter',
          type: 'text.openrouter',
          payload: { prompt: 'must not reach a provider' },
        },
        { cancelled: () => false, progress: async () => undefined },
      ),
    ).rejects.toMatchObject({
      name: 'UnsupportedWorkerJobError',
      code: 'JOB_TYPE_UNSUPPORTED',
      jobType: 'text.openrouter',
    } satisfies Partial<UnsupportedWorkerJobError>);
  });

  it.each(['video.runway', 'edit.higgsfield'])(
    'refuses the retired AI video job type %s as an unknown type',
    async (type) => {
      const runtime = new WorkerRuntime(
        { workerId: 'provider-worker', createdAt: '2026-01-01T00:00:00.000Z' },
        { ffmpeg: false, ffprobe: false, comfy: false, mlDenoise: false, aiBroker: true },
      );

      await expect(
        runtime.run(
          { id: `job-${type}`, type, payload: { prompt: 'must not reach a provider' } },
          { cancelled: () => false, progress: async () => undefined },
        ),
      ).rejects.toThrow(`unsupported Worker job ${type}`);
    },
  );

  it('advertises no retired AI video capability and keeps the core render export', () => {
    const runtime = new WorkerRuntime(
      { workerId: 'provider-worker', createdAt: '2026-01-01T00:00:00.000Z' },
      detectMediaTools(() => true, { aiBroker: true }),
      { downloadJobAsset: async () => new Uint8Array() },
    );
    const capabilities = runtime.hello('win32', 'x64').capabilities;
    expect(capabilities).not.toContain('video.runway');
    expect(capabilities).not.toContain('edit.higgsfield');
    expect(capabilities).toContain('render.export');
    expect(capabilities).toContain('asset.thumbnail');
  });

  it('escapes a Windows RNNoise path for ffmpeg filter syntax', () => {
    const path = 'C:\\Users\\JOY Media\\models\\rnnoise\\mp.rnnn';
    expect(ffmpegFilterPath(path)).toBe("'C\\:/Users/JOY Media/models/rnnoise/mp.rnnn'");
    expect(rnnoiseFilter(path)).toBe("arnndn=m='C\\:/Users/JOY Media/models/rnnoise/mp.rnnn'");
  });

  it('bounds retained GPU references for project-scoped job IDs', () => {
    const jobId = `audio-denoise-${'project'.repeat(12)}-${'asset'.repeat(20)}`;
    const localRef = gpuDerivativeLocalRef(jobId, 'a'.repeat(64));
    expect(localRef).toMatch(/^gpu-[a-f0-9]{32}-[a-f0-9]{16}$/);
    expect(localRef.slice('gpu-'.length).length).toBeLessThanOrEqual(110);
  });

  it('persists device identity and advertises only detected capabilities', () => {
    let saved: ReturnType<typeof getDeviceIdentity> | undefined;
    const store = {
      load: () => saved,
      save: (value: ReturnType<typeof getDeviceIdentity>) => {
        saved = value;
      },
    };
    const first = getDeviceIdentity(store, new Date('2026-01-01'));
    expect(getDeviceIdentity(store)).toEqual(first);
    const runtime = new WorkerRuntime(
      first,
      detectMediaTools((tool) => tool === 'ffmpeg' || tool === 'ffprobe'),
    );
    expect(runtime.hello('win32', 'x64').capabilities).toEqual(['asset.thumbnail']);
  });
  it('bounds logs and cooperatively cancels jobs', async () => {
    const log = new BoundedLog(2);
    log.write('a');
    log.write('b');
    log.write('c');
    expect(log.lines()).toEqual(['b', 'c']);
    const runtime = new WorkerRuntime(
      { workerId: 'w', createdAt: 'now' },
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: false, aiBroker: false },
    );
    expect(
      (
        await runtime.run(
          { id: 'j', type: 'asset.thumbnail', assetId: 'asset-1' },
          { cancelled: () => true, progress: async () => undefined },
        )
      ).state,
    ).toBe('canceled');
  });
  it('creates a real bounded JPEG thumbnail and retains only an opaque local reference', async () => {
    const derivativeDirectory = mkdtempSync(join(tmpdir(), 'joy-media-derivatives-'));
    const source = join(
      repoRoot,
      'apps',
      'editor-web',
      'public',
      'media',
      'reference',
      'asset-intro.mp4',
    );
    const runtime = new WorkerRuntime(
      { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: false, aiBroker: false },
      {
        sources: new StaticLocalAssetSourceRegistry({ 'asset-intro': source }),
        derivativeDirectory,
      },
    );
    try {
      const updates: number[] = [];
      const result = await runtime.run(
        { id: 'job-real', type: 'asset.thumbnail', assetId: 'asset-intro' },
        {
          cancelled: () => false,
          progress: async (progress) => {
            updates.push(progress);
          },
        },
      );
      expect(result).toMatchObject({
        state: 'completed',
        result: {
          kind: 'asset.thumbnail',
          assetId: 'asset-intro',
          descriptor: { mimeType: 'image/jpeg', width: 640, height: 360 },
        },
      });
      if (result.state !== 'completed') throw new Error('real thumbnail was unexpectedly canceled');
      if (result.result.kind !== 'asset.thumbnail')
        throw new Error('real thumbnail returned the wrong receipt kind');
      expect(result.result.bytes).toBeGreaterThan(100);
      expect(result.result.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.result.localRef).toMatch(/^thumb-job-real-[a-f0-9]{16}$/);
      expect(existsSync(join(derivativeDirectory, `${result.result.localRef}.jpg`))).toBe(true);
      expect(JSON.stringify(result)).not.toContain(source);
      expect(updates).toEqual([5, 25, 75, 90, 100]);
    } finally {
      rmSync(derivativeDirectory, { recursive: true, force: true });
    }
  });
  it('cancels an in-flight real thumbnail and leaves no derivative behind', async () => {
    const derivativeDirectory = mkdtempSync(join(tmpdir(), 'joy-media-canceled-'));
    const source = join(
      repoRoot,
      'apps',
      'editor-web',
      'public',
      'media',
      'reference',
      'asset-intro.mp4',
    );
    const runtime = new WorkerRuntime(
      { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: false, aiBroker: false },
      {
        sources: new StaticLocalAssetSourceRegistry({ 'asset-intro': source }),
        derivativeDirectory,
      },
    );
    let canceled = false;
    try {
      await expect(
        runtime.run(
          { id: 'job-canceled', type: 'asset.thumbnail', assetId: 'asset-intro' },
          {
            cancelled: () => canceled,
            progress: async (progress) => {
              if (progress === 25) canceled = true;
            },
          },
        ),
      ).resolves.toEqual({ state: 'canceled' });
      expect(existsSync(derivativeDirectory)).toBe(true);
      expect(readdirSync(derivativeDirectory)).toEqual([]);
    } finally {
      rmSync(derivativeDirectory, { recursive: true, force: true });
    }
  });

  it('runs the Jobs-panel fixture thumbnail without FFmpeg or a local asset', async () => {
    const runtime = new WorkerRuntime(
      { workerId: 'worker-fixture', createdAt: '2026-08-16T00:00:00.000Z' },
      { ffmpeg: false, ffprobe: false, comfy: false, mlDenoise: false, aiBroker: false },
    );
    const updates: number[] = [];
    const result = await runtime.run(
      { id: 'job-fixture', type: 'fixture.thumbnail' },
      {
        cancelled: () => false,
        progress: async (progress) => {
          updates.push(progress);
        },
      },
    );
    expect(result).toEqual({
      state: 'completed',
      result: {
        kind: 'fixture.thumbnail',
        sha256: '78bf4c43aa7ab3a14c9f1e34f3333f9f612a08191affba3fb9c3e6de88378735',
        bytes: 14,
      },
    });
    expect(updates).toEqual([5, 50, 90, 100]);
  });
  it('keeps the Worker identity and carries older pairing fields over without reading them', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'joy-media-worker-')), 'state.json');
    writeFileSync(
      path,
      JSON.stringify({
        sessionToken: 'older-session',
        pendingPairing: { code: 'older-code', expiresAt: Date.now() + 60_000 },
      }),
    );
    const store = new JsonFileWorkerStore(path);
    const identity = getDeviceIdentity(store, new Date('2026-07-22T00:00:00.000Z'));

    const restarted = new JsonFileWorkerStore(path);
    expect(restarted.load()).toEqual(identity);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      identity,
      sessionToken: 'older-session',
      pendingPairing: { code: 'older-code' },
    });
  });

  it('treats a malformed or missing state file as having no identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-media-worker-malformed-'));
    const path = join(dir, 'state.json');
    writeFileSync(path, '{ not json');
    expect(new JsonFileWorkerStore(path).load()).toBeUndefined();
    expect(new JsonFileWorkerStore(join(dir, 'missing.json')).load()).toBeUndefined();
  });

  it('keeps source paths local while advertising configured opaque IDs only', () => {
    const registry = localAssetSourcesFromEnvironment(
      JSON.stringify({ 'asset-campaign': 'D:\\private\\campaign.mp4' }),
      (sourcePath) => sourcePath === 'D:\\private\\campaign.mp4',
    );
    expect(registry?.assetIds()).toEqual(['asset-campaign']);
    expect(registry?.resolve('asset-campaign')).toBe('D:\\private\\campaign.mp4');
    expect(() => localAssetSourcesFromEnvironment('{"bad/id":"x"}', () => true)).toThrow(
      'invalid asset ID',
    );
    expect(() => localAssetSourcesFromEnvironment('{"asset-a":"x"}', () => false)).toThrow(
      'asset-a',
    );
  });

  it.runIf(
    existsSync(
      process.env.JOY_MEDIA_RNNOISE_MODEL?.trim() || '/opt/joy-media/data/rnnoise/cb.rnnn',
    ),
  )('runs audio.ml-denoise via ffmpeg arnndn when the licensed model is provisioned', async () => {
    const previous = process.env.JOY_MEDIA_LOCAL_ML_DENOISE;
    const previousModel = process.env.JOY_MEDIA_RNNOISE_MODEL;
    process.env.JOY_MEDIA_LOCAL_ML_DENOISE = '1';
    process.env.JOY_MEDIA_RNNOISE_MODEL = '/opt/joy-media/data/rnnoise/cb.rnnn';
    const derivativeDirectory = mkdtempSync(join(tmpdir(), 'joy-media-ml-'));
    const runtime = new WorkerRuntime(
      { workerId: 'worker-ml', createdAt: '2026-07-24T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: true, aiBroker: false },
      { derivativeDirectory },
    );
    try {
      const result = await runtime.run(
        { id: 'job-ml', type: 'audio.ml-denoise', payload: { fixture: true } },
        { cancelled: () => false, progress: async () => undefined },
      );
      expect(result.state).toBe('completed');
      if (result.state !== 'completed') return;
      expect(result.result.kind).toBe('audio.ml-denoise');
      if (result.result.kind !== 'audio.ml-denoise')
        throw new Error('expected the denoised audio receipt');
      expect(result.result.bytes).toBeGreaterThan(100);
      expect(runtime.readDerivative(result.result).byteLength).toBe(result.result.bytes);
    } finally {
      rmSync(derivativeDirectory, { recursive: true, force: true });
      if (previous === undefined) delete process.env.JOY_MEDIA_LOCAL_ML_DENOISE;
      else process.env.JOY_MEDIA_LOCAL_ML_DENOISE = previous;
      if (previousModel === undefined) delete process.env.JOY_MEDIA_RNNOISE_MODEL;
      else process.env.JOY_MEDIA_RNNOISE_MODEL = previousModel;
    }
  });

  it('fails closed instead of synthesizing audio when a selected source is unavailable', async () => {
    const runtime = new WorkerRuntime(
      { workerId: 'worker-audio-source', createdAt: '2026-07-24T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: true, aiBroker: false },
    );
    await expect(
      runtime.run(
        { id: 'job-missing-source', type: 'audio.ml-denoise', assetId: 'asset-private' },
        { cancelled: () => false, progress: async () => undefined },
      ),
    ).rejects.toThrow('local source unavailable');
  });

  it('advertises GPU capabilities only when local env is set', () => {
    const previous = process.env.JOY_MEDIA_LOCAL_ML_DENOISE;
    const previousModel = process.env.JOY_MEDIA_RNNOISE_MODEL;
    delete process.env.JOY_MEDIA_LOCAL_ML_DENOISE;
    delete process.env.JOY_MEDIA_RNNOISE_MODEL;
    const runtime = new WorkerRuntime(
      { workerId: 'w', createdAt: 'now' },
      { ffmpeg: true, ffprobe: true, comfy: true, mlDenoise: true, aiBroker: false },
    );
    try {
      expect(runtime.hello('linux', 'x64').capabilities).toEqual([
        'asset.thumbnail',
        'image.comfy',
      ]);
    } finally {
      if (previous === undefined) delete process.env.JOY_MEDIA_LOCAL_ML_DENOISE;
      else process.env.JOY_MEDIA_LOCAL_ML_DENOISE = previous;
      if (previousModel === undefined) delete process.env.JOY_MEDIA_RNNOISE_MODEL;
      else process.env.JOY_MEDIA_RNNOISE_MODEL = previousModel;
    }
  });
});

describe('Worker AI text jobs through the desktop broker', () => {
  const identity = { workerId: 'broker-worker', createdAt: '2026-01-01T00:00:00.000Z' };
  const progress = async () => undefined;

  beforeEach(() => {
    vi.mocked(readFileSync).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('advertises the LM Studio text capability only when the desktop broker is available', () => {
    const withBroker = new WorkerRuntime(
      identity,
      detectMediaTools(() => false, { aiBroker: true }),
    );
    const withoutBroker = new WorkerRuntime(
      identity,
      detectMediaTools(() => false),
    );
    expect(withBroker.hello('win32', 'x64').capabilities).toContain('text.lm-studio');
    expect(withoutBroker.hello('win32', 'x64').capabilities).not.toContain('text.lm-studio');
  });

  it('sends the prompt through the broker and returns only the reply text', async () => {
    const calls: Array<{ jobId: string; leaseToken: string; input: unknown }> = [];
    const worker = new WorkerRuntime(
      identity,
      detectMediaTools(() => false, { aiBroker: true }),
      {
        completeAi: async (jobId, leaseToken, input) => {
          calls.push({ jobId, leaseToken, input });
          return 'reply from the desktop';
        },
      },
    );

    const outcome = await worker.run(
      {
        id: 'job-text-1',
        type: 'text.lm-studio',
        leaseToken: 'lease-1',
        payload: { prompt: 'hi', model: 'chosen-by-the-desktop' },
      },
      { cancelled: () => false, progress },
    );

    expect(outcome).toEqual({
      state: 'completed',
      result: {
        kind: 'text',
        jobId: 'job-text-1',
        provider: 'lm-studio',
        text: 'reply from the desktop',
      },
    });
    expect(calls).toEqual([
      {
        jobId: 'job-text-1',
        leaseToken: 'lease-1',
        input: { messages: [{ role: 'user', content: 'hi' }] },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain('chosen-by-the-desktop');
  });

  it('refuses an AI text job without the broker before any request is sent', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const worker = new WorkerRuntime(
      identity,
      detectMediaTools(() => false),
    );

    await expect(
      worker.run(
        {
          id: 'job-no-broker',
          type: 'text.lm-studio',
          leaseToken: 'lease-2',
          payload: { prompt: 'hi' },
        },
        { cancelled: () => false, progress },
      ),
    ).rejects.toThrow('AI text jobs need the desktop app broker on this Worker');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never reads the legacy provider file', async () => {
    const worker = new WorkerRuntime(
      identity,
      detectMediaTools(() => false, { aiBroker: true }),
      {
        completeAi: async () => 'ok',
      },
    );

    await worker.run(
      {
        id: 'job-no-file',
        type: 'text.lm-studio',
        leaseToken: 'lease-3',
        payload: { prompt: 'hi' },
      },
      { cancelled: () => false, progress },
    );

    const providerFileReads = vi
      .mocked(readFileSync)
      .mock.calls.filter(([path]) => String(path).endsWith('ai-providers.json'));
    expect(providerFileReads).toEqual([]);
  });
});
