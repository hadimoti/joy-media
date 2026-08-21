import { describe, expect, it } from 'vitest';
import { decideProvider } from './decision.js';
import { createMockProvider } from './testing.js';
import type {
  CapabilityDeclaration,
  CapabilityRequest,
  ProviderPolicy,
  ProviderV2,
} from './types.js';

describe('decideProvider', () => {
  const request = (overrides?: Partial<CapabilityRequest>): CapabilityRequest => ({
    requestVersion: 1,
    capability: 'speech.transcribe',
    input: { assetId: 'asset-1' },
    constraints: {},
    idempotencyKey: 'idem-1',
    ...overrides,
  });

  const policy = (overrides?: Partial<ProviderPolicy>): ProviderPolicy => ({
    allowRemote: true,
    blockedProviders: [],
    blockedCapabilities: [],
    requireLocalFor: [],
    ...overrides,
  });

  const pricedProvider = (
    id: string,
    overrides?: Partial<CapabilityDeclaration> & {
      readonly execution?: ProviderV2['manifest']['execution'];
      readonly dataLeavesDevice?: boolean | 'depends';
    },
  ): ProviderV2 => {
    const providerOptions = {
      ...(overrides?.execution === undefined ? {} : { execution: overrides.execution }),
      privacy: { dataLeavesDevice: overrides?.dataLeavesDevice ?? false },
    };
    const provider = createMockProvider(id, ['speech.transcribe'], providerOptions);
    return {
      ...provider,
      manifest: {
        ...provider.manifest,
        capabilities: [
          {
            ...provider.manifest.capabilities[0]!,
            ...overrides,
            id: 'speech.transcribe',
            inputSchema: {},
            outputSchema: {},
          },
        ],
      },
    };
  };

  it('records a seven-dimension score breakdown after hard gates', () => {
    const provider = pricedProvider('local-fast', {
      pricing: { model: 'per-request', rate: '0.05', currency: 'USD' },
      estimatedResources: { estimatedDurationMs: 500 },
    });

    const decision = decideProvider(request(), [provider], policy());

    expect(decision.status).toBe('selected');
    expect(decision.selectedProviderId).toBe('local-fast');
    expect(decision.candidates).toHaveLength(1);
    expect(decision.candidates[0]!.status).toBe('eligible');
    expect(Object.keys(decision.candidates[0]!.scoreBreakdown!.dimensions)).toEqual([
      'capability',
      'privacy',
      'locality',
      'preference',
      'cost',
      'latency',
      'availability',
    ]);
    expect(decision.candidates[0]!.scoreBreakdown!.total).toBeGreaterThan(0);
  });

  it('applies hard capability and privacy gates before scoring', () => {
    const imageOnly = createMockProvider('image-only', ['image.generate']);
    const remote = pricedProvider('remote', {
      execution: 'remote-api',
      dataLeavesDevice: true,
    });

    const decision = decideProvider(
      request({ constraints: { requiredPrivacy: 'local-only' } }),
      [imageOnly, remote],
      policy(),
    );

    expect(decision.status).toBe('denied');
    expect(decision.candidates).toEqual([
      expect.objectContaining({
        providerId: 'image-only',
        status: 'rejected',
        rejectedBy: 'capability',
      }),
      expect.objectContaining({
        providerId: 'remote',
        status: 'rejected',
        rejectedBy: 'privacy',
      }),
    ]);
    expect(decision.candidates.every((candidate) => candidate.scoreBreakdown === undefined)).toBe(
      true,
    );
  });

  it('chooses local over remote by default while keeping both eligible', () => {
    const remote = pricedProvider('remote', { execution: 'remote-api', dataLeavesDevice: true });
    const local = pricedProvider('local', { execution: 'worker-local', dataLeavesDevice: false });

    const decision = decideProvider(request(), [remote, local], policy());

    expect(decision.status).toBe('selected');
    expect(decision.selectedProviderId).toBe('local');
    expect(decision.candidates.map((candidate) => candidate.providerId)).toEqual([
      'local',
      'remote',
    ]);
  });

  it('requires manual choice for an exact top-score tie when configured', () => {
    const first = pricedProvider('first');
    const second = pricedProvider('second');

    const decision = decideProvider(request(), [first, second], policy(), {
      requireManualChoiceOnTie: true,
    });

    expect(decision.status).toBe('manual-choice-required');
    expect(decision.selectedProviderId).toBeUndefined();
    expect(decision.reason).toContain('tie');
  });

  it('reports unavailable and denied outcomes', () => {
    const provider = pricedProvider('remote', { execution: 'remote-api', dataLeavesDevice: true });

    expect(
      decideProvider(request(), [provider], policy(), {
        unavailableProviderIds: ['remote'],
      }).status,
    ).toBe('unavailable');
    expect(
      decideProvider(request(), [provider], policy(), {
        deniedProviderIds: ['remote'],
      }).status,
    ).toBe('denied');
  });

  it('links the decision to a production run and provider usage', () => {
    const provider = pricedProvider('remote', { execution: 'remote-api', dataLeavesDevice: true });

    const decision = decideProvider(request(), [provider], policy(), {
      productionRunId: 'run-1',
      providerUsage: {
        providerId: 'remote',
        capability: 'speech.transcribe',
        modelId: 'speech-large',
        timestamp: '2026-08-22T00:00:00.000Z',
        durationMs: 12,
      },
    });

    expect(decision.productionRunId).toBe('run-1');
    expect(decision.providerUsage?.providerDecisionId).toBe(decision.decisionId);
    expect(decision.providerUsage?.productionRunId).toBe('run-1');
  });
});
