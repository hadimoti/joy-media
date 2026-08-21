import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BoundedLog,
  JsonFileWorkerStore,
  StaticLocalAssetSourceRegistry,
  WorkerRuntime,
  workerReceiptFromAiResult,
  detectMediaTools,
  getDeviceIdentity,
  localAssetSourcesFromEnvironment,
} from './runtime.js';
describe('Worker runtime', () => {
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
    expect(runtime.hello('win32', 'x64').capabilities).toEqual([
      'asset.thumbnail',
      'render.export',
    ]);
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

  it('runs audio.ml-denoise via ffmpeg arnndn when locally enabled', async () => {
    const previous = process.env.JOY_MEDIA_LOCAL_ML_DENOISE;
    const previousCommand = process.env.JOY_MEDIA_ML_DENOISE_CMD;
    const previousModel = process.env.JOY_MEDIA_RNNOISE_MODEL;
    process.env.JOY_MEDIA_LOCAL_ML_DENOISE = '1';
    const derivativeDirectory = mkdtempSync(join(tmpdir(), 'joy-media-ml-'));
    const helperScript = join(derivativeDirectory, 'copy-denoised-output.cjs');
    writeFileSync(
      helperScript,
      "require('node:fs').copyFileSync(process.argv[2], process.argv[3]);\n",
    );
    process.env.JOY_MEDIA_ML_DENOISE_CMD = `"${process.execPath}" "${helperScript}"`;
    delete process.env.JOY_MEDIA_RNNOISE_MODEL;
    const runtime = new WorkerRuntime(
      { workerId: 'worker-ml', createdAt: '2026-07-24T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: true, aiProviders: [] },
      { derivativeDirectory },
    );
    try {
      const result = await runtime.run(
        { id: 'job-ml', type: 'audio.ml-denoise' },
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
      if (previousCommand === undefined) delete process.env.JOY_MEDIA_ML_DENOISE_CMD;
      else process.env.JOY_MEDIA_ML_DENOISE_CMD = previousCommand;
      if (previousModel === undefined) delete process.env.JOY_MEDIA_RNNOISE_MODEL;
      else process.env.JOY_MEDIA_RNNOISE_MODEL = previousModel;
    }
  });

  it('advertises GPU capabilities only when local env is set', () => {
    const runtime = new WorkerRuntime(
      { workerId: 'w', createdAt: 'now' },
      { ffmpeg: true, ffprobe: true, comfy: true, mlDenoise: true, aiProviders: [] },
    );
    expect(runtime.hello('linux', 'x64').capabilities).toEqual([
      'asset.thumbnail',
      'render.export',
      'image.comfy',
      'audio.ml-denoise',
    ]);
  });

  it('fails image.comfy honestly until a non-fixture workflow is wired', async () => {
    const runtime = new WorkerRuntime(
      { workerId: 'worker-comfy', createdAt: '2026-08-21T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true, comfy: true, mlDenoise: false, aiProviders: [] },
    );

    await expect(
      runtime.run(
        { id: 'job-comfy', type: 'image.comfy' },
        { cancelled: () => false, progress: async () => undefined },
      ),
    ).rejects.toThrow(/COMFYUI_UNAVAILABLE/i);
  });

  it('maps AI provider results to protocol-compatible receipt kinds', () => {
    expect(
      workerReceiptFromAiResult(
        { id: 'job-text', type: 'text.lm-studio' },
        { kind: 'text', jobId: 'job-text', provider: 'lm-studio', text: 'hello', model: 'local' },
      ),
    ).toMatchObject({
      kind: 'text.lm-studio',
      resultRef: 'ai-job-text',
      model: 'local',
      bytes: 5,
    });
    expect(
      workerReceiptFromAiResult(
        { id: 'job-video', type: 'video.runway' },
        {
          kind: 'video',
          jobId: 'job-video',
          provider: 'runway',
          sha256: 'a'.repeat(64),
          bytes: 2048,
          localRef: 'ai-job-video-aaaaaaaaaaaaaaaa',
          descriptor: { mimeType: 'video/mp4' },
          model: 'gen4',
        },
      ),
    ).toMatchObject({
      kind: 'video.runway',
      assetId: 'ai-job-video',
      localRef: 'ai-job-video-aaaaaaaaaaaaaaaa',
      descriptor: { mimeType: 'video/mp4' },
    });
    expect(() =>
      workerReceiptFromAiResult(
        { id: 'job-video-image', type: 'video.runway' },
        {
          kind: 'image',
          jobId: 'job-video-image',
          provider: 'runway',
          sha256: 'b'.repeat(64),
          bytes: 512,
          localRef: 'ai-job-video-image-bbbbbbbbbbbbbbbb',
          descriptor: { mimeType: 'image/png', width: 512, height: 512 },
        },
      ),
    ).toThrow(/AI_OUTPUT_UNAVAILABLE/);
    expect(() =>
      workerReceiptFromAiResult(
        { id: 'job-edit-video', type: 'edit.higgsfield' },
        {
          kind: 'video',
          jobId: 'job-edit-video',
          provider: 'higgsfield',
          sha256: 'c'.repeat(64),
          bytes: 2048,
          localRef: 'ai-job-edit-video-cccccccccccccccc',
          descriptor: { mimeType: 'video/mp4' },
        },
      ),
    ).toThrow(/AI_OUTPUT_UNAVAILABLE/);
  });
});
