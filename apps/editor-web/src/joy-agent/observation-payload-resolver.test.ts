import { frameIdentityKey, type FrameIdentity } from '@joy-media/media-core';
import { describe, expect, it, vi } from 'vitest';
import {
  createObservationCache,
  type ObservationCacheIdentity,
} from '../media-observation/observation-cache.js';
import {
  createEvidenceStore,
  type EvidenceManifestLookup,
} from '../media-observation/evidence-store.js';
import type { DecodeSourceObservationRequest } from '../media-observation/observation-worker-client.js';
import type { ObservationWorkerDecodedFrame } from '../media-observation/observation-protocol.js';
import type { ProjectMediaObservationSource } from '../project-media-resolver.js';
import {
  createJoyAgentObservationHostBridge,
  type JoyAgentObservationAssetMetadata,
  type JoyAgentObservationCurrentAuthority,
} from './observation-tool-adapter.js';
import {
  createObservationTransferEvidenceResolver,
  type ObservationPayloadRecord,
} from './observation-payload-resolver.js';
import type {
  ObservationTransferAuthority,
  ObservationTransferEvidenceResolverRequest,
} from './observation-transfer-service.js';
import { createObservationTransferService } from './observation-transfer-service.js';
import { createMultimodalTransport, type MultimodalFetch } from './multimodal-transport.js';
import { issueObservationConsent } from './observation-consent.js';
import type { JoyAgentObservationToolAuthority } from './tool-bridge.js';

const assetDigest = 'a'.repeat(64);
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
const transferAuthority: ObservationTransferAuthority = Object.freeze({ ...current });
const source: ProjectMediaObservationSource = Object.freeze({
  blob: new Blob(['PRIVATE_LOCAL_SOURCE_DO_NOT_SEND'], { type: 'video/mp4' }),
  mimeType: 'video/mp4',
  source: 'opfs',
});
const metadata: JoyAgentObservationAssetMetadata = Object.freeze({
  assetId: 'asset-1',
  assetDigest,
  kind: 'video',
  durationUs: 300_000,
  streamCount: 1,
  streamId: 'video-0',
  sourceVariant: Object.freeze({
    crop: Object.freeze({ x: 0, y: 0, width: 160, height: 90 }),
    rotationDeg: 0,
    representation: 'original',
    analysisVersion: 'observation-v1',
  }),
});

function frame(
  index = 0,
  contents = 'PRIVATE_FRAME_CANARY_DO_NOT_RETURN',
): ObservationWorkerDecodedFrame {
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
  const thumbnail = new Blob([contents], { type: 'image/jpeg' });
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

class FakeWorker {
  readonly requests: DecodeSourceObservationRequest[] = [];

  constructor(private readonly values: readonly ObservationWorkerDecodedFrame[]) {}

  frames(
    request: DecodeSourceObservationRequest,
    signal: AbortSignal,
  ): AsyncIterable<ObservationWorkerDecodedFrame> {
    this.requests.push(request);
    const values = this.values;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<
        ObservationWorkerDecodedFrame,
        void,
        undefined
      > {
        for (const value of values) {
          if (signal.aborted) throw new Error('cancelled');
          yield value;
        }
      },
    };
  }
}

function createBridgeFixture() {
  let active: JoyAgentObservationCurrentAuthority | undefined = current;
  const evidenceStore = createEvidenceStore();
  const cache = createObservationCache({
    maxBytes: 256 * 1024,
    assertProjectClearable: evidenceStore.assertProjectClearable,
  });
  const bridge = createJoyAgentObservationHostBridge({
    projectId: current.projectId,
    resolver: { resolveObservationSource: async () => source },
    worker: new FakeWorker([frame()]),
    evidenceStore,
    cache,
    assetLookup: (assetId) => (assetId === metadata.assetId ? metadata : undefined),
    currentAuthority: () => active,
    maxThumbnailBytes: 128 * 1024,
    digestThumbnail: async () => 'b'.repeat(64),
  });
  return {
    bridge,
    cache,
    evidenceStore,
    setActive(value: JoyAgentObservationCurrentAuthority | undefined) {
      active = value;
    },
  };
}

function lookup(manifestId: string): EvidenceManifestLookup {
  return {
    manifestId,
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
  };
}

