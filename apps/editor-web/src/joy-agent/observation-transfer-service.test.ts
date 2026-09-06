import { describe, expect, it, vi } from 'vitest';
import {
  createEvidenceStore,
  type EvidenceManifestLookup,
} from '../media-observation/evidence-store.js';
import {
  createMultimodalTransport,
  type MultimodalFetch,
  type ObservationEvidencePayload,
} from './multimodal-transport.js';
import {
  issueObservationConsent,
  type ObservationConsent,
  type ObservationMediaCapability,
} from './observation-consent.js';
import {
  createObservationTransferService,
  type ObservationTransferAuthority,
  type ObservationTransferEvidenceResolverRequest,
  type ObservationTransferServiceRequest,
} from './observation-transfer-service.js';

const imageCapability: ObservationMediaCapability = {
  modelId: 'openrouter/model-a',
  modalities: ['image'],
};

function authority(
  overrides: Partial<ObservationTransferAuthority> = {},
): ObservationTransferAuthority {
  return {
    projectId: 'project-1',
    revision: 'revision-1',
    run: { runId: 'run-1', epoch: 1 },
    modelId: 'openrouter/model-a',
    promptPolicyDigest: 'policy-1',
    ...overrides,
  };
}

function consent(scope: ObservationTransferAuthority): ObservationConsent {
  return {
    projectId: scope.projectId,
    runId: scope.run.runId,
    endpointOrigin: 'https://provider.example',
    modelId: scope.modelId,
    range: { domain: 'source', startUs: 0, endUs: 1_000_000 },
    evidenceIds: ['frame-1'],
    modalities: ['image'],
    maxRequests: 2,
    maxBytes: 64 * 1024,
    expiresAtMs: Date.now() + 60_000,
  };
}

function evidence(
  data = new Uint8Array([1, 2, 3]),
  evidenceId = 'frame-1',
): ObservationEvidencePayload {
  return { evidenceId, modality: 'image', mimeType: 'image/png', data };
}

function createManifest(scope: ObservationTransferAuthority): {
  readonly store: ReturnType<typeof createEvidenceStore>;
  readonly lookup: EvidenceManifestLookup;
} {
  const store = createEvidenceStore();
  const manifestScope = {
    runId: scope.run.runId,
    identity: {
      projectId: scope.projectId,
      assetDigest: 'a'.repeat(64),
      projectRevision: scope.revision,
      modelId: scope.modelId,
      promptPolicyDigest: scope.promptPolicyDigest,
    },
  } as const;
  store.createManifest({
    id: 'manifest-1',
    scope: manifestScope,
    mode: 'focus',
    intendedFrameIdPages: [['frame-1']],
  });
  return { store, lookup: { manifestId: 'manifest-1', scope: manifestScope } };
}

function request(
  scope: ObservationTransferAuthority,
  manifest: EvidenceManifestLookup,
  overrides: Partial<ObservationTransferServiceRequest> = {},
): ObservationTransferServiceRequest {
  return {
    connection: {
      provider: 'openrouter',
      baseUrl: 'https://provider.example/v1',
      modelId: scope.modelId,
      apiKey: 'PRIVATE_BYOK_KEY',
    },
    authority: scope,
    range: { domain: 'source', startUs: 0, endUs: 500_000 },
    prompt: 'Inspect the approved evidence.',
    evidenceIds: ['frame-1'],
    manifest,
    mediaCapability: imageCapability,
    ...overrides,
  };
}

