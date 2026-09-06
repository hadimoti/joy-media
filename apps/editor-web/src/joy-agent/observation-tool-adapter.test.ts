import { frameIdentityKey, type FrameIdentity } from '@joy-media/media-core';
import { describe, expect, it } from 'vitest';
import { createObservationCache } from '../media-observation/observation-cache.js';
import { createEvidenceStore } from '../media-observation/evidence-store.js';
import type { DecodeSourceObservationRequest } from '../media-observation/observation-worker-client.js';
import type { ObservationWorkerDecodedFrame } from '../media-observation/observation-protocol.js';
import type { ProjectMediaObservationSource } from '../project-media-resolver.js';
import {
  createJoyAgentObservationToolAdapter,
  type JoyAgentObservationAssetMetadata,
  type JoyAgentObservationCurrentAuthority,
} from './observation-tool-adapter.js';
import type { JoyAgentObservationToolAuthority } from './tool-bridge.js';

const assetDigest = 'a'.repeat(64);
const source: ProjectMediaObservationSource = Object.freeze({
  blob: new Blob(['trusted-local-video'], { type: 'video/mp4' }),
  mimeType: 'video/mp4',
  source: 'opfs',
});

const current: JoyAgentObservationCurrentAuthority = Object.freeze({
  projectId: 'project-1',
  revision: 'revision-1',
  run: Object.freeze({ runId: 'run-1', epoch: 1 }),
  modelId: 'openrouter/model-a',
  promptPolicyDigest: 'policy-v1',
});

const authority: JoyAgentObservationToolAuthority = Object.freeze({
  projectId: current.projectId,
  revision: current.revision,
  run: current.run,
});

const metadata: JoyAgentObservationAssetMetadata = Object.freeze({
  assetId: 'asset-1',
  assetDigest,
  kind: 'video',
  durationUs: 300_000,
  streamCount: 1,
  streamId: 'video-0',
  sourceVariant: Object.freeze({
    crop: Object.freeze({ x: 0, y: 0, width: 1920, height: 1080 }),
    rotationDeg: 0,
    representation: 'original',
    analysisVersion: 'observation-v1',
  }),
  transcript: Object.freeze({
    transcriptId: 'transcript-1',
    language: 'en',
    items: Object.freeze([
      Object.freeze({
        id: 'word-1',
        startUs: 10_000,
        endUs: 20_000,
        confidence: 0.9,
        speakerId: 'speaker-1',
      }),
    ]),
  }),
});

function frame(index: number): ObservationWorkerDecodedFrame {
  const identity: FrameIdentity = {
    assetDigest,
    streamId: 'video-0',
    presentationIndex: index,
    ptsTicks: String(index * 33_333),
    timebaseNumerator: 1,
    timebaseDenominator: 1_000_000,
    sourceTimeUs: index * 33_333,
    durationUs: 33_333,
  };
  const thumbnail = new Blob([`thumbnail-${index}`], { type: 'image/jpeg' });
  return Object.freeze({
    id: frameIdentityKey(identity),
    identity,
    actualTimeUs: identity.sourceTimeUs,
    durationUs: identity.durationUs,
    presentationIndex: index,
    width: 160,
    height: 90,
    thumbnail: Object.freeze({
      blob: thumbnail,
      width: 160,
      height: 90,
      byteLength: thumbnail.size,
      mimeType: 'image/jpeg',
    }),
  });
}

function zeroDurationFrame(): ObservationWorkerDecodedFrame {
  const identity: FrameIdentity = {
    assetDigest,
    streamId: 'video-0',
    presentationIndex: 0,
    ptsTicks: '0',
    timebaseNumerator: 1,
    timebaseDenominator: 1_000_000,
    sourceTimeUs: 0,
    durationUs: 0,
  };
  const thumbnail = new Blob(['thumbnail-zero'], { type: 'image/jpeg' });
  return Object.freeze({
    id: frameIdentityKey(identity),
    identity,
    actualTimeUs: 0,
    durationUs: 0,
    presentationIndex: 0,
    width: 160,
    height: 90,
    thumbnail: Object.freeze({
      blob: thumbnail,
      width: 160,
      height: 90,
      byteLength: thumbnail.size,
      mimeType: 'image/jpeg',
    }),
  });
}

class FakeResolver {
  readonly assetIds: string[] = [];

  async resolveObservationSource(assetId: string): Promise<ProjectMediaObservationSource> {
    this.assetIds.push(assetId);
    return source;
  }
}

class FakeWorker {
  readonly requests: DecodeSourceObservationRequest[] = [];

  constructor(private readonly framesToYield: readonly ObservationWorkerDecodedFrame[]) {}

  frames(
    request: DecodeSourceObservationRequest,
    signal: AbortSignal,
  ): AsyncIterable<ObservationWorkerDecodedFrame> {
    this.requests.push(request);
    const framesToYield = this.framesToYield;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<
        ObservationWorkerDecodedFrame,
        void,
        undefined
      > {
        for (const item of framesToYield) {
          if (signal.aborted) throw new Error('cancelled');
          yield item;
        }
      },
    };
  }
}

function createAdapter(
  options: {
    readonly worker?: FakeWorker;
    readonly currentAuthority?: () => JoyAgentObservationCurrentAuthority | undefined;
    readonly assetLookup?: (assetId: string) => JoyAgentObservationAssetMetadata | undefined;
  } = {},
) {
  const resolver = new FakeResolver();
  const worker = options.worker ?? new FakeWorker([frame(0), frame(1)]);
  const evidenceStore = createEvidenceStore();
  const adapter = createJoyAgentObservationToolAdapter({
    projectId: current.projectId,
    resolver,
    worker,
    evidenceStore,
    cache: createObservationCache({ maxBytes: 16 * 1024 }),
    assetLookup:
      options.assetLookup ?? ((assetId) => (assetId === metadata.assetId ? metadata : undefined)),
    currentAuthority: options.currentAuthority ?? (() => current),
    maxThumbnailBytes: 8 * 1024,
    digestThumbnail: async (bytes) => bytes.at(-1)!.toString(16).padStart(2, '0').repeat(32),
  });
  return { adapter, resolver, worker, evidenceStore };
}