function resolverRequest(
  evidenceIds: readonly string[],
  overrides: Partial<ObservationTransferEvidenceResolverRequest> = {},
): ObservationTransferEvidenceResolverRequest {
  return {
    authority: transferAuthority,
    range: { domain: 'source', startUs: 0, endUs: 100_000 },
    evidenceIds,
    allowedModalities: ['image'],
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('host-only observation payload resolver', () => {
  it('returns a defensive image payload only after a decoded observation, without adding a byte API to model tools', async () => {
    const { bridge, cache } = createBridgeFixture();
    const observation = await bridge.tools.observe(
      {
        assetId: metadata.assetId,
        range: { startUs: 0, endUs: 100_000 },
        mode: 'focus',
        maxFrames: 1,
        maxMetadataBytes: 2_048,
      },
      authority,
      new AbortController().signal,
    );
    const evidenceId = frame().id;
    const resolver = bridge.createEvidenceResolver(lookup(observation.manifestId));

    const first = await resolver.resolve(resolverRequest([evidenceId]));
    expect(first).toEqual([
      expect.objectContaining({ evidenceId, modality: 'image', mimeType: 'image/jpeg' }),
    ]);
    const payload = first?.[0];
    expect(payload).toBeDefined();
    payload!.data.fill(0);
    const second = await resolver.resolve(resolverRequest([evidenceId]));
    expect(second?.[0]?.data).not.toEqual(payload!.data);
    expect(cache.stats().usedBytes).toBeGreaterThan(0);

    const toolFrames = await bridge.tools.frames(
      { observationId: observation.observationId, cursor: 0, pageSize: 8 },
      authority,
      new AbortController().signal,
    );
    expect('createEvidenceResolver' in bridge.tools).toBe(false);
    expect(JSON.stringify(toolFrames)).not.toContain('PRIVATE_FRAME_CANARY_DO_NOT_RETURN');
    expect(JSON.stringify(toolFrames)).not.toContain('PRIVATE_LOCAL_SOURCE_DO_NOT_SEND');
  });

  it('fails closed for a stale/terminal authority, mismatched manifest, range, or unplanned evidence ID', async () => {
    const fixture = createBridgeFixture();
    const observation = await fixture.bridge.tools.observe(
      {
        assetId: metadata.assetId,
        range: { startUs: 0, endUs: 100_000 },
        mode: 'focus',
        maxFrames: 1,
        maxMetadataBytes: 2_048,
      },
      authority,
      new AbortController().signal,
    );
    const evidenceId = frame().id;
    const validLookup = lookup(observation.manifestId);
    const resolver = fixture.bridge.createEvidenceResolver(validLookup);
    expect(await resolver.resolve(resolverRequest([evidenceId]))).toHaveLength(1);

    fixture.setActive(undefined);
    expect(await resolver.resolve(resolverRequest([evidenceId]))).toBeUndefined();
    fixture.setActive(current);

    const mismatched = fixture.bridge.createEvidenceResolver({
      ...validLookup,
      scope: {
        ...validLookup.scope,
        identity: { ...validLookup.scope.identity, projectRevision: 'revision-2' },
      },
    });
    expect(await mismatched.resolve(resolverRequest([evidenceId]))).toBeUndefined();
    expect(await resolver.resolve(resolverRequest(['unplanned-frame']))).toBeUndefined();
    expect(
      await resolver.resolve(
        resolverRequest([evidenceId], {
          range: { domain: 'source', startUs: 100_000, endUs: 200_000 },
        }),
      ),
    ).toBeUndefined();
    fixture.evidenceStore.setStatus({ ...validLookup, status: 'cancelled' });
    expect(await resolver.resolve(resolverRequest([evidenceId]))).toBeUndefined();
  });

  it('fails closed on a cache miss after a terminal observation', async () => {
    const { bridge, cache } = createBridgeFixture();
    const observation = await bridge.tools.observe(
      {
        assetId: metadata.assetId,
        range: { startUs: 0, endUs: 100_000 },
        mode: 'focus',
        maxFrames: 1,
        maxMetadataBytes: 2_048,
      },
      authority,
      new AbortController().signal,
    );
    const resolver = bridge.createEvidenceResolver(lookup(observation.manifestId));
    const evidenceId = frame().id;
    expect(await resolver.resolve(resolverRequest([evidenceId]))).toHaveLength(1);
    cache.clearProject({ projectId: current.projectId, intent: 'user-request' });
    expect(await resolver.resolve(resolverRequest([evidenceId]))).toBeUndefined();
  });

  it('is directly compatible with the consent-bound transfer service without exposing bytes to HostRpc', async () => {
    const { bridge, evidenceStore } = createBridgeFixture();
    const observation = await bridge.tools.observe(
      {
        assetId: metadata.assetId,
        range: { startUs: 0, endUs: 100_000 },
        mode: 'focus',
        maxFrames: 1,
        maxMetadataBytes: 2_048,
      },
      authority,
      new AbortController().signal,
    );
    const evidenceId = frame().id;
    const manifest = lookup(observation.manifestId);
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'A bounded local frame.' } }] }),
          {
            status: 200,
          },
        ),
    ) as unknown as MultimodalFetch;
    const service = createObservationTransferService({
      transport: createMultimodalTransport({ fetch: fetcher }),
      evidenceStore,
      evidenceResolver: bridge.createEvidenceResolver(manifest),
      currentAuthority: () => transferAuthority,
    });
    const capability = { modelId: current.modelId, modalities: ['image'] as const };
    service.grantUserApprovedConsent({
      consent: issueObservationConsent(
        {
          projectId: current.projectId,
          runId: current.run.runId,
          endpointOrigin: 'https://provider.example',
          modelId: current.modelId,
          range: { domain: 'source', startUs: 0, endUs: 100_000 },
          evidenceIds: [evidenceId],
          modalities: ['image'],
          maxRequests: 1,
          maxBytes: 256 * 1024,
          expiresAtMs: Date.now() + 60_000,
        },
        capability,
      ),
      authority: transferAuthority,
    });

    await expect(
      service.send({
        connection: {
          provider: 'openrouter',
          baseUrl: 'https://provider.example/v1',
          modelId: current.modelId,
          apiKey: 'TEST_ONLY_BYOK_KEY',
        },
        authority: transferAuthority,
        range: { domain: 'source', startUs: 0, endUs: 100_000 },
        prompt: 'Inspect only the approved image frame.',
        evidenceIds: [evidenceId],
        manifest,
        mediaCapability: capability,
      }),
    ).resolves.toMatchObject({
      ok: true,
      analysis: { submittedEvidenceIds: [evidenceId], reviewedEvidenceIds: [evidenceId] },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(evidenceStore.readCoveragePage({ ...manifest, pageIndex: 0 })?.reviewedFrameIds).toEqual(
      [evidenceId],
    );
  });

  it('rejects an oversized cache payload before it reaches direct transfer', async () => {
    const evidenceStore = createEvidenceStore();
    const cache = createObservationCache({ maxBytes: 17 * 1024 * 1024 });
    const manifest = lookup('manifest-1');
    evidenceStore.createManifest({
      id: manifest.manifestId,
      scope: manifest.scope,
      mode: 'focus',
      intendedFrameIdPages: [['frame-1']],
    });
    evidenceStore.recordFrames({ ...manifest, stage: 'decoded', frameIds: ['frame-1'] });
    const cacheIdentity: ObservationCacheIdentity = {
      projectId: current.projectId,
      assetDigest,
      projectRevision: current.revision,
      modelId: current.modelId,
      promptPolicyDigest: current.promptPolicyDigest,
      streamId: 'video-0',
      crop: { x: 0, y: 0, width: 160, height: 90 },
      rotationDeg: 0,
      representation: 'original',
      analysisVersion: 'observation-v1',
    };
    cache.put({
      identity: cacheIdentity,
      temporalFrameId: 'frame-1',
      byteDigest: 'c'.repeat(64),
      bytes: new Uint8Array(16 * 1024 * 1024 + 1),
    });
    const record: ObservationPayloadRecord = {
      manifest,
      authority: transferAuthority,
      range: { startUs: 0, endUs: 100_000 },
      cacheIdentity,
      frameMimeTypes: new Map([['frame-1', 'image/jpeg']]),
      framePageById: new Map([['frame-1', 0]]),
    };
    const resolver = createObservationTransferEvidenceResolver({
      manifest,
      evidenceStore,
      cache,
      currentAuthority: () => transferAuthority,
      readRecord: () => record,
    });

    expect(await resolver.resolve(resolverRequest(['frame-1']))).toBeUndefined();
  });
});
