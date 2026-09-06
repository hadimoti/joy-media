import { describe, expect, it } from 'vitest';
import type { ProjectMediaObservationSource } from '../project-media-resolver.js';
import {
  createEvidenceStore,
  type EvidenceStore,
  type ObservationEvidenceIdentity,
} from './evidence-store.js';
import { createObservationCache } from './observation-cache.js';
import {
  createObservationService,
  type ObservationServiceError,
  type ObservationRunAuthority,
} from './observation-service.js';
import type { DecodeSourceObservationRequest } from './observation-worker-client.js';
import type { ObservationWorkerDecodedFrame } from './observation-protocol.js';

const assetDigest = 'a'.repeat(64);
const thumbnailDigest = 'b'.repeat(64);
const frameId = `source-frame:v1:${assetDigest}:video-0:0:0:timebase-1-1000000`;

function authority(overrides: Partial<ObservationRunAuthority> = {}): ObservationRunAuthority {
  return {
    projectId: 'project-1',
    run: { runId: 'run-1', epoch: 1 },
    assetId: 'asset-1',
    assetDigest,
    streamId: 'video-0',
    projectRevision: 'revision-1',
    modelId: 'openrouter/model-a',
    promptPolicyDigest: 'prompt-policy-v1',
    manifestId: 'manifest-1',
    range: { startUs: 0, endUs: 100_000 },
    sourceVariant: {
      crop: { x: 0, y: 0, width: 1920, height: 1080 },
      rotationDeg: 0,
      representation: 'original',
      analysisVersion: 'observation-v1',
    },
    maxFrames: 4,
    maxThumbnailBytes: 1_024,
    ...overrides,
  };
}

function evidenceIdentity(runAuthority: ObservationRunAuthority): ObservationEvidenceIdentity {
  return {
    projectId: runAuthority.projectId,
    assetDigest: runAuthority.assetDigest,
    projectRevision: runAuthority.projectRevision,
    modelId: runAuthority.modelId,
    promptPolicyDigest: runAuthority.promptPolicyDigest,
  };
}

function createManifest(store: EvidenceStore, runAuthority: ObservationRunAuthority): void {
  store.createManifest({
    id: runAuthority.manifestId,
    scope: { runId: runAuthority.run.runId, identity: evidenceIdentity(runAuthority) },
    mode: 'focus',
    intendedFrameIdPages: [[frameId]],
  });
}

