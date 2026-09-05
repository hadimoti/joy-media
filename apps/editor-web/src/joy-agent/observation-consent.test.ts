import { describe, expect, it } from 'vitest';
import {
  ObservationConsentRegistry,
  issueObservationConsent,
  type ObservationTransferRequest,
} from './observation-consent.js';

const consent = issueObservationConsent(
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
    expect(registry.authorize(request, 1_100)).toEqual({
      allowed: false,
      reason: 'consent-missing',
    });
    registry.grant(consent);
    expect(registry.authorize(request, 1_100)).toEqual({ allowed: true, remainingRequests: 1 });
  });

  it('invalidates endpoint, model, evidence, modality, and byte expansion', () => {
    const registry = new ObservationConsentRegistry();
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
    registry.grant(consent);
    expect(registry.authorize(request, 2_000)).toEqual({ allowed: false, reason: 'expired' });
    registry.grant(consent);
    registry.cancel('run-1');
    expect(registry.authorize(request, 1_100)).toEqual({
      allowed: false,
      reason: 'consent-missing',
    });
  });
});
