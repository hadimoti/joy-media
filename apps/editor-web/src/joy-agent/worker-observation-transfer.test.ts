import { describe, expect, it, vi } from 'vitest';
import type { JoyAgentEngineClient } from './engine-client.js';
import type {
  ObservationReviewHostTransferGrant,
  ObservationReviewHostTransferRequest,
} from './observation-review-controller.js';
import type { ObservationTransferAuthority } from './observation-transfer-service.js';
import { MAX_PRIVATE_OBSERVATION_FIRST_RELEASE_BYTES } from './observation-transfer-port-protocol.js';
import { createWorkerObservationReviewTransfer } from './worker-observation-transfer.js';

const authority: ObservationTransferAuthority = Object.freeze({
  projectId: 'project-1',
  revision: 'revision-1',
  run: Object.freeze({ runId: 'run-1', epoch: 1 }),
  modelId: 'openrouter/model-a',
  promptPolicyDigest: 'policy-1',
});

const range = Object.freeze({ domain: 'source' as const, startUs: 0, endUs: 1_000_000 });
const manifest = Object.freeze({
  manifestId: 'manifest-1',
  scope: Object.freeze({
    runId: authority.run.runId,
    identity: Object.freeze({
      projectId: authority.projectId,
      assetDigest: 'a'.repeat(64),
      projectRevision: authority.revision,
      modelId: authority.modelId,
      promptPolicyDigest: authority.promptPolicyDigest,
    }),
  }),
});

function grant(expiresAtMs = Date.now() + 60_000): ObservationReviewHostTransferGrant {
  return {
    authority,
    range,
    evidenceIds: ['frame-1'],
    modalities: ['image'],
    mediaCapability: { modelId: authority.modelId, modalities: ['image'] },
    maxRequests: 1,
    maxBytes: 64 * 1024,
    expiresAtMs,
  };
}

function request(signal = new AbortController().signal): ObservationReviewHostTransferRequest {
  return {
    authority,
    range,
    prompt: 'PRIVATE_PROMPT_CANARY',
    evidenceIds: ['frame-1'],
    manifest,
    mediaCapability: { modelId: authority.modelId, modalities: ['image'] },
    signal,
  };
}

function fixture() {
  let live: ObservationTransferAuthority | undefined = authority;
  const sendApprovedImageObservation = vi.fn<JoyAgentEngineClient['sendApprovedImageObservation']>(
    async () => ({
      ok: true as const,
      requestBytes: 123,
      analysis: { text: 'A safe visual observation.', submittedEvidenceIds: ['frame-1'] },
    }),
  );
  const markReviewed = vi.fn(() => true);
  const transfer = createWorkerObservationReviewTransfer({
    engineClient: { sendApprovedImageObservation },
    evidenceResolver: { resolve: vi.fn(() => undefined) },
    currentAuthority: () => live,
    lease: () => ({ leaseId: 'review-lease-1', expiresAtMs: Date.now() + 60_000 }),
    markReviewed,
  });
  return {
    transfer,
    sendApprovedImageObservation,
    markReviewed,
    setLive(value: ObservationTransferAuthority | undefined) {
      live = value;
    },
  };
}

describe('Worker-owned observation review transfer', () => {
  it('does not send until the explicit one-time grant and never gives the private client a connection', async () => {
    const f = fixture();

    expect(f.sendApprovedImageObservation).not.toHaveBeenCalled();
    f.transfer.grantUserApprovedConsent(grant());
    expect(f.sendApprovedImageObservation).not.toHaveBeenCalled();

    const result = await f.transfer.send(request());
    expect(result).toEqual({
      ok: true,
      requestBytes: 123,
      remainingRequests: 0,
      analysis: {
        text: 'A safe visual observation.',
        submittedEvidenceIds: ['frame-1'],
        reviewedEvidenceIds: ['frame-1'],
      },
    });
    const privateRequest = f.sendApprovedImageObservation.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    for (const forbidden of ['connection', 'apiKey', 'baseUrl', 'endpoint', 'manifest'])
      expect(privateRequest).not.toHaveProperty(forbidden);
    // The private request intentionally carries the human prompt only inside
    // the Worker-port closure; the controller-facing result cannot echo it.
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PROMPT_CANARY');
    expect(f.markReviewed).toHaveBeenCalledWith(authority, manifest, ['frame-1']);
  });

  it('fails closed on stale authority, invalid grants, and a replayed approval', async () => {
    const f = fixture();
    expect(() =>
      f.transfer.grantUserApprovedConsent({ ...grant(), modalities: ['video'] }),
    ).toThrow('invalid worker observation review grant');
    expect(() =>
      f.transfer.grantUserApprovedConsent({
        ...grant(),
        maxBytes: MAX_PRIVATE_OBSERVATION_FIRST_RELEASE_BYTES + 1,
      }),
    ).toThrow('invalid worker observation review grant');
    f.transfer.grantUserApprovedConsent(grant());
    f.setLive(undefined);
    await expect(f.transfer.send(request())).resolves.toEqual({
      ok: false,
      code: 'consent-denied',
    });
    expect(f.sendApprovedImageObservation).not.toHaveBeenCalled();

    f.setLive(authority);
    f.transfer.grantUserApprovedConsent(grant());
    await f.transfer.send(request());
    await expect(f.transfer.send(request())).resolves.toEqual({
      ok: false,
      code: 'consent-denied',
    });
  });

  it('maps private failures, cancellation, and bad returned identities without surfacing internals', async () => {
    const f = fixture();
    f.sendApprovedImageObservation.mockResolvedValueOnce({
      ok: false,
      code: 'capability-unavailable',
    });
    f.transfer.grantUserApprovedConsent(grant());
    await expect(f.transfer.send(request())).resolves.toEqual({
      ok: false,
      code: 'consent-denied',
    });

    f.sendApprovedImageObservation.mockResolvedValueOnce({
      ok: true,
      requestBytes: 123,
      analysis: { text: 'safe', submittedEvidenceIds: ['foreign-frame'] },
    });
    f.transfer.grantUserApprovedConsent(grant());
    await expect(f.transfer.send(request())).resolves.toEqual({
      ok: false,
      code: 'provider-rejected',
    });

    const controller = new AbortController();
    controller.abort();
    f.transfer.grantUserApprovedConsent(grant());
    await expect(f.transfer.send(request(controller.signal))).resolves.toEqual({
      ok: false,
      code: 'cancelled',
    });
  });
});
