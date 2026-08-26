import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
import { deliveryPromiseForManifest } from '@joy-media/export-core';
import {
  createRenderBundleV2,
  createCompositionPlanV2,
} from '../../../packages/render-planner/src/v2.js';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
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
      'media.semantic-index',
      'asset.thumbnail',
      'render.export',
      'render.inspect',
      'video.reference-analyze',
    ]);
  });

  it('inspects a concrete retained export through the approved resolver and returns a typed report', async () => {
    const source = join(
      process.cwd(),
      'apps',
      'editor-web',
      'public',
      'media',
      'reference',
      'asset-intro.mp4',
    );
    const bytes = readFileSync(source);
    const runtime = new WorkerRuntime(
      { workerId: 'worker-inspect', createdAt: '2026-07-22T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: false, aiProviders: [] },
      {
        renderArtifactResolver: async ({ artifactId, outputRef }) => {
          expect(artifactId).toBe('artifact-export-aaaaaaaaaaaaaaaa');
          expect(outputRef).toBe('render-export-aaaaaaaaaaaaaaaa');
          return bytes;
        },
      },
    );
    const result = await runtime.run(
      {
        id: 'inspect-job',
        type: 'render.inspect',
        payload: {
          projectRef: 'project-p',
          compositionId: 'composition-root',
          presetId: 'preset-default',
          reportRef: 'report-inspect-job',
          artifactId: 'artifact-export-aaaaaaaaaaaaaaaa',
          outputRef: 'render-export-aaaaaaaaaaaaaaaa',
          promise: deliveryPromiseForManifest({
            projectId: 'p',
            revision: 0,
            width: 640,
            height: 360,
            frameRate: 30,
            durationUs: 1_000_000,
            preset: 'social-h264-aac',
          }),
          mode: 'sampled',
        },
      },
      { cancelled: () => false, progress: async () => undefined },
    );
    expect(result.state).toBe('completed');
    if (result.state !== 'completed') return;
    if (result.result.kind !== 'render.inspect') return;
    expect(result.result.report).toBeDefined();
    expect(result.result.kind).toBe('render.inspect');
    expect(result.result.outputRef).toBe('render-export-aaaaaaaaaaaaaaaa');
    expect(result.result.report?.artifact?.outputRef).toBe(result.result.outputRef);
    expect(result.result.report?.evidenceLevel).toBe('sampled');
  });

  it('exports, retains, and inspects signed LTR+Persian RTL captions with retry recovery', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-worker-caption-contract-'));
    const source = join(directory, 'source.mp4');
    const generated = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        "nullsrc=size=64x36:rate=24,geq=lum='35+mod(X+Y+N,20)':cb=128:cr=128",
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-shortest',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        source,
      ],
      { encoding: 'utf8' },
    );
    if (generated.status !== 0)
      throw new Error(generated.stderr || 'unable to create caption fixture');
    const videoBytes = readFileSync(source);
    const captionBundle = captionBundleV2(videoBytes);
    const sourceOnlyBundle = captionBundleV2(videoBytes, false);
    const retained = new Map<string, Uint8Array>();
    const runtime = new WorkerRuntime(
      { workerId: 'worker-caption', createdAt: '2026-08-26T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: false, aiProviders: [] },
      {
        derivativeDirectory: directory,
        sources: new StaticLocalAssetSourceRegistry({ video: source }),
        renderArtifactResolver: async ({ outputRef }) => {
          const bytes = retained.get(outputRef);
          if (bytes === undefined) throw new Error('retained artifact is missing');
          return bytes;
        },
      },
    );
    const exportAndInspect = async (
      jobId: string,
      bundle: ReturnType<typeof captionBundleV2>,
      promise: ReturnType<typeof captionPromise>,
    ) => {
      const exported = await runtime.run(
        {
          id: jobId,
          type: 'render.export',
          payload: {
            projectRef: 'project-caption',
            compositionId: 'root',
            presetId: 'preview',
            reportRef: `report-${jobId}`,
            bundle,
          },
        },
        { cancelled: () => false, progress: async () => undefined },
      );
      expect(exported.state).toBe('completed');
      if (exported.state !== 'completed' || exported.result.kind !== 'render.export')
        throw new Error('caption export did not complete');
      const artifact = readFileSync(join(directory, `${jobId}.mp4`));
      retained.set(exported.result.outputRef, artifact);
      const inspected = await runtime.run(
        {
          id: `${jobId}-inspect`,
          type: 'render.inspect',
          payload: {
            projectRef: 'project-caption',
            compositionId: 'root',
            presetId: 'preview',
            reportRef: `report-${jobId}-inspect`,
            artifactId: `artifact-${jobId}`,
            outputRef: exported.result.outputRef,
            promise,
            mode: 'sampled',
          },
        },
        { cancelled: () => false, progress: async () => undefined },
      );
      expect(inspected.state).toBe('completed');
      if (inspected.state !== 'completed' || inspected.result.kind !== 'render.inspect')
        throw new Error('caption inspection did not complete');
      return inspected.result.report!;
    };
    try {
      const promise = captionPromise(captionBundle);
      const positive = await exportAndInspect('caption-export', captionBundle, promise);
      expect(positive.findings.filter((finding) => finding.status === 'fail')).toEqual([]);
      expect(positive.findings.find((finding) => finding.code === 'caption-pixels')?.status).toBe(
        'pass',
      );
      expect(positive.facts.video?.frameRate).toBeCloseTo(24, 2);
      expect(promise.captions.burnIn?.segments).toEqual(
        captionBundle.plan.captionBurnIn?.segments.map(({ startUs, endUs, text, direction }) => ({
          startUs,
          endUs,
          text,
          direction,
        })),
      );

      const missing = await exportAndInspect('caption-missing', sourceOnlyBundle, promise);
      expect(missing.findings.find((finding) => finding.code === 'caption-pixels')?.status).toBe(
        'fail',
      );

      const genericPromise = {
        ...promise,
        captions: { mode: 'burned-in' as const, required: true },
      };
      const generic = await exportAndInspect('caption-generic', sourceOnlyBundle, genericPromise);
      expect(generic.findings.find((finding) => finding.code === 'caption-pixels')).toBeUndefined();
      expect(
        generic.findings.find((finding) => finding.code === 'caption-pixels-unproven')?.status,
      ).toBe('warn');

      const recovered = await exportAndInspect('caption-retry', captionBundle, promise);
      expect(recovered.findings.find((finding) => finding.code === 'caption-pixels')?.status).toBe(
        'pass',
      );
      expect(promise.captions.burnIn?.segments.map((segment) => segment.direction)).toEqual([
        'ltr',
        'rtl',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('exports and inspects a V2 static overlay plus signed caption bundle with visible pixels', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-worker-v2-overlay-caption-'));
    const source = join(directory, 'source.mp4');
    const overlay = join(directory, 'overlay.png');
    const generated = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        "nullsrc=size=64x36:rate=24,geq=lum='35+mod(X+Y+N,20)':cb=128:cr=128",
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-shortest',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        source,
      ],
      { encoding: 'utf8' },
    );
    if (generated.status !== 0)
      throw new Error(generated.stderr || 'unable to create overlay source');
    const overlayResult = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:size=16x16',
        '-frames:v',
        '1',
        overlay,
      ],
      { encoding: 'utf8' },
    );
    if (overlayResult.status !== 0)
      throw new Error(overlayResult.stderr || 'unable to create overlay image');
    const videoBytes = readFileSync(source);
    const overlayBytes = readFileSync(overlay);
    const bundle = captionBundleV2(videoBytes, true, overlayBytes);
    const retained = new Map<string, Uint8Array>();
    const runtime = new WorkerRuntime(
      { workerId: 'worker-v2-overlay', createdAt: '2026-08-26T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: false, aiProviders: [] },
      {
        derivativeDirectory: directory,
        sources: new StaticLocalAssetSourceRegistry({ video: source, overlay }),
        renderArtifactResolver: async ({ outputRef }) => {
          const bytes = retained.get(outputRef);
          if (bytes === undefined) throw new Error('retained V2 artifact is missing');
          return bytes;
        },
      },
    );
    try {
      const exported = await runtime.run(
        {
          id: 'v2-overlay-export',
          type: 'render.export',
          payload: {
            projectRef: 'project-caption',
            compositionId: 'root',
            presetId: 'preview',
            reportRef: 'report-v2-overlay',
            bundle,
          },
        },
        { cancelled: () => false, progress: async () => undefined },
      );
      expect(exported.state).toBe('completed');
      if (exported.state !== 'completed' || exported.result.kind !== 'render.export')
        throw new Error('V2 overlay export did not complete');
      const output = readFileSync(join(directory, 'v2-overlay-export.mp4'));
      retained.set(exported.result.outputRef, output);
      const inspected = await runtime.run(
        {
          id: 'v2-overlay-inspect',
          type: 'render.inspect',
          payload: {
            projectRef: 'project-caption',
            compositionId: 'root',
            presetId: 'preview',
            reportRef: 'report-v2-overlay-inspect',
            artifactId: 'artifact-v2-overlay',
            outputRef: exported.result.outputRef,
            promise: captionPromise(bundle),
            mode: 'sampled',
          },
        },
        { cancelled: () => false, progress: async () => undefined },
      );
      expect(inspected.state).toBe('completed');
      if (inspected.state !== 'completed' || inspected.result.kind !== 'render.inspect')
        throw new Error('V2 overlay inspection did not complete');
      expect(
        inspected.result.report?.findings.filter((finding) => finding.status === 'fail'),
      ).toEqual([]);
      expect(
        inspected.result.report?.findings.find((finding) => finding.code === 'caption-pixels')
          ?.status,
      ).toBe('pass');
      const sourceFrame = spawnSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        source,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ]);
      const outputFrame = spawnSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        join(directory, 'v2-overlay-export.mp4'),
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ]);
      expect(sourceFrame.status).toBe(0);
      expect(outputFrame.status).toBe(0);
      const overlayPixel = 8 * 64 * 3 + 8 * 3;
      expect(outputFrame.stdout[overlayPixel]).toBeGreaterThan(150);
      expect(outputFrame.stdout[overlayPixel + 1]).toBeLessThan(100);
      expect(outputFrame.stdout[overlayPixel + 2]).toBeLessThan(100);
      let changed = 0;
      for (
        let index = 0;
        index < Math.min(sourceFrame.stdout.length, outputFrame.stdout.length);
        index++
      )
        if (sourceFrame.stdout[index] !== outputFrame.stdout[index]) changed++;
      expect(changed).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
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
      'media.semantic-index',
      'asset.thumbnail',
      'render.export',
      'render.inspect',
      'video.reference-analyze',
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

  it('fails closed on unsupported retained AI derivative mime types', () => {
    const runtime = new WorkerRuntime(
      { workerId: 'worker-ai', createdAt: '2026-08-21T00:00:00.000Z' },
      {
        ffmpeg: true,
        ffprobe: true,
        comfy: false,
        mlDenoise: false,
        aiProviders: ['runway', 'higgsfield'],
      },
    );

    expect(() =>
      runtime.readDerivative({
        kind: 'video.runway',
        assetId: 'ai-job-video',
        sha256: 'd'.repeat(64),
        bytes: 1024,
        localRef: 'ai-job-video-dddddddddddddddd',
        descriptor: { mimeType: 'video/webm' },
      }),
    ).toThrow(/unsupported retained AI derivative mime type/i);
  });
});

