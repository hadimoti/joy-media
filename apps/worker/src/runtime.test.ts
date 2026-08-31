import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BoundedLog,
  JsonFileWorkerStore,
  StaticLocalAssetSourceRegistry,
  WorkerRuntime,
  WindowsDpapiSecretProtector,
  detectMediaTools,
  getDeviceIdentity,
  localAssetSourcesFromEnvironment,
} from './runtime.js';
import type { UnsupportedWorkerJobError } from './runtime.js';
import { ffmpegFilterPath, gpuDerivativeLocalRef, rnnoiseFilter } from './local-gpu.js';
describe('Worker runtime', () => {
  it.each(['text.openrouter', 'video.runway', 'edit.higgsfield'])(
    'fails closed before invoking provider job %s',
    async (type) => {
      const runtime = new WorkerRuntime(
        { workerId: 'provider-worker', createdAt: '2026-01-01T00:00:00.000Z' },
        {
          ffmpeg: false,
          ffprobe: false,
          comfy: false,
          mlDenoise: false,
          aiProviders: ['openrouter', 'runway', 'higgsfield'],
        },
      );

      await expect(
        runtime.run(
          { id: `job-${type}`, type, payload: { prompt: 'must not reach a provider' } },
          { cancelled: () => false, progress: async () => undefined },
        ),
      ).rejects.toMatchObject({
        name: 'UnsupportedWorkerJobError',
        code: 'JOB_TYPE_UNSUPPORTED',
        jobType: type,
      } satisfies Partial<UnsupportedWorkerJobError>);
    },
  );

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
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: false, aiProviders: [] },
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
      process.cwd(),
      'apps',
      'editor-web',
      'public',
      'media',
      'reference',
      'asset-intro.mp4',
    );
    const runtime = new WorkerRuntime(
      { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: false, aiProviders: [] },
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
      process.cwd(),
      'apps',
      'editor-web',
      'public',
      'media',
      'reference',
      'asset-intro.mp4',
    );
    const runtime = new WorkerRuntime(
      { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: false, aiProviders: [] },
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
      { ffmpeg: false, ffprobe: false, comfy: false, mlDenoise: false, aiProviders: [] },
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
  it('persists identity, Worker session, and a pending pairing separately from project data', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'joy-media-worker-')), 'state.json');
    const store = new JsonFileWorkerStore(path);
    const identity = getDeviceIdentity(store, new Date('2026-07-22T00:00:00.000Z'));
    store.saveWorkerSession('worker-session');
    store.savePendingPairing('pairing-code', Date.now() + 60_000);

    const restarted = new JsonFileWorkerStore(path);
    expect(restarted.load()).toEqual(identity);
    expect(restarted.loadWorkerSession()).toBe('worker-session');
    expect(restarted.loadPendingPairing()?.code).toBe('pairing-code');
    restarted.clearWorkerSession();
    expect(restarted.load()).toEqual(identity);
    expect(restarted.loadWorkerSession()).toBeUndefined();
    restarted.clearPendingPairing();
    expect(restarted.loadPendingPairing()).toBeUndefined();
  });

  it('stores Worker session and pending pairing through the configured secret protector', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'joy-media-worker-protected-')), 'state.json');
    const protector = {
      protect: (value: string) => Buffer.from(value).toString('base64url'),
      unprotect: (value: string) => Buffer.from(value, 'base64url').toString('utf8'),
    };
    const store = new JsonFileWorkerStore(path, { secretProtector: protector });
    store.save({ workerId: 'worker-protected', createdAt: '2026-07-22T00:00:00.000Z' });
    store.saveWorkerSession('worker-session-secret');
    store.savePendingPairing('pairing-code-secret', Date.now() + 60_000);
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('worker-session-secret');
    expect(raw).not.toContain('pairing-code-secret');
    const restarted = new JsonFileWorkerStore(path, { secretProtector: protector });
    expect(restarted.loadWorkerSession()).toBe('worker-session-secret');
    expect(restarted.loadPendingPairing()?.code).toBe('pairing-code-secret');
  });

  it('migrates legacy plaintext Worker secrets when protection is enabled', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'joy-media-worker-migrate-')), 'state.json');
    const legacy = new JsonFileWorkerStore(path);
    legacy.save({ workerId: 'worker-legacy', createdAt: '2026-07-22T00:00:00.000Z' });
    legacy.saveWorkerSession('legacy-session-secret');
    legacy.savePendingPairing('legacy-pairing-secret', Date.now() + 60_000);
    const protector = {
      protect: (value: string) => Buffer.from(value).toString('base64url'),
      unprotect: (value: string) => Buffer.from(value, 'base64url').toString('utf8'),
    };
    const protectedStore = new JsonFileWorkerStore(path, { secretProtector: protector });
    protectedStore.migrateLegacySecrets();
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('legacy-session-secret');
    expect(raw).not.toContain('legacy-pairing-secret');
    expect(protectedStore.loadWorkerSession()).toBe('legacy-session-secret');
    expect(protectedStore.loadPendingPairing()?.code).toBe('legacy-pairing-secret');
  });

  it('does not expose legacy plaintext secrets when configured protection cannot decrypt them', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'joy-media-worker-fail-closed-')), 'state.json');
    const legacy = new JsonFileWorkerStore(path);
    legacy.save({ workerId: 'worker-legacy', createdAt: '2026-07-22T00:00:00.000Z' });
    legacy.saveWorkerSession('legacy-session-secret');
    legacy.savePendingPairing('legacy-pairing-secret', Date.now() + 60_000);
    const protectedStore = new JsonFileWorkerStore(path, {
      secretProtector: { protect: () => 'ciphertext', unprotect: () => undefined },
    });

    expect(protectedStore.loadWorkerSession()).toBeUndefined();
    expect(protectedStore.loadPendingPairing()).toBeUndefined();
  });

  it('fails migration closed when a protected legacy read cannot be decoded', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'joy-media-worker-migrate-fail-')), 'state.json');
    writeFileSync(
      path,
      JSON.stringify({
        identity: { workerId: 'worker-legacy', createdAt: '2026-07-22T00:00:00.000Z' },
        sessionToken: 'legacy-session-secret',
        protectedSessionToken: 'unreadable-ciphertext',
      }),
    );
    const protectedStore = new JsonFileWorkerStore(path, {
      secretProtector: {
        protect: () => 'ciphertext',
        unprotect: () => {
          throw new Error('cannot decrypt');
        },
      },
    });

    expect(() => protectedStore.migrateLegacySecrets()).toThrow(
      'Unable to protect legacy Worker state',
    );
    expect(readFileSync(path, 'utf8')).toContain('legacy-session-secret');
  });

  it.runIf(process.platform === 'win32')(
    'preserves exact Windows DPAPI-protected secret values',
    () => {
      const protector = new WindowsDpapiSecretProtector();
      const value = '  worker-secret with spaces  \n';
      const encrypted = protector.protect(value);
      expect(protector.unprotect(encrypted)).toBe(value);
    },
  );

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
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: true, aiProviders: [] },
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
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: true, aiProviders: [] },
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
      { ffmpeg: true, ffprobe: true, comfy: true, mlDenoise: true, aiProviders: [] },
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
