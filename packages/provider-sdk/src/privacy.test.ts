import { describe, expect, it } from 'vitest';
import {
  computePrivacyPreflight,
  computeProviderApprovalPreflight,
  computeProviderRequestDigest,
} from './privacy.js';
import { createMockProvider } from './testing.js';
import type { CapabilityRequest } from './types.js';

describe('computePrivacyPreflight', () => {
  const createRequest = (overrides?: Partial<CapabilityRequest>): CapabilityRequest => ({
    requestVersion: 1,
    capability: 'speech.transcribe',
    input: { assetId: 'test' },
    constraints: {},
    idempotencyKey: 'test-key',
    ...overrides,
  });

  it('computes preflight for local provider', () => {
    const provider = createMockProvider('local-provider', ['speech.transcribe'], {
      execution: 'worker-local',
      privacy: { dataLeavesDevice: false },
    });
    const request = createRequest();

    const preflight = computePrivacyPreflight(request, provider);

    expect(preflight.providerId).toBe('local-provider');
    expect(preflight.capability).toBe('speech.transcribe');
    expect(preflight.dataLeavesDevice).toBe(false);
    expect(preflight.dataBeingSent).toContain('audio data');
    expect(preflight.purpose).toBe('Transcribe audio to text');
    expect(preflight.estimatedSizeBytes).toBeGreaterThan(0);
    expect(preflight.transformations).toContain('audio-only extraction');
    expect(preflight.requiresUserApproval).toBe(false);
  });

  it('computes preflight for remote provider', () => {
    const provider = createMockProvider('remote-provider', ['speech.transcribe'], {
      execution: 'remote-api',
      privacy: { dataLeavesDevice: true },
    });
    const request = createRequest();

    const preflight = computePrivacyPreflight(request, provider);

    expect(preflight.providerId).toBe('remote-provider');
    expect(preflight.dataLeavesDevice).toBe(true);
    expect(preflight.transformations).toContain('remote API call');
    expect(preflight.requiresUserApproval).toBe(true);
  });

  it('handles depends privacy with remote execution', () => {
    const provider = createMockProvider('depends-provider', ['speech.transcribe'], {
      execution: 'remote-api',
      privacy: { dataLeavesDevice: 'depends' },
    });
    const request = createRequest();

    const preflight = computePrivacyPreflight(request, provider);

    expect(preflight.dataLeavesDevice).toBe(true);
    expect(preflight.requiresUserApproval).toBe(true);
  });

  it('handles depends privacy with local execution', () => {
    const provider = createMockProvider('depends-provider', ['speech.transcribe'], {
      execution: 'worker-local',
      privacy: { dataLeavesDevice: 'depends' },
    });
    const request = createRequest();

    const preflight = computePrivacyPreflight(request, provider);

    expect(preflight.dataLeavesDevice).toBe(false);
    expect(preflight.requiresUserApproval).toBe(false);
  });

  it('includes estimated cost when pricing is available', () => {
    const provider = createMockProvider('priced-provider', ['speech.transcribe']);
    // Mock provider doesn't have pricing by default, so estimatedCost should be undefined
    const request = createRequest();

    const preflight = computePrivacyPreflight(request, provider);

    expect(preflight.estimatedCost).toBeUndefined();
  });

  it('includes retention disclosure when available', () => {
    const provider = createMockProvider('retention-provider', ['speech.transcribe'], {
      privacy: {
        dataLeavesDevice: true,
        retentionDisclosure: 'Data retained for 30 days',
      },
    });
    const request = createRequest();

    const preflight = computePrivacyPreflight(request, provider);

    expect(preflight.retentionDisclosure).toBe('Data retained for 30 days');
  });

  it('handles v1 provider (backward compatibility)', () => {
    const v1Provider = {
      manifest: {
        id: 'v1-provider',
        version: 1 as const,
        capabilities: ['speech.transcribe' as const] as const,
      },
      invoke: async () => {
        throw new Error('Not implemented');
      },
    };
    const request = createRequest();

    const preflight = computePrivacyPreflight(request, v1Provider);

    expect(preflight.providerId).toBe('v1-provider');
    expect(preflight.dataLeavesDevice).toBe(false);
    expect(preflight.requiresUserApproval).toBe(false);
  });

  it('returns correct data types for different capabilities', () => {
    const provider = createMockProvider('test', ['image.generate']);
    const request = createRequest({ capability: 'image.generate' });

    const preflight = computePrivacyPreflight(request, provider);

    expect(preflight.dataBeingSent).toContain('text prompt');
    expect(preflight.purpose).toBe('Generate image from prompt');
  });

  it('binds approval preflight digests to actor and request payload without exposing input', () => {
    const provider = createMockProvider('remote-provider', ['llm.complete'], {
      execution: 'remote-api',
      privacy: { dataLeavesDevice: true },
    });
    const request = createRequest({
      capability: 'llm.complete',
      input: { prompt: 'private prompt' },
    });

    const first = computeProviderApprovalPreflight('actor-1', request, provider);
    const same = computeProviderApprovalPreflight('actor-1', { ...request }, provider);
    const otherActor = computeProviderApprovalPreflight('actor-2', request, provider);
    const otherPrompt = computeProviderApprovalPreflight(
      'actor-1',
      { ...request, input: { prompt: 'different prompt' } },
      provider,
    );

    expect(first.requestDigest).toBe(same.requestDigest);
    expect(first.requestDigest).not.toBe(otherActor.requestDigest);
    expect(first.requestDigest).not.toBe(otherPrompt.requestDigest);
    expect(first.requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.requiresUserApproval).toBe(true);
    expect(JSON.stringify(first)).not.toContain('private prompt');
  });

  it('computes stable request digests independent of object key insertion order', () => {
    const left = createRequest({ input: { b: 2, a: 1 } });
    const right = createRequest({ input: { a: 1, b: 2 } });

    expect(computeProviderRequestDigest(left)).toBe(computeProviderRequestDigest(right));
  });
});
