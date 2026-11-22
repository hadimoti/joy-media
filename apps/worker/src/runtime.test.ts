import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type * as nodeFs from 'node:fs';
import { createHash } from 'node:crypto';
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
import type { RealThumbnailReceipt, UnsupportedWorkerJobError } from './runtime.js';
import type { SpeechAvailability, SpeechModelRunner } from './local-speech.js';
import { ffmpegFilterPath, gpuDerivativeLocalRef, rnnoiseFilter } from './local-gpu.js';
import { renderFixture } from '@joy-media/export-core';

// Counts reads of the legacy provider file, which the Worker must never open. Every call passes through unchanged.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

// Independent of `process.cwd()` (which is `apps/worker` under `pnpm --filter @joy-media/worker
// test`, not the repo root) so this fixture resolves the same way from any invocation.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
describe('Worker runtime', () => {
  const originalJoyMediaHome = process.env.JOY_MEDIA_HOME;
  let isolatedJoyMediaHome = '';

  beforeEach(() => {
    isolatedJoyMediaHome = mkdtempSync(join(tmpdir(), 'joy-worker-home-'));
    process.env.JOY_MEDIA_HOME = isolatedJoyMediaHome;
  });

  afterEach(() => {
    if (originalJoyMediaHome === undefined) delete process.env.JOY_MEDIA_HOME;
    else process.env.JOY_MEDIA_HOME = originalJoyMediaHome;
    rmSync(isolatedJoyMediaHome, { recursive: true, force: true });
  });

  it('uses JOY_MEDIA_HOME for default state and derivative paths', () => {
    const identity = { workerId: 'home-worker', createdAt: '2026-01-01T00:00:00.000Z' };
    new JsonFileWorkerStore().save(identity);
    expect(existsSync(join(isolatedJoyMediaHome, 'worker-state.json'))).toBe(true);

    const derivativeDirectory = join(isolatedJoyMediaHome, 'derivatives');
    const localRef = 'thumb-home-worker';
    const bytes = Buffer.from('test thumbnail bytes');
    mkdirSync(derivativeDirectory, { recursive: true });
    writeFileSync(join(derivativeDirectory, `${localRef}.jpg`), bytes);
    const receipt: RealThumbnailReceipt = {
      kind: 'asset.thumbnail',
      assetId: 'asset-home-worker',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      localRef,
      descriptor: { mimeType: 'image/jpeg', width: 1, height: 1 },
    };
    const runtime = new WorkerRuntime(identity, {
      ffmpeg: false,
      ffprobe: false,
      comfy: false,
      mlDenoise: false,
      aiBroker: false,
    });

    expect(runtime.readDerivative(receipt)).toEqual(bytes);
  });

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
      { downloadJobAsset: async () => undefined },
    );
    const capabilities = runtime.hello('win32', 'x64').capabilities;
    expect(capabilities).not.toContain('video.runway');
    expect(capabilities).not.toContain('edit.higgsfield');
    expect(capabilities).toContain('render.export');
    expect(capabilities).toContain('asset.thumbnail');
  });

  it('advertises GPU preview only while the local GPU preview host exists', () => {
    const identity = { workerId: 'gpu-preview-worker', createdAt: '2026-01-01T00:00:00.000Z' };
    const withHost = new WorkerRuntime(
      identity,
      detectMediaTools(() => false),
      {
        gpuPreviewAvailable: true,
      },
    );
    const withoutHost = new WorkerRuntime(
      identity,
      detectMediaTools(() => false),
      {
        gpuPreviewAvailable: false,
      },
    );
    expect(withHost.hello('win32', 'x64').capabilities).toContain('render.preview.gpu');
    expect(withoutHost.hello('win32', 'x64').capabilities).not.toContain('render.preview.gpu');
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
    expect(runtime.hello('win32', 'x64').capabilities).toEqual(['asset.thumbnail', 'media.qc']);
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
          // asset-intro.mp4 is 1080x1920 (9:16, regenerated in T-R01), so scale=640:-2 gives 640x1138.
          descriptor: { mimeType: 'image/jpeg', width: 640, height: 1138 },
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

  it('returns canceled, not completed, when a cancel lands after the export is encoded', async () => {
    const derivativeDirectory = mkdtempSync(join(tmpdir(), 'joy-media-late-cancel-'));
    const stagingDirectory = mkdtempSync(join(tmpdir(), 'joy-media-late-cancel-stage-'));
    const stagedSource = join(stagingDirectory, 'staged.mp4');
    const manifest = {
      projectId: 'project-late-cancel',
      revision: 1,
      width: 64,
      height: 36,
      frameRate: 30,
      durationUs: 100_000,
      preset: 'social-h264-aac',
    } as const;
    renderFixture(manifest, stagedSource);
    const runtime = new WorkerRuntime(
      { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: false, aiBroker: false },
      {
        derivativeDirectory,
        downloadJobAsset: async (_jobId, _leaseToken, destinationPath) => {
          copyFileSync(stagedSource, destinationPath);
        },
      },
    );
    // The export payload is typed loosely on the runtime job, so it is cast once here.
    const job = {
      id: 'job-late-cancel',
      type: 'render.export',
      assetId: 'asset-export',
      payload: {
        schemaVersion: 1,
        producer: 'browser-staged-preview-export',
        frameCount: 3,
        manifest,
      },
    } as unknown as Parameters<WorkerRuntime['run']>[0];
    let canceled = false;
    try {
      const result = await runtime.run(job, {
        cancelled: () => canceled,
        // Progress 80 is reported right after FFmpeg returns, before hashing and staging.
        progress: async (progress) => {
          if (progress === 80) canceled = true;
        },
      });
      expect(result).toEqual({ state: 'canceled' });
      expect(readdirSync(derivativeDirectory)).toEqual([]);
    } finally {
      rmSync(derivativeDirectory, { recursive: true, force: true });
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  }, 30_000);

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

  it('advertises media.qc only with FFmpeg and FFprobe, and refuses it without them or an asset', async () => {
    const identity = { workerId: 'worker-qc', createdAt: '2026-11-14T00:00:00.000Z' };
    const without = new WorkerRuntime(identity, {
      ffmpeg: true,
      ffprobe: false,
      comfy: false,
      mlDenoise: false,
      aiBroker: false,
    });
    expect(without.hello('win32', 'x64').capabilities).not.toContain('media.qc');
    await expect(
      without.run(
        { id: 'job-qc-1', type: 'media.qc', assetId: 'asset-1' },
        { cancelled: () => false, progress: async () => undefined },
      ),
    ).rejects.toThrow('FFmpeg and FFprobe are required for media.qc');

    const withTools = new WorkerRuntime(identity, {
      ffmpeg: true,
      ffprobe: true,
      comfy: false,
      mlDenoise: false,
      aiBroker: false,
    });
    expect(withTools.hello('win32', 'x64').capabilities).toContain('media.qc');
    await expect(
      withTools.run(
        { id: 'job-qc-2', type: 'media.qc' },
        { cancelled: () => false, progress: async () => undefined },
      ),
    ).rejects.toThrow('media.qc requires an input asset');
    await expect(
      withTools.run(
        { id: 'job-qc-3', type: 'media.qc', assetId: 'asset-1' },
        { cancelled: () => false, progress: async () => undefined },
      ),
    ).rejects.toThrow('asset asset-1 is not available on this Worker');
  });

  it('advertises only configured ready speech models and reads a verified speech derivative', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-worker-speech-'));
    const runner: SpeechModelRunner = {
      runner: { command: process.execPath, prefixArgs: [] },
      modelPath: root,
      scriptPath: join(root, 'runner.py'),
    };
    const speech: SpeechAvailability = {
      transcribe: runner,
      synthesis: { 'kokoro-82m': runner, 'chatterbox-fa': runner },
    };
    const runtime = new WorkerRuntime(
      { workerId: 'speech-worker', createdAt: '2026-11-22T00:00:00.000Z' },
      { ffmpeg: false, ffprobe: false, comfy: false, mlDenoise: false, aiBroker: false, speech },
      { derivativeDirectory: root },
    );
    try {
      const capabilities = runtime.hello('win32', 'x64').capabilities;
      expect(capabilities).toContain('speech.transcribe');
      expect(capabilities).toContain('speech.synthesize');
      expect(capabilities).toContain('speech.model.kokoro-82m');
      expect(capabilities).toContain('speech.model.chatterbox-fa');
      const bytes = Buffer.from('{"transcript":true}');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const localRef = `speech-job-${sha256.slice(0, 16)}`;
      writeFileSync(join(root, `${localRef}.json`), bytes);
      expect(
        runtime.readDerivative({
          kind: 'speech.transcribe',
          sha256,
          bytes: bytes.length,
          localRef,
          descriptor: { mimeType: 'application/json' },
        }),
      ).toEqual(bytes);
      expect(() =>
        runtime.readDerivative({
          kind: 'speech.transcribe',
          sha256: '0'.repeat(64),
          bytes: bytes.length,
          localRef,
          descriptor: { mimeType: 'application/json' },
        }),
      ).toThrow('integrity check failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the desktop-validated consent envelope and skips source reads for built-in synthesis', async () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-worker-speech-consent-'));
    const runner: SpeechModelRunner = {
      runner: { command: process.execPath, prefixArgs: ['-e', 'process.exit(1)'] },
      modelPath: root,
      scriptPath: join(root, 'runner.py'),
    };
    const downloadJobAsset = vi.fn(async () => {
      throw new Error('built-in synthesis must not read a source');
    });
    const runtime = new WorkerRuntime(
      { workerId: 'speech-consent-worker', createdAt: '2026-11-22T00:00:00.000Z' },
      {
        ffmpeg: false,
        ffprobe: false,
        comfy: false,
        mlDenoise: false,
        aiBroker: false,
        speech: { synthesis: { 'kokoro-82m': runner } },
      },
      { derivativeDirectory: root, downloadJobAsset },
    );
    const base = {
      id: 'speech-consent',
      type: 'speech.synthesize',
      assetId: 'speech-output',
      leaseToken: 'lease-speech-consent',
      payload: {
        schemaVersion: 1,
        language: 'en-US',
        modelId: 'kokoro-82m',
        text: 'Hello',
        purpose: 'general',
      },
    } as const;
    const options = { cancelled: () => false, progress: async () => undefined };
    await expect(runtime.run(base, options)).rejects.toThrow(
      'Speech synthesis consent is required',
    );
    let acceptedError: unknown;
    try {
      await runtime.run(
        {
          ...base,
          payload: {
            ...base.payload,
            worker: { consent: { acknowledged: true, purpose: 'general' } },
          },
        },
        options,
      );
    } catch (error) {
      acceptedError = error;
    }
    expect(acceptedError).toBeInstanceOf(Error);
    expect((acceptedError as Error).message).not.toContain('consent');
    expect(downloadJobAsset).not.toHaveBeenCalled();
    rmSync(root, { recursive: true, force: true });
  });

  it('asks the desktop for a mask job source that is not in its own registry, before the runner starts', async () => {
    const staged: string[] = [];
    const runtime = new WorkerRuntime(
      { workerId: 'worker-mask', createdAt: '2026-11-22T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: false, aiBroker: false },
      {
        downloadJobAsset: async (jobId, leaseToken, destinationPath) => {
          staged.push(`${jobId}:${leaseToken}`);
          writeFileSync(destinationPath, Buffer.from('source'));
        },
      },
    );
    // Reach the private tools bag so the runner is a command that fails at once.
    (runtime as unknown as { tools: Record<string, unknown> }).tools['masking'] = {
      image: { command: process.execPath, prefixArgs: ['-e', 'process.exit(3)'] },
    };
    const job = {
      id: 'job-mask-1',
      type: 'mask.image',
      assetId: 'asset-1',
      leaseToken: 'lease-1',
      payload: { mode: 'subject' },
    } as unknown as Parameters<WorkerRuntime['run']>[0];
    await expect(
      runtime.run(job, { cancelled: () => false, progress: async () => undefined }),
    ).rejects.toThrow();
    expect(staged).toEqual(['job-mask-1:lease-1']);
  }, 30_000);

  it('cancels a media.qc job before it runs anything', async () => {
    const runtime = new WorkerRuntime(
      { workerId: 'worker-qc-cancel', createdAt: '2026-11-14T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: false, aiBroker: false },
      { sources: new StaticLocalAssetSourceRegistry({ 'asset-1': 'unused-source.mp4' }) },
    );
    await expect(
      runtime.run(
        { id: 'job-qc-4', type: 'media.qc', assetId: 'asset-1' },
        { cancelled: () => true, progress: async () => undefined },
      ),
    ).resolves.toEqual({ state: 'canceled' });
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
        'media.qc',
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
