import { describe, expect, it, vi } from 'vitest';
import type { JoyAgentEngineClient } from './engine-client.js';
import type { ObservationEvidencePayload } from './multimodal-transport.js';
import type { QcFrameTransportInput } from './qc-host-adapter.js';
import { createQcPrivateFrameTransport } from './qc-private-frame-transport.js';

const authority = {
  projectId: 'project-1',
  revision: 'revision-1',
  run: { runId: 'run-1', epoch: 1 },
  modelId: 'model-1',
  promptPolicyDigest: 'policy-1',
} as const;

function request(): QcFrameTransportInput {
  return {
    reportId: 'qc-report-run-1-1',
    tool: 'media_frames_view',
    reason: 'Check the title edge',
    frames: [
      {
        frameId: 'timeline-frame-1',
        timestampUs: 1_000_000,
        jpeg: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
        width: 2,
        height: 2,
        coverage: {
          sourceDurationUs: 2_000_000,
          sampledFrameCount: 2,
          sampledCutCount: 0,
          totalCutCount: 0,
          completeSourceCoverage: false,
        },
      },
      {
        frameId: 'timeline-frame-2',
        timestampUs: 2_000_000,
        jpeg: new Blob([new Uint8Array([4, 5])], { type: 'image/jpeg' }),
        width: 2,
        height: 2,
        coverage: {
          sourceDurationUs: 2_000_000,
          sampledFrameCount: 2,
          sampledCutCount: 0,
          totalCutCount: 0,
          completeSourceCoverage: false,
        },
      },
    ],
    contactSheet: undefined,
    signal: new AbortController().signal,
  };
}

describe('QC private frame transport', () => {
  it('registers the exact report frames and returns only bounded analysis text', async () => {
    const registerObservationReviewLease = vi.fn(async () => ({
      leaseId: 'lease-1',
      expiresAtMs: Date.now() + 30_000,
    }));
    const sendApprovedImageObservation = vi.fn(async (input) => {
      const evidence = await input.evidenceResolver.resolve({
        authority: input.authority,
        range: input.range,
        evidenceIds: input.evidenceIds,
        allowedModalities: ['image'],
        signal: input.signal!,
      });
      expect(evidence?.map((item: ObservationEvidencePayload) => [...item.data])).toEqual([
        [1, 2, 3],
        [4, 5],
      ]);
      return {
        ok: true as const,
        requestBytes: 512,
        analysis: {
          text: 'The title remains inside the frame.',
          submittedEvidenceIds: input.evidenceIds,
        },
      };
    });
    const client = {
      registerObservationReviewLease,
      sendApprovedImageObservation,
    } as unknown as Pick<
      JoyAgentEngineClient,
      'registerObservationReviewLease' | 'sendApprovedImageObservation'
    >;
    const transport = createQcPrivateFrameTransport({
      engineClient: client,
      currentAuthority: () => authority,
      now: Date.now,
    });

    await expect(transport.analyze(request())).resolves.toEqual({
      ok: true,
      analysis: 'The title remains inside the frame.',
    });
    expect(registerObservationReviewLease).toHaveBeenCalledWith(
      expect.objectContaining({
        authority,
        manifestId: 'qc-report-run-1-1',
        evidenceIds: ['timeline-frame-1', 'timeline-frame-2'],
        range: { domain: 'composition', startUs: 1_000_000, endUs: 2_000_001 },
      }),
    );
    expect(sendApprovedImageObservation).toHaveBeenCalledTimes(1);
  });

  it('refuses when the run authority is gone before the private transfer', async () => {
    const client = {
      registerObservationReviewLease: vi.fn(),
      sendApprovedImageObservation: vi.fn(),
    } as unknown as Pick<
      JoyAgentEngineClient,
      'registerObservationReviewLease' | 'sendApprovedImageObservation'
    >;
    const transport = createQcPrivateFrameTransport({
      engineClient: client,
      currentAuthority: () => undefined,
    });

    await expect(transport.analyze(request())).resolves.toEqual({ ok: false });
    expect(client.registerObservationReviewLease).not.toHaveBeenCalled();
  });
});