function captionBundleV2(videoBytes: Uint8Array, enabled = true, overlayBytes?: Uint8Array) {
  const durationUs = 1_000_000;
  const timeline: SpikeProject = {
    schemaVersion: 0,
    id: 'timeline-caption-contract',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 64,
        height: 36,
        frameRate: { num: 24, den: 1 },
        durationUs,
        tracks: [
          {
            id: 'video',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                id: 'video-clip',
                kind: 'video',
                startUs: 0,
                durationUs,
                assetId: 'video',
                sourceInUs: 0,
              },
            ],
          },
        ],
      },
    },
  };
  const captionTrack = {
    id: 'captions',
    kind: 'caption' as const,
    name: 'Captions',
    order: 0,
    enabled: true,
    locked: false,
    clips: [
      {
        id: 'caption-clip',
        kind: 'caption' as const,
        startUs: 0,
        durationUs,
        captionDocumentId: 'caption-document',
      },
    ],
  };
  const visual: JoyProjectV1 = {
    schemaVersion: 1,
    id: 'visual-caption-contract',
    title: 'Caption contract',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 64,
        height: 36,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 24, den: 1 },
        durationUs,
        background: '#202020',
        tracks: enabled ? [captionTrack] : [],
      },
    },
    assets: { video: { id: 'video', kind: 'video', displayName: 'Video' } },
    variables: {},
    markers: [],
    visualObjects:
      overlayBytes === undefined
        ? {}
        : {
            overlay: {
              id: 'overlay',
              kind: 'image',
              assetId: 'overlay',
              transform: {
                x: 0,
                y: 0,
                scaleX: 1,
                scaleY: 1,
                rotationDeg: 0,
                opacity: 1,
                crop: { left: 0, top: 0, right: 0, bottom: 0 },
              },
            },
          },
    captionDocuments: enabled
      ? {
          'caption-document': {
            id: 'caption-document',
            language: 'und',
            direction: 'auto',
            speakers: [],
            words: {
              ltrWord: { id: 'ltrWord', text: 'JOY', startUs: 0, endUs: 500_000 },
              rtlWord: { id: 'rtlWord', text: 'سلام', startUs: 500_000, endUs: durationUs },
            },
            segments: [
              { id: 'ltr', startUs: 0, endUs: 500_000, wordIds: ['ltrWord'] },
              { id: 'rtl', startUs: 500_000, endUs: durationUs, wordIds: ['rtlWord'] },
            ],
            styleRef: 'joy-clean',
          },
        }
      : {},
    pluginData: enabled ? { 'joy.captions.burnIn': true } : {},
  };
  const plan = createCompositionPlanV2({ timelineProject: timeline, visualProject: visual });
  return createRenderBundleV2({
    plan,
    projectRef: 'project-caption',
    assets: {
      video: {
        assetId: 'video',
        opaqueRef: 'asset:video',
        integrity: {
          sha256: createHash('sha256').update(videoBytes).digest('hex'),
          bytes: videoBytes.length,
          mime: 'video/mp4',
        },
      },
      ...(overlayBytes === undefined
        ? {}
        : {
            overlay: {
              assetId: 'overlay',
              opaqueRef: 'asset:overlay',
              integrity: {
                sha256: createHash('sha256').update(overlayBytes).digest('hex'),
                bytes: overlayBytes.length,
                mime: 'image/png',
              },
            },
          }),
    },
  });
}

function captionPromise(bundle: ReturnType<typeof captionBundleV2>) {
  const { plan } = bundle;
  const manifestPromise = deliveryPromiseForManifest({
    projectId: 'project-caption',
    revision: 0,
    width: plan.viewport.width,
    height: plan.viewport.height,
    frameRate: plan.frameRate.num / plan.frameRate.den,
    durationUs: plan.durationUs,
    preset: 'social-h264-aac',
  });
  const burnIn = plan.captionBurnIn;
  if (burnIn === undefined) return manifestPromise;
  return {
    ...manifestPromise,
    captions: {
      mode: 'burned-in' as const,
      required: true,
      burnIn: {
        styleRef: burnIn.styleRef,
        segments: burnIn.segments.map(({ startUs, endUs, text, direction }) => ({
          startUs,
          endUs,
          text,
          direction,
        })),
      },
    },
  };
}
