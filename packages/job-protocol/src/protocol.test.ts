import { describe, expect, it } from 'vitest';
import {
  InMemoryWorkerCoordinator,
  WorkerProtocolError,
  WORKER_PROTOCOL_VERSION,
  validateWorkerJobV1,
  validateWorkerReceiptForJob,
  workerCanRunJob,
} from './protocol.js';
import type { ThumbnailJob, WorkerHello } from './protocol.js';

const hello: WorkerHello = {
  protocolVersion: WORKER_PROTOCOL_VERSION,
  workerId: 'worker-local-1',
  workerVersion: '0.0.0-spike',
  platform: 'win32',
  architecture: 'x64',
  capabilities: ['asset.thumbnail'],
  localAssetIds: ['asset-sha256-abc'],
  maxConcurrentJobs: 1,
};

const job = (id = 'thumbnail-1'): ThumbnailJob => ({
  protocolVersion: WORKER_PROTOCOL_VERSION,
  jobId: id,
  type: 'asset.thumbnail',
  payload: { assetId: 'asset-sha256-abc', maxEdgePx: 720 },
  requirements: { capabilities: ['asset.thumbnail'], privacy: 'local-only' },
  idempotencyKey: `idem-${id}`,
  maxAttempts: 2,
});

function pairedCoordinator(): { coordinator: InMemoryWorkerCoordinator; token: string } {
  const coordinator = new InMemoryWorkerCoordinator();
  coordinator.createPairingOffer('pair-123456', 1_000);
  const grant = coordinator.acceptOutboundPair(
    {
      workerId: hello.workerId,
      pairingCode: 'pair-123456',
      publicKeyFingerprint: 'sha256-public-key',
    },
    500,
  );
  coordinator.receiveHello(grant.sessionToken, hello, 500);
  return { coordinator, token: grant.sessionToken };
}