describe('Joy Agent observation tool adapter', () => {
  it('uses injected asset metadata and returns no resolver-derived values from media_describe', async () => {
    const { adapter, resolver } = createAdapter();

    await expect(
      adapter.describe({ assetId: metadata.assetId }, authority, new AbortController().signal),
    ).resolves.toEqual({
      assetId: metadata.assetId,
      assetDigest,
      kind: 'video',
      durationUs: 300_000,
      streamCount: 1,
      transcriptAvailable: true,
    });
    expect(resolver.assetIds).toEqual([]);
  });

  it('preflights actual worker identities, checkpoints an ephemeral scoped manifest, and exposes metadata only', async () => {
    const { adapter, resolver, worker, evidenceStore } = createAdapter({
      worker: new FakeWorker([frame(0), frame(1), frame(2)]),
    });

    const observed = await adapter.observe(
      {
        assetId: metadata.assetId,
        range: { startUs: 0, endUs: 200_000 },
        mode: 'focus',
        maxFrames: 2,
        maxMetadataBytes: 2_048,
      },
      authority,
      new AbortController().signal,
    );

    expect(observed).toMatchObject({
      mode: 'focus',
      range: { startUs: 0, endUs: 200_000 },
      status: 'partial',
      intendedFrameCount: 2,
      decodedFrameCount: 2,
      omittedFrameCount: 0,
    });
    expect(resolver.assetIds).toEqual([metadata.assetId, metadata.assetId]);
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests.every((request) => request.source === source.blob)).toBe(true);
    expect(worker.requests.every((request) => request.assetDigest === assetDigest)).toBe(true);
    expect(
      evidenceStore.readManifest({
        manifestId: observed.manifestId,
        scope: {
          runId: current.run.runId,
          identity: {
            projectId: current.projectId,
            assetDigest,
            projectRevision: current.revision,
            modelId: current.modelId,
            promptPolicyDigest: current.promptPolicyDigest,
          },
        },
      }),
    ).toMatchObject({
      persistence: 'ephemeral',
      scope: {
        runId: current.run.runId,
        identity: {
          projectId: current.projectId,
          projectRevision: current.revision,
          modelId: current.modelId,
          promptPolicyDigest: current.promptPolicyDigest,
        },
      },
    });

    const frames = await adapter.frames(
      { observationId: observed.observationId, cursor: 0, pageSize: 16 },
      authority,
      new AbortController().signal,
    );
    expect(frames.items).toEqual([
      expect.objectContaining({ id: frame(0).id, actualTimeUs: 0, cacheHit: false }),
      expect.objectContaining({ id: frame(1).id, actualTimeUs: 33_333, cacheHit: false }),
    ]);
    expect(JSON.stringify(frames)).not.toMatch(/trusted-local-video|blob:|https?:|thumbnail-/i);

    const page = await adapter.readEvidence(
      { manifestId: observed.manifestId, pageIndex: 0 },
      authority,
      new AbortController().signal,
    );
    expect(page).toMatchObject({
      manifestId: observed.manifestId,
      mode: 'focus',
      status: 'partial',
      intendedFrameIds: [frame(0).id, frame(1).id],
      decodedFrameIds: [frame(0).id, frame(1).id],
      submittedFrameIds: [],
      reviewedFrameIds: [],
      summary: { exhaustiveInput: false, modelComprehensionGuaranteed: false },
    });
    expect(page).not.toHaveProperty('url');
  });

  it('keeps transcript words timing-only and rejects evidence after a model binding changes', async () => {
    let active: JoyAgentObservationCurrentAuthority | undefined = current;
    const { adapter } = createAdapter({ currentAuthority: () => active });
    const signal = new AbortController().signal;

    const transcript = await adapter.transcript(
      { assetId: metadata.assetId, range: { startUs: 0, endUs: 100_000 }, cursor: 0, pageSize: 8 },
      authority,
      signal,
    );
    expect(transcript).toEqual({
      transcriptId: 'transcript-1',
      assetId: metadata.assetId,
      language: 'en',
      range: { startUs: 0, endUs: 100_000 },
      wordCount: 1,
      contentAvailable: false,
      items: [
        {
          id: 'word-1',
          startUs: 10_000,
          endUs: 20_000,
          confidence: 0.9,
          speakerId: 'speaker-1',
        },
      ],
    });
    expect(JSON.stringify(transcript)).not.toContain('text');

    const observed = await adapter.observe(
      {
        assetId: metadata.assetId,
        range: { startUs: 0, endUs: 100_000 },
        mode: 'overview',
        maxFrames: 2,
        maxMetadataBytes: 2_048,
      },
      authority,
      signal,
    );
    active = { ...current, modelId: 'openrouter/model-b' };
    await expect(
      adapter.coverage({ manifestId: observed.manifestId }, authority, signal),
    ).rejects.toMatchObject({ code: 'stale-authority' });
  });

  it('fails closed rather than exposing a frame metadata shape the host RPC will reject', async () => {
    const { adapter } = createAdapter({ worker: new FakeWorker([zeroDurationFrame()]) });

    await expect(
      adapter.observe(
        {
          assetId: metadata.assetId,
          range: { startUs: 0, endUs: 100_000 },
          mode: 'overview',
          maxFrames: 1,
          maxMetadataBytes: 2_048,
        },
        authority,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'observation-failed' });
  });
});
