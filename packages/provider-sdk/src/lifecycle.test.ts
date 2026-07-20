import { describe, expect, it } from 'vitest';
import { ProviderLifecycle } from './lifecycle.js';
import { createMockProvider } from './testing.js';

describe('ProviderLifecycle', () => {
  it('registers a provider with configured state', () => {
    const lifecycle = new ProviderLifecycle();
    const provider = createMockProvider('test-provider', ['speech.transcribe']);

    lifecycle.register(provider);
    const status = lifecycle.getStatus('test-provider');

    expect(status.providerId).toBe('test-provider');
    expect(status.state).toBe('configured');
    expect(status.activeJobs).toBe(0);
    expect(status.consecutiveFailures).toBe(0);
  });

  it('does not re-register an already registered provider', () => {
    const lifecycle = new ProviderLifecycle();
    const provider = createMockProvider('test-provider', ['speech.transcribe']);

    lifecycle.register(provider);
    lifecycle.markHealthy('test-provider');
    lifecycle.register(provider); // Should be ignored

    const status = lifecycle.getStatus('test-provider');
    expect(status.state).toBe('healthy');
  });

  it('throws when getting status of unregistered provider', () => {
    const lifecycle = new ProviderLifecycle();
    expect(() => lifecycle.getStatus('unknown')).toThrow('not registered');
  });

  it('marks provider as healthy', () => {
    const lifecycle = new ProviderLifecycle();
    const provider = createMockProvider('test-provider', ['speech.transcribe']);
    lifecycle.register(provider);

    lifecycle.markHealthy('test-provider');
    const status = lifecycle.getStatus('test-provider');

    expect(status.state).toBe('healthy');
    expect(status.lastHealthCheck).toBeDefined();
    expect(status.consecutiveFailures).toBe(0);
  });

  it('marks provider as degraded', () => {
    const lifecycle = new ProviderLifecycle();
    const provider = createMockProvider('test-provider', ['speech.transcribe']);
    lifecycle.register(provider);

    lifecycle.markDegraded('test-provider', 'High latency');
    const status = lifecycle.getStatus('test-provider');

    expect(status.state).toBe('degraded');
    expect(status.lastError).toBe('High latency');
    expect(status.consecutiveFailures).toBe(1);
  });

  it('marks provider as offline', () => {
    const lifecycle = new ProviderLifecycle();
    const provider = createMockProvider('test-provider', ['speech.transcribe']);
    lifecycle.register(provider);

    lifecycle.markOffline('test-provider', 'Connection lost');
    const status = lifecycle.getStatus('test-provider');

    expect(status.state).toBe('offline');
    expect(status.lastError).toBe('Connection lost');
  });

  it('tracks job start and end', () => {
    const lifecycle = new ProviderLifecycle();
    const provider = createMockProvider('test-provider', ['speech.transcribe']);
    lifecycle.register(provider);

    lifecycle.recordJobStart('test-provider');
    expect(lifecycle.getStatus('test-provider').activeJobs).toBe(1);

    lifecycle.recordJobStart('test-provider');
    expect(lifecycle.getStatus('test-provider').activeJobs).toBe(2);

    lifecycle.recordJobEnd('test-provider', true);
    expect(lifecycle.getStatus('test-provider').activeJobs).toBe(1);
    expect(lifecycle.getStatus('test-provider').consecutiveFailures).toBe(0);
  });

  it('increments consecutiveFailures on job failure', () => {
    const lifecycle = new ProviderLifecycle();
    const provider = createMockProvider('test-provider', ['speech.transcribe']);
    lifecycle.register(provider);

    lifecycle.recordJobStart('test-provider');
    lifecycle.recordJobEnd('test-provider', false);
    expect(lifecycle.getStatus('test-provider').consecutiveFailures).toBe(1);

    lifecycle.recordJobStart('test-provider');
    lifecycle.recordJobEnd('test-provider', false);
    expect(lifecycle.getStatus('test-provider').consecutiveFailures).toBe(2);
  });

  it('resets consecutiveFailures on successful job', () => {
    const lifecycle = new ProviderLifecycle();
    const provider = createMockProvider('test-provider', ['speech.transcribe']);
    lifecycle.register(provider);

    lifecycle.recordJobStart('test-provider');
    lifecycle.recordJobEnd('test-provider', false);
    expect(lifecycle.getStatus('test-provider').consecutiveFailures).toBe(1);

    lifecycle.recordJobStart('test-provider');
    lifecycle.recordJobEnd('test-provider', true);
    expect(lifecycle.getStatus('test-provider').consecutiveFailures).toBe(0);
  });

  it('returns all statuses', () => {
    const lifecycle = new ProviderLifecycle();
    const provider1 = createMockProvider('p1', ['speech.transcribe']);
    const provider2 = createMockProvider('p2', ['image.generate']);

    lifecycle.register(provider1);
    lifecycle.register(provider2);

    const statuses = lifecycle.getAllStatuses();
    expect(statuses).toHaveLength(2);
    expect(statuses.map((s) => s.providerId).sort()).toEqual(['p1', 'p2']);
  });

  it('extracts model versions from v2 provider', () => {
    const lifecycle = new ProviderLifecycle();
    const provider = createMockProvider('test-provider', ['speech.transcribe']);
    // Mock provider doesn't have models by default, so modelVersions should be undefined
    lifecycle.register(provider);
    const status = lifecycle.getStatus('test-provider');
    expect(status.modelVersions).toBeUndefined();
  });
});