function decodedFrame(
  overrides: Partial<ObservationWorkerDecodedFrame> = {},
): ObservationWorkerDecodedFrame {
  const thumbnail = new Blob(['thumbnail'], { type: 'image/jpeg' });
  return {
    id: frameId,
    identity: {
      assetDigest,
      streamId: 'video-0',
      presentationIndex: 0,
      ptsTicks: '0',
      timebaseNumerator: 1,
      timebaseDenominator: 1_000_000,
      sourceTimeUs: 0,
      durationUs: 33_333,
    },
    actualTimeUs: 0,
    durationUs: 33_333,
    presentationIndex: 0,
    width: 160,
    height: 90,
    thumbnail: {
      blob: thumbnail,
      width: 160,
      height: 90,
      byteLength: thumbnail.size,
      mimeType: 'image/jpeg',
    },
    ...overrides,
  };
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

class FakeResolver {
  readonly assetIds: string[] = [];

  constructor(
    private readonly source: ProjectMediaObservationSource,
    private readonly afterResolve?: () => void,
  ) {}

  async resolveObservationSource(assetId: string): Promise<ProjectMediaObservationSource> {
    this.assetIds.push(assetId);
    this.afterResolve?.();
    return this.source;
  }
}

class FakeWorkerClient {
  readonly requests: DecodeSourceObservationRequest[] = [];

  constructor(
    private readonly produce: (
      request: DecodeSourceObservationRequest,
      signal: AbortSignal,
    ) => AsyncIterable<ObservationWorkerDecodedFrame>,
  ) {}

  frames(
    request: DecodeSourceObservationRequest,
    signal: AbortSignal,
  ): AsyncIterable<ObservationWorkerDecodedFrame> {
    this.requests.push(request);
    return this.produce(request, signal);
  }
}

const localSource: ProjectMediaObservationSource = {
  blob: new Blob(['video-fixture'], { type: 'video/mp4' }),
  mimeType: 'video/mp4',
  source: 'opfs',
};

describe('observation service', () => {
  it('streams host-only canonical frames and records/cache-checkpoints them under the exact run scope', async () => {
    const runAuthority = authority();
    const evidenceStore = createEvidenceStore();
    createManifest(evidenceStore, runAuthority);
    const cache = createObservationCache({ maxBytes: 1_024 });
    const resolver = new FakeResolver(localSource);
    const worker = new FakeWorkerClient(async function* () {
      yield decodedFrame();
    });
    const service = createObservationService({
      projectId: runAuthority.projectId,
      resolver,
      worker,
      evidenceStore,
      cache,
      isAuthorityCurrent: (candidate) =>
        candidate.run.runId === runAuthority.run.runId &&
        candidate.run.epoch === runAuthority.run.epoch,
      digestThumbnail: async () => thumbnailDigest,
    });

    const frames = await collect(service.observe(runAuthority, new AbortController().signal));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      id: frameId,
      actualTimeUs: 0,
      durationUs: 33_333,
      cacheHit: false,
    });
    expect(Object.keys(frames[0]!)).not.toEqual(expect.arrayContaining(['url', 'path', 'model']));
    expect(resolver.assetIds).toEqual(['asset-1']);
    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]).toMatchObject({
      assetDigest,
      streamId: 'video-0',
      epoch: 1,
      range: runAuthority.range,
      source: localSource.blob,
    });
    expect(worker.requests[0]).not.toHaveProperty('url');
    expect(
      evidenceStore.readCoveragePage({
        manifestId: runAuthority.manifestId,
        scope: { runId: runAuthority.run.runId, identity: evidenceIdentity(runAuthority) },
        pageIndex: 0,
      })?.decodedFrameIds,
    ).toEqual([frameId]);
    expect(cache.stats()).toMatchObject({ temporalIdentityCount: 1, uniqueByteEntryCount: 1 });
  });

  it('allows a local exhaustive stream budget beyond one 512-frame provider batch', async () => {
    const runAuthority = authority({ maxFrames: 513 });
    const evidenceStore = createEvidenceStore();
    createManifest(evidenceStore, runAuthority);
    const service = createObservationService({
      projectId: runAuthority.projectId,
      resolver: new FakeResolver(localSource),
      worker: new FakeWorkerClient(async function* () {
        yield decodedFrame();
      }),
      evidenceStore,
      cache: createObservationCache({ maxBytes: 1_024 }),
      isAuthorityCurrent: () => true,
      digestThumbnail: async () => thumbnailDigest,
    });

    await expect(
      collect(service.observe(runAuthority, new AbortController().signal)),
    ).resolves.toHaveLength(1);
  });

  it('rejects a stale authority after media resolution before it can open the decoder', async () => {
    const runAuthority = authority();
    const evidenceStore = createEvidenceStore();
    createManifest(evidenceStore, runAuthority);
    let current = true;
    const resolver = new FakeResolver(localSource, () => {
      current = false;
    });
    const worker = new FakeWorkerClient(async function* () {
      yield decodedFrame();
    });
    const service = createObservationService({
      projectId: runAuthority.projectId,
      resolver,
      worker,
      evidenceStore,
      cache: createObservationCache({ maxBytes: 1_024 }),
      isAuthorityCurrent: () => current,
      digestThumbnail: async () => thumbnailDigest,
    });

    await expect(
      collect(service.observe(runAuthority, new AbortController().signal)),
    ).rejects.toMatchObject({
      code: 'stale-authority',
    } satisfies Partial<ObservationServiceError>);
    expect(worker.requests).toEqual([]);
  });

  it('does not cache or checkpoint a worker frame until its canonical identity matches the authority', async () => {
    const runAuthority = authority();
    const evidenceStore = createEvidenceStore();
    createManifest(evidenceStore, runAuthority);
    const cache = createObservationCache({ maxBytes: 1_024 });
    const worker = new FakeWorkerClient(async function* () {
      yield decodedFrame({ id: 'worker-order-0' });
    });
    const service = createObservationService({
      projectId: runAuthority.projectId,
      resolver: new FakeResolver(localSource),
      worker,
      evidenceStore,
      cache,
      isAuthorityCurrent: () => true,
      digestThumbnail: async () => thumbnailDigest,
    });

    await expect(
      collect(service.observe(runAuthority, new AbortController().signal)),
    ).rejects.toMatchObject({
      code: 'noncanonical-frame',
    } satisfies Partial<ObservationServiceError>);
    expect(cache.stats()).toMatchObject({ temporalIdentityCount: 0, usedBytes: 0 });
    expect(
      evidenceStore.readCoveragePage({
        manifestId: runAuthority.manifestId,
        scope: { runId: runAuthority.run.runId, identity: evidenceIdentity(runAuthority) },
        pageIndex: 0,
      })?.decodedFrameIds,
    ).toEqual([]);
  });

  it('rechecks live authority after asynchronous digest work before it writes derived cache/evidence', async () => {
    const runAuthority = authority();
    const evidenceStore = createEvidenceStore();
    createManifest(evidenceStore, runAuthority);
    const cache = createObservationCache({ maxBytes: 1_024 });
    let current = true;
    const service = createObservationService({
      projectId: runAuthority.projectId,
      resolver: new FakeResolver(localSource),
      worker: new FakeWorkerClient(async function* () {
        yield decodedFrame();
      }),
      evidenceStore,
      cache,
      isAuthorityCurrent: () => current,
      digestThumbnail: async () => {
        current = false;
        return thumbnailDigest;
      },
    });

    await expect(
      collect(service.observe(runAuthority, new AbortController().signal)),
    ).rejects.toMatchObject({
      code: 'stale-authority',
    } satisfies Partial<ObservationServiceError>);
    expect(cache.stats()).toMatchObject({ temporalIdentityCount: 0, usedBytes: 0 });
    expect(
      evidenceStore.readCoveragePage({
        manifestId: runAuthority.manifestId,
        scope: { runId: runAuthority.run.runId, identity: evidenceIdentity(runAuthority) },
        pageIndex: 0,
      })?.decodedFrameIds,
    ).toEqual([]);
  });

  it('rejects duplicate temporal identities instead of double-counting cached or decoded coverage', async () => {
    const runAuthority = authority();
    const evidenceStore = createEvidenceStore();
    createManifest(evidenceStore, runAuthority);
    const cache = createObservationCache({ maxBytes: 1_024 });
    const service = createObservationService({
      projectId: runAuthority.projectId,
      resolver: new FakeResolver(localSource),
      worker: new FakeWorkerClient(async function* () {
        yield decodedFrame();
        yield decodedFrame();
      }),
      evidenceStore,
      cache,
      isAuthorityCurrent: () => true,
      digestThumbnail: async () => thumbnailDigest,
    });

    await expect(
      collect(service.observe(runAuthority, new AbortController().signal)),
    ).rejects.toMatchObject({
      code: 'noncanonical-frame',
    } satisfies Partial<ObservationServiceError>);
    expect(cache.stats()).toMatchObject({ temporalIdentityCount: 1, uniqueByteEntryCount: 1 });
    expect(
      evidenceStore.readCoveragePage({
        manifestId: runAuthority.manifestId,
        scope: { runId: runAuthority.run.runId, identity: evidenceIdentity(runAuthority) },
        pageIndex: 0,
      })?.decodedFrameIds,
    ).toEqual([frameId]);
  });

  it('preserves the cache quota diagnostic instead of mislabelling it as a decoder failure', async () => {
    const runAuthority = authority();
    const evidenceStore = createEvidenceStore();
    createManifest(evidenceStore, runAuthority);
    const service = createObservationService({
      projectId: runAuthority.projectId,
      resolver: new FakeResolver(localSource),
      worker: new FakeWorkerClient(async function* () {
        yield decodedFrame();
      }),
      evidenceStore,
      cache: createObservationCache({ maxBytes: 1 }),
      isAuthorityCurrent: () => true,
      digestThumbnail: async () => thumbnailDigest,
    });

    await expect(
      collect(service.observe(runAuthority, new AbortController().signal)),
    ).rejects.toMatchObject({ code: 'JOY_OBSERVATION_CACHE_QUOTA_EXCEEDED' });
    expect(
      evidenceStore.readCoveragePage({
        manifestId: runAuthority.manifestId,
        scope: { runId: runAuthority.run.runId, identity: evidenceIdentity(runAuthority) },
        pageIndex: 0,
      })?.decodedFrameIds,
    ).toEqual([]);
  });

  it('cancels an active run/epoch stream without publishing a later frame', async () => {
    const runAuthority = authority();
    const evidenceStore = createEvidenceStore();
    createManifest(evidenceStore, runAuthority);
    const worker = new FakeWorkerClient(async function* (_request, signal) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('decoder cancelled')), {
          once: true,
        });
      });
      yield decodedFrame();
    });
    const service = createObservationService({
      projectId: runAuthority.projectId,
      resolver: new FakeResolver(localSource),
      worker,
      evidenceStore,
      cache: createObservationCache({ maxBytes: 1_024 }),
      isAuthorityCurrent: () => true,
      digestThumbnail: async () => thumbnailDigest,
    });

    const stream = service.observe(runAuthority, new AbortController().signal);
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.requests).toHaveLength(1);
    expect(service.cancel(runAuthority.run)).toBe(true);
    await expect(next).rejects.toMatchObject({
      code: 'cancelled',
    } satisfies Partial<ObservationServiceError>);
    expect(
      evidenceStore.readCoveragePage({
        manifestId: runAuthority.manifestId,
        scope: { runId: runAuthority.run.runId, identity: evidenceIdentity(runAuthority) },
        pageIndex: 0,
      })?.decodedFrameIds,
    ).toEqual([]);
  });
});
