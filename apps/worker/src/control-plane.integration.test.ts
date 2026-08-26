import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalControlPlane } from '@joy-media/api';
import { deliveryPromiseForManifest } from '@joy-media/export-core';
import {
  captionBurnInDigestV2,
  createRenderBundle,
  createRenderBundleV2,
  planDigestV2,
  type CompositionPlanV2,
} from '@joy-media/render-planner';
import type { WorkerJobV1 } from '@joy-media/job-protocol';
import { executeLeasedExport } from './export-job.js';
import { StaticWorkerMediaResolver } from './worker-media-resolver.js';
import { StaticLocalAssetSourceRegistry, WorkerRuntime } from './runtime.js';
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
        complete: (workerId, jobId, receipt) => {
          api.registerWorkerRenderArtifact(workerId, jobId, {
            id: `artifact-${jobId}-${receipt.sha256.slice(0, 16)}`,
            outputRef: receipt.outputRef,
            sha256: receipt.sha256,
            bytes: receipt.bytes,
            descriptor: { mimeType: 'video/mp4' },
            location: { kind: 'private-object', ref: `render-${jobId}` },
          });
          return api.complete(workerId, jobId, Date.now(), receipt);
        },
      },
      'worker',
      'job',
      createRenderBundle({
        timelineProject: timelineProject(),
        visualProject: visualProject(),
        outputPreset: 'social-h264-aac',
        seed: 'integration',
      }),
      { outputDirectory: directory, mediaResolver: resolver(directory) },
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
        complete: (workerId, jobId, receipt) => {
          api.registerWorkerRenderArtifact(workerId, jobId, {
            id: `artifact-${jobId}-${receipt.sha256.slice(0, 16)}`,
            outputRef: receipt.outputRef,
            sha256: receipt.sha256,
            bytes: receipt.bytes,
            descriptor: { mimeType: 'video/mp4' },
            location: { kind: 'private-object', ref: `render-${jobId}` },
          });
          return api.complete(workerId, jobId, Date.now(), receipt);
        },
      },
      'worker-new',
      'job',
      createRenderBundle({
        timelineProject: timelineProject(),
        visualProject: visualProject(),
        outputPreset: 'social-h264-aac',
        seed: 'recovered',
      }),
      { outputDirectory: directory, mediaResolver: resolver(directory) },
    );
    expect(api.eventsAfter(owner, 'project', 0).at(-1)?.type).toBe('completed');
  });

  it('recovers a caption export lease, retains exact V2 evidence, and inspects the artifact', async () => {
    const api = new LocalControlPlane();
    const owner = { id: 'caption-owner' };
    api.createProject(owner, 'caption-project', 'Captions');
    api.pairWorker(owner, 'caption-worker-old');
    api.pairWorker(owner, 'caption-worker-new');
    api.helloWorker('caption-worker-old', ['render.export', 'render.inspect'], [], 100);
    api.helloWorker('caption-worker-new', ['render.export', 'render.inspect'], [], 100);

    const directory = mkdtempSync(join(tmpdir(), 'joy-media-caption-control-plane-'));
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

    const sourceBytes = readFileSync(source);
    const bundle = captionBundleV2(sourceBytes);
    const expectedCaption = bundle.plan.captionBurnIn!;
    const now = Date.now();
    const exportJob = renderExportJob('caption-export', bundle);
    api.enqueue(
      owner,
      'caption-export',
      'caption-project',
      'render.export',
      now,
      undefined,
      exportJob,
    );

    // The first Worker loses its lease before it can post a completion. The
    // second Worker receives the same immutable payload and performs recovery.
    expect(api.lease('caption-worker-old', now + 1, 5)?.id).toBe('caption-export');
    const recoveredLease = api.lease('caption-worker-new', now + 7, 30_000);
    expect(recoveredLease?.id).toBe('caption-export');
    expect(
      (recoveredLease?.payload as { bundle: typeof bundle }).bundle.plan.captionBurnIn,
    ).toEqual(expectedCaption);

    const retained = new Map<string, Uint8Array>();
    const runtime = new WorkerRuntime(
      { workerId: 'caption-worker-new', createdAt: '2026-08-26T00:00:00.000Z' },
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
    try {
      const exportResult = await runtime.run(recoveredLease as unknown as RuntimeJob, {
        cancelled: () => false,
        progress: async () => undefined,
      });
      expect(exportResult.state).toBe('completed');
      if (exportResult.state !== 'completed' || exportResult.result.kind !== 'render.export')
        throw new Error('caption export recovery did not complete');
      const artifactBytes = readFileSync(join(directory, 'caption-export.mp4'));
      retained.set(exportResult.result.outputRef, artifactBytes);
      expect(
        exportResult.result.qualityReport.findings.filter((finding) => finding.status === 'fail'),
      ).toEqual([]);
      expect(
        exportResult.result.qualityReport.findings.find(
          (finding) => finding.code === 'caption-pixels',
        )?.status,
      ).toBe('pass');
      expect(createHash('sha256').update(artifactBytes).digest('hex')).toBe(
        exportResult.result.sha256,
      );

      api.registerWorkerRenderArtifact(
        'caption-worker-new',
        'caption-export',
        {
          id: 'artifact-caption-export',
          outputRef: exportResult.result.outputRef,
          sha256: exportResult.result.sha256,
          bytes: exportResult.result.bytes,
          descriptor: { mimeType: 'video/mp4' },
          location: { kind: 'private-object', ref: 'render-caption-export' },
        },
        now + 8,
      );
      api.complete('caption-worker-new', 'caption-export', now + 9, {
        kind: 'render.export',
        reportRef: exportResult.result.reportRef,
        outputRef: exportResult.result.outputRef,
        sha256: exportResult.result.sha256,
        bytes: exportResult.result.bytes,
      });

      const promise = captionPromise(bundle);
      const inspectJob = renderInspectJob(
        'caption-inspect',
        exportResult.result.outputRef,
        promise,
      );
      api.enqueue(
        owner,
        'caption-inspect',
        'caption-project',
        'render.inspect',
        now + 10,
        undefined,
        inspectJob,
      );
      const inspectLease = api.lease('caption-worker-new', now + 11, 30_000);
      expect(inspectLease?.payload).toMatchObject({
        artifactId: 'artifact-caption-export',
        outputRef: exportResult.result.outputRef,
      });
      expect(
        (inspectLease?.payload as unknown as { promise: ReturnType<typeof captionPromise> })
          .promise,
      ).toEqual(promise);
      const inspectResult = await runtime.run(inspectLease as unknown as RuntimeJob, {
        cancelled: () => false,
        progress: async () => undefined,
      });
      expect(inspectResult.state).toBe('completed');
      if (inspectResult.state !== 'completed' || inspectResult.result.kind !== 'render.inspect')
        throw new Error('caption inspection recovery did not complete');
      expect(
        inspectResult.result.report?.findings.filter((finding) => finding.status === 'fail'),
      ).toEqual([]);
      expect(
        inspectResult.result.report?.findings.find((finding) => finding.code === 'caption-pixels')
          ?.status,
      ).toBe('pass');
      expect(inspectResult.result.report?.artifact).toMatchObject({
        outputRef: exportResult.result.outputRef,
        sha256: exportResult.result.sha256,
        bytes: exportResult.result.bytes,
      });
      expect(promise.captions.burnIn?.segments).toEqual(
        expectedCaption.segments.map(({ startUs, endUs, text, direction }) => ({
          startUs,
          endUs,
          text,
          direction,
        })),
      );
      api.complete('caption-worker-new', 'caption-inspect', now + 12, {
        kind: 'render.inspect',
        reportRef: inspectResult.result.reportRef,
        outputRef: exportResult.result.outputRef,
        report: inspectResult.result.report!,
      });

      const missingArtifactJob = renderInspectJob(
        'caption-inspect-missing',
        'missing-output',
        promise,
      );
      await expect(
        runtime.run(
          {
            id: 'caption-inspect-missing',
            type: 'render.inspect',
            payload: missingArtifactJob.payload,
          } as unknown as RuntimeJob,
          { cancelled: () => false, progress: async () => undefined },
        ),
      ).rejects.toThrow('retained artifact is missing');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

function resolver(directory: string): StaticWorkerMediaResolver {
  const mediaPath = join(directory, 'private.mp4');
  const generated = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x36:r=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '0.2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      mediaPath,
    ],
    { shell: false, encoding: 'utf8' },
  );
  if (generated.status !== 0) throw new Error(`failed to create test media: ${generated.stderr}`);
  return new StaticWorkerMediaResolver({ 'asset:clip': mediaPath });
}

type RuntimeJob = Parameters<WorkerRuntime['run']>[0];

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

function captionBundleV2(videoBytes: Uint8Array) {
  const durationUs = 1_000_000;
  const captionBase = {
    intent: 'burn-in' as const,
    styleRef: 'joy-clean' as const,
    segments: [
      { id: 'ltr', startUs: 0, endUs: 500_000, text: 'JOY', direction: 'ltr' as const },
      { id: 'rtl', startUs: 500_000, endUs: durationUs, text: 'سلام', direction: 'rtl' as const },
    ],
  };
  const captionBurnIn = {
    ...captionBase,
    payloadSha256: captionBurnInDigestV2(captionBase),
  };
  const planBase: CompositionPlanV2 = {
    version: 2,
    composition: { id: 'root', width: 64, height: 36 },
    viewport: { width: 64, height: 36 },
    frameRate: { num: 24, den: 1 },
    durationUs,
    background: '#202020',
    layers: [
      {
        id: 'video',
        kind: 'video',
        assetId: 'video',
        startUs: 0,
        durationUs,
        sourceInUs: 0,
        playbackRate: 1,
        zIndex: 0,
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
      },
    ],
    audio: [
      {
        id: 'audio:video',
        assetId: 'video',
        startUs: 0,
        durationUs,
        sourceInUs: 0,
        gain: 1,
        pan: 0,
        mute: false,
      },
    ],
    captionBurnIn,
    outputPreset: 'preview',
    planSha256: '',
  };
  const plan = { ...planBase, planSha256: planDigestV2(planBase) };
  return createRenderBundleV2({
    plan,
    projectRef: 'caption-project',
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
    },
  });
}

function captionPromise(bundle: ReturnType<typeof captionBundleV2>) {
  const manifestPromise = deliveryPromiseForManifest({
    projectId: 'caption-project',
    revision: 0,
    width: bundle.plan.viewport.width,
    height: bundle.plan.viewport.height,
    frameRate: bundle.plan.frameRate.num / bundle.plan.frameRate.den,
    durationUs: bundle.plan.durationUs,
    preset: 'social-h264-aac',
  });
  const burnIn = bundle.plan.captionBurnIn!;
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

function renderExportJob(id: string, bundle: ReturnType<typeof captionBundleV2>): WorkerJobV1 {
  return {
    protocolVersion: 1,
    jobId: id,
    type: 'render.export',
    payload: {
      projectRef: 'caption-project',
      compositionId: 'root',
      presetId: 'preview',
      reportRef: `report-${id}`,
      bundle,
    },
    requirements: { capabilities: ['render.export'], privacy: 'local-only' },
    idempotencyKey: id,
    maxAttempts: 3,
  };
}

function renderInspectJob(
  id: string,
  outputRef: string,
  promise: ReturnType<typeof captionPromise>,
): WorkerJobV1 {
  return {
    protocolVersion: 1,
    jobId: id,
    type: 'render.inspect',
    payload: {
      projectRef: 'caption-project',
      compositionId: 'root',
      presetId: 'preview',
      reportRef: `report-${id}`,
      artifactId: 'artifact-caption-export',
      outputRef,
      promise,
      mode: 'sampled',
    },
    requirements: { capabilities: ['render.inspect'], privacy: 'local-only' },
    idempotencyKey: id,
    maxAttempts: 3,
  };
}
