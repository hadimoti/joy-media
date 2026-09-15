import { describe, expect, it } from 'vitest';
import {
  MAX_MULTIMODAL_ANALYSIS_TEXT_BYTES,
  MAX_MULTIMODAL_BATCH_EVIDENCE_BYTES,
  MAX_MULTIMODAL_EVIDENCE_BYTES,
  MAX_MULTIMODAL_EVIDENCE_PER_BATCH,
  MAX_MULTIMODAL_REQUEST_BYTES,
} from './multimodal-transport.js';
import {
  createPrivateObservationPortBind,
  isPrivateObservationMainToWorkerMessage,
  isPrivateObservationPortBind,
  isPrivateObservationTransferResult,
  isPrivateObservationWorkerToMainMessage,
} from './observation-transfer-port-protocol.js';

const expiresAtMs = 2_000_000_000_000;

function authority() {
  return {
    projectId: 'project-1',
    revision: 'revision-1',
    run: { runId: 'run-1', epoch: 1 },
    modelId: 'openrouter/model-a',
    promptPolicyDigest: 'policy-1',
  } as const;
}

function range() {
  return { domain: 'source' as const, startUs: 0, endUs: 1_000_000 };
}

function registerLease() {
  return {
    type: 'register-review-lease' as const,
    requestId: 'request-1',
    sessionEpoch: 1,
    authority: authority(),
    manifestId: 'manifest-1',
    range: range(),
    evidenceIds: ['frame-1'],
    expiresAtMs,
  };
}

function start() {
  return {
    type: 'start' as const,
    transferId: 'transfer-1',
    sessionEpoch: 1,
    leaseId: 'lease-1',
    authority: authority(),
    range: range(),
    evidenceIds: ['frame-1'],
    maxBytes: 1_024,
    expiresAtMs,
    prompt: 'Inspect the explicitly approved image evidence.',
  };
}

function evidence(data = new ArrayBuffer(3), evidenceId = 'frame-1') {
  return {
    type: 'evidence' as const,
    transferId: 'transfer-1',
    sessionEpoch: 1,
    evidence: [{ evidenceId, mimeType: 'image/png', data }],
  };
}

function result() {
  return {
    type: 'result' as const,
    transferId: 'transfer-1',
    sessionEpoch: 1,
    result: {
      ok: true as const,
      requestBytes: 1_024,
      analysis: {
        text: 'The approved image contains a title card.',
        submittedEvidenceIds: ['frame-1'],
      },
    },
  };
}

