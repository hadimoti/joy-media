import { describe, expect, it } from 'vitest';
import {
  ObservationConsentRegistry,
  issueObservationConsent,
  type ObservationTransferRequest,
} from './observation-consent.js';

function createConsent() {
  return issueObservationConsent(
    {
      projectId: 'project-1',
      runId: 'run-1',
      endpointOrigin: 'https://openrouter.ai',
      modelId: 'openrouter/model-a',
      evidenceIds: ['frame-1', 'frame-2'],
      modalities: ['image'],
      maxRequests: 2,
      maxBytes: 1_000,
      expiresAtMs: 2_000,
    },
    1_000,
  );
}

const request: ObservationTransferRequest = {
  projectId: 'project-1',
  runId: 'run-1',
  endpointUrl: 'https://openrouter.ai/api/v1/chat/completions',
  modelId: 'openrouter/model-a',
  evidenceIds: ['frame-1'],
  modalities: ['image'],
  bytes: 500,
};

describe('observation consent', () => {
  it('sends zero media without a matching host-issued consent', () => {
    const registry = new ObservationConsentRegistry();
    const consent = createConsent();
    expect(registry.authorize(request, 1_100)).toEqual({
      allowed: false,
      reason: 'consent-missing',
    });
    registry.grant(consent);
    expect(registry.authorize(request, 1_100)).toEqual({ allowed: true, remainingRequests: 1 });
  });

  it('invalidates endpoint, model, evidence, modality, and byte expansion', () => {
    const registry = new ObservationConsentRegistry();
    const consent = createConsent();
    registry.grant(consent);
    expect(registry.authorize({ ...request, modelId: 'openrouter/other' }, 1_100)).toEqual({
      allowed: false,
      reason: 'model-mismatch',
    });
    expect(
      registry.authorize({ ...request, endpointUrl: 'https://example.test/chat' }, 1_100),
    ).toEqual({
      allowed: false,
      reason: 'endpoint-mismatch',
    });
    expect(registry.authorize({ ...request, evidenceIds: ['frame-3'] }, 1_100)).toEqual({
      allowed: false,
      reason: 'evidence-mismatch',
    });
    expect(registry.authorize({ ...request, modalities: ['audio'] }, 1_100)).toEqual({
      allowed: false,
      reason: 'modality-mismatch',
    });
    expect(registry.authorize({ ...request, bytes: 1_001 }, 1_100)).toEqual({
      allowed: false,
      reason: 'byte-budget',
    });
  });

  it('expires and cancels approvals so later batches cannot resume after reload-like interruption', () => {
    const registry = new ObservationConsentRegistry();
    const consent = createConsent();
    registry.grant(consent);
    expect(registry.authorize(request, 2_000)).toEqual({ allowed: false, reason: 'expired' });
    registry.grant(createConsent());
    registry.cancel('run-1');
    expect(registry.authorize(request, 1_100)).toEqual({
      allowed: false,
      reason: 'consent-missing',
    });
  });

  it('freezes an issued scope and its collection fields', () => {
    const issued = issueObservationConsent(
      {
        projectId: 'project-immutable',
        runId: 'run-immutable',
        endpointOrigin: 'https://openrouter.ai',
        modelId: 'openrouter/model-a',
        evidenceIds: ['frame-1'],
        modalities: ['image'],
        maxRequests: 1,
        maxBytes: 500,
        expiresAtMs: 2_000,
      },
      1_000,
    );

    expect(Object.isFrozen(issued)).toBe(true);
    expect(Object.isFrozen(issued.evidenceIds)).toBe(true);
    expect(Object.isFrozen(issued.modalities)).toBe(true);
    expect(() => (issued.evidenceIds as string[]).push('frame-forged')).toThrow(TypeError);
  });

  it('rejects a reflected copy of an issued consent', () => {
    const issued = issueObservationConsent(
      {
        projectId: 'project-forged',
        runId: 'run-forged',
        endpointOrigin: 'https://openrouter.ai',
        modelId: 'openrouter/model-a',
        evidenceIds: ['frame-1'],
        modalities: ['image'],
        maxRequests: 1,
        maxBytes: 500,
        expiresAtMs: 2_000,
      },
      1_000,
    );
    const forged = Object.create(
      Object.getPrototypeOf(issued),
      Object.getOwnPropertyDescriptors(issued),
    ) as typeof issued;

    expect(() => new ObservationConsentRegistry().grant(forged)).toThrow(
      'observation consent must be issued by the local host',
    );
  });

  it('does not reset spent budgets when the same issued consent is re-granted', () => {
    const registry = new ObservationConsentRegistry();
    const consent = createConsent();
    const smallRequest = { ...request, bytes: 1 };
    registry.grant(consent);
    expect(registry.authorize(smallRequest, 1_100)).toEqual({
      allowed: true,
      remainingRequests: 1,
    });

    registry.grant(consent);
    expect(registry.authorize(smallRequest, 1_100)).toEqual({
      allowed: true,
      remainingRequests: 0,
    });
    expect(registry.authorize(smallRequest, 1_100)).toEqual({
      allowed: false,
      reason: 'request-budget',
    });
  });

  it('does not let a cancelled issued scope resume later batches', () => {
    const registry = new ObservationConsentRegistry();
    const issued = issueObservationConsent(
      {
        projectId: 'project-cancelled',
        runId: 'run-cancelled',
        endpointOrigin: 'https://openrouter.ai',
        modelId: 'openrouter/model-a',
        evidenceIds: ['frame-1'],
        modalities: ['image'],
        maxRequests: 1,
        maxBytes: 500,
        expiresAtMs: 2_000,
      },
      1_000,
    );

    registry.grant(issued);
    registry.cancel('run-cancelled');
    expect(() => registry.grant(issued)).toThrow('observation consent cannot be reused');
  });

  it('rejects credentials in both consent and transfer endpoints', () => {
    expect(() =>
      issueObservationConsent(
        {
          projectId: 'project-userinfo',
          runId: 'run-userinfo',
          endpointOrigin: 'https://user:secret@openrouter.ai',
          modelId: 'openrouter/model-a',
          evidenceIds: ['frame-1'],
          modalities: ['image'],
          maxRequests: 1,
          maxBytes: 500,
          expiresAtMs: 2_000,
        },
        1_000,
      ),
    ).toThrow('endpointOrigin must be an HTTPS origin without a path');

    const registry = new ObservationConsentRegistry();
    const consent = createConsent();
    registry.grant(consent);
    expect(
      registry.authorize(
        {
          ...request,
          endpointUrl: 'https://user:secret@openrouter.ai/api/v1/chat/completions',
        },
        1_100,
      ),
    ).toEqual({ allowed: false, reason: 'endpoint-mismatch' });
  });
});
