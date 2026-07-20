import { describe, expect, it } from 'vitest';
import { resolveProvider } from './resolution.js';
import { createMockProvider } from './testing.js';
import type { CapabilityRequest, ProviderPolicy } from './types.js';

describe('resolveProvider', () => {
  const createRequest = (overrides?: Partial<CapabilityRequest>): CapabilityRequest => ({
    requestVersion: 1,
    capability: 'speech.transcribe',
    input: { assetId: 'test' },
    constraints: {},
    idempotencyKey: 'test-key',
    ...overrides,
  });

  const createPolicy = (overrides?: Partial<ProviderPolicy>): ProviderPolicy => ({
    allowRemote: true,
    blockedProviders: [],
    blockedCapabilities: [],
    requireLocalFor: [],
    ...overrides,
  });

  it('resolves a single capable provider', () => {
    const provider = createMockProvider('test-provider', ['speech.transcribe']);
    const request = createRequest();
    const policy = createPolicy();

    const result = resolveProvider(request, [provider], policy);

    expect(result.status).toBe('resolved');
    expect(result.provider).toBe(provider);
  });

  it('returns no-eligible when no providers support capability', () => {
    const provider = createMockProvider('test-provider', ['image.generate']);
    const request = createRequest({ capability: 'speech.transcribe' });
    const policy = createPolicy();

    const result = resolveProvider(request, [provider], policy);

    expect(result.status).toBe('no-eligible');
    expect(result.reason).toContain('No providers support');
  });

  it('blocks capability when in blockedCapabilities', () => {
    const provider = createMockProvider('test-provider', ['speech.transcribe']);
    const request = createRequest({ capability: 'speech.transcribe' });
    const policy = createPolicy({ blockedCapabilities: ['speech.transcribe'] });

    const result = resolveProvider(request, [provider], policy);

    expect(result.status).toBe('blocked-by-policy');
    expect(result.reason).toContain('blocked by policy');
  });

  it('blocks provider when in blockedProviders', () => {
    const provider = createMockProvider('blocked-provider', ['speech.transcribe']);
    const request = createRequest();
    const policy = createPolicy({ blockedProviders: ['blocked-provider'] });

    const result = resolveProvider(request, [provider], policy);

    expect(result.status).toBe('blocked-by-policy');
  });

  it('filters by execution preference (local)', () => {
    const local = createMockProvider('local', ['speech.transcribe'], { execution: 'worker-local' });
    const remote = createMockProvider('remote', ['speech.transcribe'], { execution: 'remote-api' });
    const request = createRequest({
      constraints: { executionPreference: ['local'] },
    });
    const policy = createPolicy();

    const result = resolveProvider(request, [local, remote], policy);

    expect(result.status).toBe('resolved');
    expect(result.provider).toBe(local);
  });

  it('filters by execution preference (remote)', () => {
    const local = createMockProvider('local', ['speech.transcribe'], { execution: 'worker-local' });
    const remote = createMockProvider('remote', ['speech.transcribe'], { execution: 'remote-api' });
    const request = createRequest({
      constraints: { executionPreference: ['remote'] },
    });
    const policy = createPolicy();

    const result = resolveProvider(request, [local, remote], policy);

    expect(result.status).toBe('resolved');
    expect(result.provider).toBe(remote);
  });

  it('filters by requiredPrivacy local-only', () => {
    const local = createMockProvider('local', ['speech.transcribe'], {
      execution: 'worker-local',
      privacy: { dataLeavesDevice: false },
    });
    const remote = createMockProvider('remote', ['speech.transcribe'], {
      execution: 'remote-api',
      privacy: { dataLeavesDevice: true },
    });
    const request = createRequest({
      constraints: { requiredPrivacy: 'local-only' },
    });
    const policy = createPolicy();

    const result = resolveProvider(request, [local, remote], policy);

    expect(result.status).toBe('resolved');
    expect(result.provider).toBe(local);
  });

  it('filters by policy allowRemote=false', () => {
    const local = createMockProvider('local', ['speech.transcribe'], { execution: 'worker-local' });
    const remote = createMockProvider('remote', ['speech.transcribe'], { execution: 'remote-api' });
    const request = createRequest();
    const policy = createPolicy({ allowRemote: false });

    const result = resolveProvider(request, [local, remote], policy);

    expect(result.status).toBe('resolved');
    expect(result.provider).toBe(local);
  });

  it('filters by policy requireLocalFor', () => {
    const local = createMockProvider('local', ['speech.transcribe'], { execution: 'worker-local' });
    const remote = createMockProvider('remote', ['speech.transcribe'], { execution: 'remote-api' });
    const request = createRequest({ capability: 'speech.transcribe' });
    const policy = createPolicy({ requireLocalFor: ['speech.transcribe'] });

    const result = resolveProvider(request, [local, remote], policy);

    expect(result.status).toBe('resolved');
    expect(result.provider).toBe(local);
  });

  it('ranks local providers higher than remote', () => {
    const local = createMockProvider('local', ['speech.transcribe'], { execution: 'worker-local' });
    const remote = createMockProvider('remote', ['speech.transcribe'], { execution: 'remote-api' });
    const request = createRequest();
    const policy = createPolicy();

    const result = resolveProvider(request, [remote, local], policy);

    expect(result.status).toBe('resolved');
    expect(result.provider).toBe(local);
  });

  it('returns multiple candidates', () => {
    const provider1 = createMockProvider('p1', ['speech.transcribe']);
    const provider2 = createMockProvider('p2', ['speech.transcribe']);
    const request = createRequest();
    const policy = createPolicy();

    const result = resolveProvider(request, [provider1, provider2], policy);

    expect(result.status).toBe('resolved');
    expect(result.candidates).toHaveLength(2);
  });
});