describe('private observation transfer MessagePort protocol', () => {
  it('keeps the bind control keyless and rejects malformed or expanded control packets', () => {
    const bind = createPrivateObservationPortBind(1);
    expect(isPrivateObservationPortBind(bind)).toBe(true);
    expect(isPrivateObservationPortBind({ ...bind, apiKey: 'never-accepted' })).toBe(false);
    expect(isPrivateObservationPortBind({ ...bind, endpoint: 'https://provider.example' })).toBe(
      false,
    );
    expect(isPrivateObservationPortBind({ ...bind, clientGeneration: 0 })).toBe(false);
    expect(isPrivateObservationPortBind({ ...bind, version: 2 })).toBe(false);
  });

  it('accepts raw ArrayBuffers only in the private image evidence packet', () => {
    const raw = new ArrayBuffer(3);
    expect(isPrivateObservationMainToWorkerMessage(registerLease())).toBe(true);
    expect(isPrivateObservationMainToWorkerMessage(start())).toBe(true);
    expect(isPrivateObservationMainToWorkerMessage(evidence(raw))).toBe(true);
    expect(
      isPrivateObservationMainToWorkerMessage({
        ...registerLease(),
        data: raw,
      }),
    ).toBe(false);
    expect(isPrivateObservationMainToWorkerMessage({ ...start(), data: raw })).toBe(false);
    expect(
      isPrivateObservationMainToWorkerMessage({
        type: 'cancel',
        transferId: 'transfer-1',
        sessionEpoch: 1,
        data: raw,
      }),
    ).toBe(false);
    expect(isPrivateObservationWorkerToMainMessage({ ...result(), data: raw })).toBe(false);
  });

  it('rejects hostile transport fields and malformed authority, range, and identifier packets', () => {
    for (const expanded of [
      { ...registerLease(), apiKey: 'never-accepted' },
      { ...registerLease(), baseUrl: 'https://provider.example/v1' },
      { ...start(), connection: { apiKey: 'never-accepted' } },
      { ...start(), evidenceIds: ['frame-1', 'frame-1'] },
      { ...start(), prompt: 'unsafe\u0000prompt' },
      { ...start(), authority: { ...authority(), run: { runId: 'run-1', epoch: 0 } } },
      { ...start(), range: { domain: 'audio', startUs: 0, endUs: 1_000 } },
      { ...start(), range: { domain: 'source', startUs: 1_000, endUs: 1_000 } },
    ])
      expect(isPrivateObservationMainToWorkerMessage(expanded)).toBe(false);
  });

  it('enforces image-only evidence plus per-item, batch, and count bounds', () => {
    expect(
      isPrivateObservationMainToWorkerMessage({
        ...evidence(),
        evidence: [{ evidenceId: 'frame-1', mimeType: 'video/mp4', data: new ArrayBuffer(3) }],
      }),
    ).toBe(false);
    expect(
      isPrivateObservationMainToWorkerMessage({
        ...evidence(),
        evidence: [
          { evidenceId: 'frame-1', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) },
        ],
      }),
    ).toBe(false);
    expect(
      isPrivateObservationMainToWorkerMessage({
        ...evidence(),
        evidence: [
          {
            evidenceId: 'frame-1',
            mimeType: 'image/png',
            data: new ArrayBuffer(MAX_MULTIMODAL_EVIDENCE_BYTES + 1),
          },
        ],
      }),
    ).toBe(false);
    expect(
      isPrivateObservationMainToWorkerMessage({
        ...evidence(),
        evidence: [
          {
            evidenceId: 'frame-1',
            mimeType: 'image/png',
            data: new ArrayBuffer(Math.floor(MAX_MULTIMODAL_BATCH_EVIDENCE_BYTES / 2) + 1),
          },
          {
            evidenceId: 'frame-2',
            mimeType: 'image/jpeg',
            data: new ArrayBuffer(Math.floor(MAX_MULTIMODAL_BATCH_EVIDENCE_BYTES / 2) + 1),
          },
        ],
      }),
    ).toBe(false);
    expect(
      isPrivateObservationMainToWorkerMessage({
        ...evidence(),
        evidence: Array.from({ length: MAX_MULTIMODAL_EVIDENCE_PER_BATCH + 1 }, (_, index) => ({
          evidenceId: `frame-${index + 1}`,
          mimeType: 'image/png',
          data: new ArrayBuffer(1),
        })),
      }),
    ).toBe(false);
  });

  it('accepts bounded redacted results and rejects provider-shaped output or unsafe analysis', () => {
    const success = result();
    expect(isPrivateObservationWorkerToMainMessage(success)).toBe(true);
    expect(isPrivateObservationTransferResult(success.result)).toBe(true);
    for (const expanded of [
      { ...success, endpoint: 'https://provider.example' },
      { ...success, apiKey: 'never-accepted' },
      { ...success, result: { ...success.result, rawProviderBody: 'never-accepted' } },
      {
        ...success,
        result: { ...success.result, requestBytes: MAX_MULTIMODAL_REQUEST_BYTES + 1 },
      },
      {
        ...success,
        result: {
          ...success.result,
          analysis: {
            ...success.result.analysis,
            text: 'x'.repeat(MAX_MULTIMODAL_ANALYSIS_TEXT_BYTES + 1),
          },
        },
      },
      {
        ...success,
        result: {
          ...success.result,
          analysis: { ...success.result.analysis, submittedEvidenceIds: ['frame-1', 'frame-1'] },
        },
      },
      {
        ...success,
        result: {
          ...success.result,
          analysis: {
            ...success.result.analysis,
            text: 'Provider said https://provider.example/private',
          },
        },
      },
      {
        ...success,
        result: {
          ...success.result,
          analysis: { ...success.result.analysis, text: 'authorization: never-accepted' },
        },
      },
    ])
      expect(isPrivateObservationWorkerToMainMessage(expanded)).toBe(false);

    expect(
      isPrivateObservationWorkerToMainMessage({
        type: 'result',
        transferId: 'transfer-1',
        sessionEpoch: 1,
        result: { ok: false, code: 'network-failed' },
      }),
    ).toBe(true);
    expect(
      isPrivateObservationWorkerToMainMessage({
        type: 'result',
        transferId: 'transfer-1',
        sessionEpoch: 1,
        result: { ok: false, code: 'provider-error' },
      }),
    ).toBe(false);
  });
});
