import { describe, expect, it } from 'vitest';
import {
  ObservationConsentRegistry,
  issueObservationConsent,
  type ObservationConsent,
  type ObservationMediaCapability,
  type ObservationTransferRequest,
} from './observation-consent.js';

const imageCapability: ObservationMediaCapability = {
  modelId: 'openrouter/model-a',
  modalities: ['image'],
};

function consentInput(overrides: Partial<ObservationConsent> = {}): ObservationConsent {
  return {
    projectId: 'project-1',
    runId: 'run-1',
    endpointOrigin: 'https://openrouter.ai',
    modelId: 'openrouter/model-a',
    range: { domain: 'source', startUs: 100_000, endUs: 900_000 },
    evidenceIds: ['frame-1', 'frame-2'],
    modalities: ['image'],
    maxRequests: 2,
    maxBytes: 1_000,
    expiresAtMs: 2_000,
    ...overrides,
  };
}

function createConsent(
  overrides: Partial<ObservationConsent> = {},
  capability: ObservationMediaCapability = imageCapability,
) {
  return issueObservationConsent(consentInput(overrides), capability, 1_000);
}

const request: ObservationTransferRequest = {
  projectId: 'project-1',
  runId: 'run-1',
  endpointUrl: 'https://openrouter.ai/api/v1/chat/completions',
  modelId: 'openrouter/model-a',
  range: { domain: 'source', startUs: 200_000, endUs: 500_000 },
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

  it('invalidates origin, model, range, evidence, modality, and budget expansion', () => {
    const registry = new ObservationConsentRegistry();
    registry.grant(createConsent());
    expect(
      registry.authorize({ ...request, endpointUrl: 'https://openrouter.ai.evil/chat' }, 1_100),
    ).toEqual({ allowed: false, reason: 'endpoint-mismatch' });
    expect(registry.authorize({ ...request, modelId: 'openrouter/other' }, 1_100)).toEqual({
      allowed: false,
      reason: 'model-mismatch',
    });
    expect(
      registry.authorize(
        { ...request, range: { domain: 'source', startUs: 99_999, endUs: 500_000 } },
        1_100,
      ),
    ).toEqual({ allowed: false, reason: 'range-mismatch' });
    expect(
      registry.authorize(
        { ...request, range: { domain: 'composition', startUs: 200_000, endUs: 500_000 } },
        1_100,
      ),
    ).toEqual({ allowed: false, reason: 'range-mismatch' });
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

  it('expires, revokes, and does not restore approval in a fresh in-memory registry', () => {
    const registry = new ObservationConsentRegistry();
    const consent = createConsent();
    registry.grant(consent);
    expect(registry.authorize(request, 2_000)).toEqual({ allowed: false, reason: 'expired' });

    const renewed = createConsent({ expiresAtMs: 3_000 });
    registry.grant(renewed);
    expect(registry.revoke('run-1')).toBe(true);
    expect(registry.cancel('run-1')).toBe(false);
    expect(registry.authorize(request, 1_100)).toEqual({
      allowed: false,
      reason: 'consent-missing',
    });
    expect(new ObservationConsentRegistry().authorize(request, 1_100)).toEqual({
      allowed: false,
      reason: 'consent-missing',
    });
  });

  it('freezes and canonicalizes the issued scope', () => {
    const issued = createConsent({
      runId: 'run-immutable',
      evidenceIds: ['frame-2', 'frame-1', 'frame-2'],
      range: { domain: 'composition', startUs: 1, endUs: 2 },
    });

    expect(Object.isFrozen(issued)).toBe(true);
    expect(Object.isFrozen(issued.range)).toBe(true);
    expect(issued.evidenceIds).toEqual(['frame-1', 'frame-2']);
    expect(Object.isFrozen(issued.evidenceIds)).toBe(true);
    expect(Object.isFrozen(issued.modalities)).toBe(true);
    expect(() => (issued.evidenceIds as string[]).push('frame-forged')).toThrow(TypeError);
    expect(() => ((issued.range as { startUs: number }).startUs = 0)).toThrow(TypeError);
  });

  it('rejects reflected model JSON rather than letting it grant consent', () => {
    const issued = createConsent({ runId: 'run-forged' });
    const forged = Object.create(
      Object.getPrototypeOf(issued),
      Object.getOwnPropertyDescriptors(issued),
    ) as typeof issued;

    expect(() => new ObservationConsentRegistry().grant(forged)).toThrow(
      'observation consent must be issued by the local host',
    );
  });

  it('does not reset spent budgets or let a revoked issued scope resume', () => {
    const registry = new ObservationConsentRegistry();
    const consent = createConsent({ runId: 'run-budget' });
    const budgetRequest = { ...request, runId: 'run-budget', bytes: 1 };
    registry.grant(consent);
    expect(registry.authorize(budgetRequest, 1_100)).toEqual({
      allowed: true,
      remainingRequests: 1,
    });
    registry.grant(consent);
    expect(registry.authorize(budgetRequest, 1_100)).toEqual({
      allowed: true,
      remainingRequests: 0,
    });
    expect(registry.authorize(budgetRequest, 1_100)).toEqual({
      allowed: false,
      reason: 'request-budget',
    });
    registry.revoke('run-budget');
    expect(() => registry.grant(consent)).toThrow('observation consent cannot be reused');
  });

  it('accepts only HTTPS or localhost origins and rejects malformed endpoint URLs', () => {
    expect(() => createConsent({ endpointOrigin: 'http://example.test' })).toThrow(
      'HTTPS or localhost origin',
    );
    expect(() => createConsent({ endpointOrigin: 'https://user:secret@openrouter.ai' })).toThrow(
      'HTTPS or localhost origin',
    );
    expect(() => createConsent({ endpointOrigin: 'https://openrouter.ai/api/v1' })).toThrow(
      'HTTPS or localhost origin',
    );

    const registry = new ObservationConsentRegistry();
    registry.grant(createConsent({ endpointOrigin: 'http://localhost:4010' }));
    expect(
      registry.authorize(
        { ...request, endpointUrl: 'http://localhost:4010/v1/chat/completions' },
        1_100,
      ),
    ).toEqual({ allowed: true, remainingRequests: 1 });
    expect(registry.authorize({ ...request, endpointUrl: 'not a url' }, 1_100)).toEqual({
      allowed: false,
      reason: 'invalid-request',
    });
    expect(
      registry.authorize(
        { ...request, endpointUrl: 'https://openrouter.ai/api/v1?token=not-allowed' },
        1_100,
      ),
    ).toEqual({ allowed: false, reason: 'invalid-request' });
  });

  it('does not issue image consent for a text-only or mismatched model capability', () => {
    expect(() => createConsent({}, { modelId: 'openrouter/model-a', modalities: [] })).toThrow(
      'does not have the requested media capability',
    );
    expect(() =>
      createConsent({}, { modelId: 'openrouter/model-b', modalities: ['image'] }),
    ).toThrow('must exactly match consent modelId');
  });
});