function providerSuccess(content = 'The approved frame contains a subject.'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function issuedConsent(scope: ObservationTransferAuthority): unknown {
  return issueObservationConsent(consent(scope), imageCapability, Date.now());
}

describe('observation transfer service', () => {
  it('stays unusable until the UI host explicitly grants an issued consent', async () => {
    const scope = authority();
    const { store, lookup } = createManifest(scope);
    const fetcher = vi.fn(async () => providerSuccess()) as unknown as MultimodalFetch;
    const resolver = { resolve: vi.fn(async () => [evidence()]) };
    const service = createObservationTransferService({
      transport: createMultimodalTransport({ fetch: fetcher }),
      evidenceStore: store,
      evidenceResolver: resolver,
      currentAuthority: () => scope,
    });

    const result = await service.send(request(scope, lookup));

    expect(result).toEqual({ ok: false, code: 'consent-denied' });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('records submitted and reviewed opaque frame identities only after a successful response', async () => {
    const scope = authority();
    const { store, lookup } = createManifest(scope);
    const fetcher = vi.fn(async () => providerSuccess()) as unknown as MultimodalFetch;
    const resolver = { resolve: vi.fn(async () => [evidence()]) };
    const service = createObservationTransferService({
      transport: createMultimodalTransport({ fetch: fetcher }),
      evidenceStore: store,
      evidenceResolver: resolver,
      currentAuthority: () => scope,
    });
    service.grantUserApprovedConsent({ consent: issuedConsent(scope), authority: scope });

    await expect(service.send(request(scope, lookup))).resolves.toEqual({
      ok: true,
      requestBytes: expect.any(Number),
      remainingRequests: 1,
      analysis: {
        text: 'The approved frame contains a subject.',
        submittedEvidenceIds: ['frame-1'],
        reviewedEvidenceIds: ['frame-1'],
      },
    });
    expect(store.readCoveragePage({ ...lookup, pageIndex: 0 })?.submittedFrameIds).toEqual([
      'frame-1',
    ]);
    expect(store.readCoveragePage({ ...lookup, pageIndex: 0 })?.reviewedFrameIds).toEqual([
      'frame-1',
    ]);
  });

  it('fails closed before resolving local bytes when run, revision, model, or policy authority is stale', async () => {
    const scope = authority();
    let currentAuthority = scope;
    const { store, lookup } = createManifest(scope);
    const fetcher = vi.fn(async () => providerSuccess()) as unknown as MultimodalFetch;
    const resolver = { resolve: vi.fn(async () => [evidence()]) };
    const service = createObservationTransferService({
      transport: createMultimodalTransport({ fetch: fetcher }),
      evidenceStore: store,
      evidenceResolver: resolver,
      currentAuthority: () => currentAuthority,
    });
    service.grantUserApprovedConsent({ consent: issuedConsent(scope), authority: scope });
    currentAuthority = authority({ revision: 'revision-2' });

    await expect(service.send(request(scope, lookup))).resolves.toEqual({
      ok: false,
      code: 'consent-denied',
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects resolver overreach, modality changes, and oversize payloads before direct fetch', async () => {
    const scope = authority();
    const { store, lookup } = createManifest(scope);
    const fetcher = vi.fn(async () => providerSuccess()) as unknown as MultimodalFetch;
    const resolver = {
      resolve: vi.fn(async () => [evidence(), evidence(new Uint8Array([4]), 'unapproved-frame')]),
    };
    const service = createObservationTransferService({
      transport: createMultimodalTransport({ fetch: fetcher }),
      evidenceStore: store,
      evidenceResolver: resolver,
      currentAuthority: () => scope,
    });
    service.grantUserApprovedConsent({ consent: issuedConsent(scope), authority: scope });

    await expect(service.send(request(scope, lookup))).resolves.toEqual({
      ok: false,
      code: 'invalid-request',
    });
    expect(fetcher).not.toHaveBeenCalled();

    const modalityScope = authority({ run: { runId: 'run-2', epoch: 1 } });
    const modalityManifest = createManifest(modalityScope);
    const modalityService = createObservationTransferService({
      transport: createMultimodalTransport({ fetch: fetcher }),
      evidenceStore: modalityManifest.store,
      evidenceResolver: {
        resolve: async () => [
          {
            evidenceId: 'frame-1',
            modality: 'video',
            mimeType: 'video/mp4',
            data: new Uint8Array([1, 2, 3]),
          },
        ],
      },
      currentAuthority: () => modalityScope,
    });
    modalityService.grantUserApprovedConsent({
      consent: issuedConsent(modalityScope),
      authority: modalityScope,
    });
    await expect(
      modalityService.send(request(modalityScope, modalityManifest.lookup)),
    ).resolves.toEqual({
      ok: false,
      code: 'invalid-request',
    });
    expect(fetcher).not.toHaveBeenCalled();

    const oversizeResolver = {
      resolve: vi.fn(async () => [evidence(new Uint8Array(16 * 1024 * 1024 + 1))]),
    };
    const oversizeScope = authority({ run: { runId: 'run-3', epoch: 1 } });
    const oversizeManifest = createManifest(oversizeScope);
    const oversizeServiceWithScope = createObservationTransferService({
      transport: createMultimodalTransport({ fetch: fetcher }),
      evidenceStore: oversizeManifest.store,
      evidenceResolver: oversizeResolver,
      currentAuthority: () => oversizeScope,
    });
    oversizeServiceWithScope.grantUserApprovedConsent({
      consent: issuedConsent(oversizeScope),
      authority: oversizeScope,
    });
    await expect(
      oversizeServiceWithScope.send(request(oversizeScope, oversizeManifest.lookup)),
    ).resolves.toEqual({ ok: false, code: 'invalid-request' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels resolver work, revokes the one-time grant, and starts no later provider request', async () => {
    const scope = authority();
    const { store, lookup } = createManifest(scope);
    const fetcher = vi.fn(async () => providerSuccess()) as unknown as MultimodalFetch;
    const resolver = {
      resolve: vi.fn(
        ({ signal }: ObservationTransferEvidenceResolverRequest) =>
          new Promise<readonly ObservationEvidencePayload[]>((resolve) => {
            signal.addEventListener('abort', () => resolve([]), { once: true });
          }),
      ),
    };
    const service = createObservationTransferService({
      transport: createMultimodalTransport({ fetch: fetcher }),
      evidenceStore: store,
      evidenceResolver: resolver,
      currentAuthority: () => scope,
    });
    service.grantUserApprovedConsent({ consent: issuedConsent(scope), authority: scope });

    const pending = service.send(request(scope, lookup));
    await vi.waitFor(() => expect(resolver.resolve).toHaveBeenCalledTimes(1));
    expect(service.cancel(scope.run.runId)).toBe(true);
    await expect(pending).resolves.toEqual({ ok: false, code: 'cancelled' });
    await expect(service.send(request(scope, lookup))).resolves.toEqual({
      ok: false,
      code: 'consent-denied',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.readCoveragePage({ ...lookup, pageIndex: 0 })?.submittedFrameIds).toEqual([]);
  });

  it('marks a received provider rejection as submitted but never reviewed', async () => {
    const scope = authority();
    const { store, lookup } = createManifest(scope);
    const fetcher = vi.fn(
      async () => new Response('PRIVATE_PROVIDER_FAILURE_BODY', { status: 500 }),
    ) as unknown as MultimodalFetch;
    const service = createObservationTransferService({
      transport: createMultimodalTransport({ fetch: fetcher }),
      evidenceStore: store,
      evidenceResolver: { resolve: async () => [evidence()] },
      currentAuthority: () => scope,
    });
    service.grantUserApprovedConsent({ consent: issuedConsent(scope), authority: scope });

    await expect(service.send(request(scope, lookup))).resolves.toEqual({
      ok: false,
      code: 'provider-rejected',
    });
    expect(store.readCoveragePage({ ...lookup, pageIndex: 0 })?.submittedFrameIds).toEqual([
      'frame-1',
    ]);
    expect(store.readCoveragePage({ ...lookup, pageIndex: 0 })?.reviewedFrameIds).toEqual([]);
  });

  it('never leaks resolved bytes, provider URL, or BYOK key through the service result', async () => {
    const scope = authority();
    const { store, lookup } = createManifest(scope);
    const fetcher = vi.fn(async () =>
      providerSuccess('PRIVATE_RAW_FRAME_CANARY_DO_NOT_RETURN'),
    ) as unknown as MultimodalFetch;
    const service = createObservationTransferService({
      transport: createMultimodalTransport({ fetch: fetcher }),
      evidenceStore: store,
      evidenceResolver: {
        resolve: async () => [
          evidence(new TextEncoder().encode('PRIVATE_RAW_FRAME_CANARY_DO_NOT_RETURN')),
        ],
      },
      currentAuthority: () => scope,
    });
    service.grantUserApprovedConsent({ consent: issuedConsent(scope), authority: scope });

    const result = await service.send(request(scope, lookup));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('PRIVATE_RAW_FRAME_CANARY_DO_NOT_RETURN');
    expect(serialized).not.toContain('PRIVATE_BYOK_KEY');
    expect(serialized).not.toContain('provider.example');
    expect(result).toEqual({ ok: false, code: 'provider-rejected' });
    expect(store.readCoveragePage({ ...lookup, pageIndex: 0 })?.submittedFrameIds).toEqual([
      'frame-1',
    ]);
    expect(store.readCoveragePage({ ...lookup, pageIndex: 0 })?.reviewedFrameIds).toEqual([]);
  });
});