describe('Worker pairing and thumbnail job spike', () => {
  it('accepts an outbound pair then stores a normalized capability report', () => {
    const { coordinator } = pairedCoordinator();
    expect(coordinator.capabilitySnapshot('worker-local-1')).toEqual({ hello, observedAtMs: 500 });
  });

  it('rejects expired pairing offers', () => {
    const coordinator = new InMemoryWorkerCoordinator();
    coordinator.createPairingOffer('pair-123456', 1_000);
    expect(() =>
      coordinator.acceptOutboundPair(
        {
          workerId: hello.workerId,
          pairingCode: 'pair-123456',
          publicKeyFingerprint: 'fingerprint',
        },
        1_001,
      ),
    ).toThrow(expect.objectContaining({ code: 'WORKER_PAIRING_DENIED' }));
  });

  it('runs a local-only thumbnail job with progress and keeps paths/bytes out of the protocol', () => {
    const { coordinator, token } = pairedCoordinator();
    coordinator.enqueueThumbnail(job());
    expect(coordinator.claimNextThumbnail(token)).toEqual({ job: job(), attempt: 1 });
    coordinator.beginThumbnail(token, 'thumbnail-1');
    coordinator.reportThumbnailProgress(token, 'thumbnail-1', 1, 2, 'decode local asset');
    coordinator.reportThumbnailProgress(token, 'thumbnail-1', 2, 2, 'encode thumbnail');
    coordinator.succeedThumbnail(token, 'thumbnail-1', 'derivative-thumb-abc');
    expect(coordinator.jobSnapshot('thumbnail-1')).toMatchObject({
      state: 'succeeded',
      outputAssetId: 'derivative-thumb-abc',
      progress: { completed: 2, total: 2 },
    });
    expect(JSON.stringify({ hello, job: job(), events: coordinator.events() })).not.toContain(
      'C:\\Users\\Owner',
    );
  });

  it('delivers cancellation to the owning Worker and records cancellation', () => {
    const { coordinator, token } = pairedCoordinator();
    coordinator.enqueueThumbnail(job());
    coordinator.claimNextThumbnail(token);
    coordinator.beginThumbnail(token, 'thumbnail-1');
    coordinator.requestCancellation('thumbnail-1');
    expect(coordinator.isCancellationRequested(token, 'thumbnail-1')).toBe(true);
    coordinator.finishCanceled(token, 'thumbnail-1');
    expect(coordinator.jobSnapshot('thumbnail-1').state).toBe('canceled');
  });

  it('requeues a failed thumbnail only within its retry budget', () => {
    const { coordinator, token } = pairedCoordinator();
    coordinator.enqueueThumbnail(job());
    coordinator.claimNextThumbnail(token);
    coordinator.beginThumbnail(token, 'thumbnail-1');
    coordinator.failThumbnail(token, 'thumbnail-1', 'THUMBNAIL_DECODER_FAILED');
    coordinator.retryThumbnail('thumbnail-1');
    expect(coordinator.claimNextThumbnail(token)).toEqual({ job: job(), attempt: 2 });
    expect(coordinator.events().map((event) => event.type)).toEqual([
      'job.queued',
      'job.assigned',
      'job.failed',
      'job.retried',
      'job.assigned',
    ]);
  });

  it('rejects raw paths in either asset identity field', () => {
    const { coordinator } = pairedCoordinator();
    expect(() =>
      coordinator.enqueueThumbnail({
        ...job(),
        payload: { assetId: 'C:\\video.mp4', maxEdgePx: 720 },
      }),
    ).toThrow(expect.objectContaining({ code: 'WORKER_PROTOCOL_PATH_FORBIDDEN' }));
    expect(() =>
      coordinator.enqueueThumbnail({
        ...job(),
        payload: { assetId: '/video.mp4', maxEdgePx: 720 },
      }),
    ).toThrow(WorkerProtocolError);
  });

  it('keeps Worker jobs closed, capability-matched, bounded, and path-free', () => {
    expect(workerCanRunJob(['render.export'], 'render.export')).toBe(true);
    expect(workerCanRunJob(['asset.thumbnail'], 'render.export')).toBe(false);
    expect(workerCanRunJob(['render.export'], 'unknown.job')).toBe(false);
    expect(() =>
      validateWorkerJobV1({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        jobId: 'render-1',
        type: 'render.export',
        payload: {
          projectRef: 'project-1',
          compositionId: 'root',
          presetId: 'reels-1080',
          reportRef: 'report-1',
        },
        requirements: { capabilities: ['render.export'], privacy: 'local-only' },
        idempotencyKey: 'idem-render-1',
        maxAttempts: 1,
      }),
    ).not.toThrow();
    expect(() =>
      validateWorkerJobV1({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        jobId: 'render-1',
        type: 'render.export',
        payload: {
          projectRef: 'C:\\projects\\joy.json',
          compositionId: 'root',
          presetId: 'reels-1080',
          reportRef: 'report-1',
        },
        requirements: { capabilities: ['render.export'], privacy: 'local-only' },
        idempotencyKey: 'idem-render-1',
        maxAttempts: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'WORKER_PROTOCOL_PATH_FORBIDDEN' }));
    expect(() =>
      validateWorkerJobV1({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        jobId: 'render-1',
        type: 'render.export',
        payload: {
          projectRef: 'project-1',
          compositionId: 'root',
          presetId: 'reels-1080',
          reportRef: 'report-1',
        },
        requirements: { capabilities: ['render.inspect'], privacy: 'local-only' },
        idempotencyKey: 'idem-render-1',
        maxAttempts: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'WORKER_JOB_INVALID' }));
    expect(() =>
      validateWorkerJobV1({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        jobId: 'render-1',
        type: 'render.export',
        payload: {
          projectRef: 'project-1',
          compositionId: 'root',
          presetId: 'reels-1080',
          reportRef: 'report-1',
          unexpected: true,
        } as never,
        requirements: { capabilities: ['render.export'], privacy: 'local-only' },
        idempotencyKey: 'idem-render-1',
        maxAttempts: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'WORKER_JOB_INVALID' }));
    expect(() =>
      validateWorkerJobV1({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        jobId: 'render-1',
        type: 'render.export',
        payload: {
          projectRef: 'project-1',
          compositionId: 'root',
          presetId: 'reels-1080',
          reportRef: 'r'.repeat(16_385),
        },
        requirements: { capabilities: ['render.export'], privacy: 'local-only' },
        idempotencyKey: 'idem-render-1',
        maxAttempts: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'WORKER_PROTOCOL_OVERSIZE' }));
  });

  it('requires receipts to match the job type', () => {
    expect(() => validateWorkerReceiptForJob('render.export', undefined)).toThrow(
      expect.objectContaining({ code: 'WORKER_RECEIPT_INVALID' }),
    );
    expect(() =>
      validateWorkerReceiptForJob('render.export', {
        kind: 'render.export',
        reportRef: 'report-1',
        outputRef: 'export-1',
        sha256: 'a'.repeat(64),
        bytes: 1024,
      }),
    ).not.toThrow();
    expect(() =>
      validateWorkerReceiptForJob('render.export', {
        kind: 'render.inspect',
        reportRef: 'report-1',
        findings: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'WORKER_RECEIPT_INVALID' }));
  });

  it('accepts every Worker-advertised receipt variant consistently', () => {
    expect(() =>
      validateWorkerReceiptForJob('asset.thumbnail', {
        kind: 'asset.thumbnail',
        assetId: 'asset-1',
        sha256: 'a'.repeat(64),
        bytes: 1024,
        localRef: 'thumb-job-1-aaaaaaaaaaaaaaaa',
        descriptor: { mimeType: 'image/jpeg', width: 320, height: 180 },
      }),
    ).not.toThrow();
    expect(() =>
      validateWorkerReceiptForJob('image.comfy', {
        kind: 'image.comfy',
        assetId: 'asset-2',
        sha256: 'b'.repeat(64),
        bytes: 2048,
        localRef: 'gpu-job-1-bbbbbbbbbbbbbbbb',
        descriptor: { mimeType: 'image/png', width: 512, height: 512 },
      }),
    ).not.toThrow();
    expect(() =>
      validateWorkerReceiptForJob('audio.ml-denoise', {
        kind: 'audio.ml-denoise',
        assetId: 'asset-3',
        sha256: 'c'.repeat(64),
        bytes: 4096,
        localRef: 'gpu-job-2-cccccccccccccccc',
        descriptor: { mimeType: 'audio/wav' },
      }),
    ).not.toThrow();
    expect(() =>
      validateWorkerReceiptForJob('render.inspect', {
        kind: 'render.inspect',
        reportRef: 'report-2',
        findings: 1,
      }),
    ).not.toThrow();
    expect(() =>
      validateWorkerReceiptForJob('text.lm-studio', {
        kind: 'text.lm-studio',
        resultRef: 'ai-job-1',
        sha256: 'd'.repeat(64),
        bytes: 64,
        model: 'local-model',
      }),
    ).not.toThrow();
    expect(() =>
      validateWorkerReceiptForJob('text.openrouter', {
        kind: 'text.openrouter',
        resultRef: 'ai-job-2',
        sha256: 'e'.repeat(64),
        bytes: 128,
        model: 'openrouter-model',
      }),
    ).not.toThrow();
    expect(() =>
      validateWorkerReceiptForJob('video.runway', {
        kind: 'video.runway',
        assetId: 'asset-video-1',
        sha256: 'f'.repeat(64),
        bytes: 8192,
        localRef: 'ai-job-3-ffffffffffffffff',
        descriptor: { mimeType: 'video/mp4' },
        model: 'gen4',
      }),
    ).not.toThrow();
    expect(() =>
      validateWorkerReceiptForJob('edit.higgsfield', {
        kind: 'edit.higgsfield',
        assetId: 'asset-edit-1',
        sha256: '1'.repeat(64),
        bytes: 4096,
        localRef: 'ai-job-4-1111111111111111',
        descriptor: { mimeType: 'image/png', width: 1024, height: 1024 },
        model: 'higgsfield-default',
      }),
    ).not.toThrow();
  });
});
