/**
 * OpenRouter Creative Brief Adapter Tests - WP-37 S4-F10-A
 *
 * Focused tests for the fail-closed OpenRouter adapter core.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OpenRouterCreativeAdapter,
  createOpenRouterCreativeAdapter,
} from './index.js';
import type {
  SecretResolver,
  HttpPostTransport,
  Clock,
  OpenRouterAdapterOptions,
} from './index.js';
import type { AsyncCreativeModelAdapter, AsyncAdapterOptions, AsyncOutcome } from '@joy-media/agent-tools';

// ============================================================================
// Test Fixtures
// ============================================================================

const MOCK_INPUT = {
  snapshot: {},
  brandReadiness: {},
  sceneCoverages: [],
  projectReadiness: {},
  rules: [],
  request: {},
} as const;

const MOCK_OPTIONS: AsyncAdapterOptions = {
  correlationId: 'test-correlation-id',
};

// Mock secret resolver that can be configured
class MockSecretResolver implements SecretResolver {
  #secrets: Map<string, string>;
  #resolveCount: Map<string, number> = new Map();

  constructor(secrets: Record<string, string | undefined> = {}) {
    this.#secrets = new Map(Object.entries(secrets).map(([k, v]) => [k, v ?? '']));
  }

  resolve(ref: string): string | undefined {
    const count = (this.#resolveCount.get(ref) ?? 0) + 1;
    this.#resolveCount.set(ref, count);
    const value = this.#secrets.get(ref);
    return value === '' ? undefined : value;
  }

  getResolveCount(ref: string): number {
    return this.#resolveCount.get(ref) ?? 0;
  }
}

// Mock HTTP transport that tracks calls
class MockHttpTransport implements HttpPostTransport {
  #calls: Array<{ url: string; options: RequestInit }> = [];

  async post(url: string, options: RequestInit): Promise<Response> {
    this.#calls.push({ url, options });
    return new Response(JSON.stringify({}), { status: 200 });
  }

  getCallCount(): number {
    return this.#calls.length;
  }

  getCalls(): Array<{ url: string; options: RequestInit }> {
    return [...this.#calls];
  }
}

// Mock clock for deterministic testing
class MockClock implements Clock {
  #nowValue: number;

  constructor(nowValue: number = 0) {
    this.#nowValue = nowValue;
  }

  now(): number {
    return this.#nowValue;
  }

  advance(ms: number): void {
    this.#nowValue += ms;
  }
}

function createAdapterOptions(
  overrides: Partial<OpenRouterAdapterOptions> = {},
): OpenRouterAdapterOptions {
  return {
    modelId: 'openrouter/mistral-large',
    timeoutMs: 60000,
    spendLimitUsdCents: 500,
    secretRef: 'openrouter-api-key',
    ...overrides,
  };
}

// ============================================================================
// Public Adapter Construction
// ============================================================================

describe('OpenRouterCreativeAdapter - public construction', () => {
  it('should create adapter with required options', () => {
    const adapter = new OpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
    });
    expect(adapter).toBeInstanceOf(OpenRouterCreativeAdapter);
    expect(adapter.adapterName).toBe('openrouter-creative-v1');
    expect(adapter.isTestOnly).toBe(false);
  });

  it('should create adapter via factory function', () => {
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
    });
    expect(adapter).toBeInstanceOf(OpenRouterCreativeAdapter);
    expect(adapter.adapterName).toBe('openrouter-creative-v1');
    expect(adapter.isTestOnly).toBe(false);
  });

  it('should satisfy AsyncCreativeModelAdapter interface', () => {
    const adapter: AsyncCreativeModelAdapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
    });
    expect(adapter.adapterName).toBe('openrouter-creative-v1');
    expect(adapter.isTestOnly).toBe(false);
    expect(typeof adapter.createBrief).toBe('function');
  });
});

// ============================================================================
// Default/Missing Dependency Fail-Closed Behavior
// ============================================================================

describe('OpenRouterCreativeAdapter - default/missing dependency fail-closed', () => {
  it('should return unavailable when no secret resolver is provided and secret is not resolvable', async () => {
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
      // No secretResolver provided, so NoOpSecretResolver is used
    });

    const result = await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(result.category).toBe('unavailable');
    expect(result.errorCode).toBe('OPENROUTER_SECRET_NOT_RESOLVED');
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('could not be resolved');
  });

  it('should return unavailable when transport is not provided', async () => {
    const secretResolver = new MockSecretResolver({ 'openrouter-api-key': 'sk-test-key' });
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
      secretResolver,
      // No transport provided
    });

    const result = await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(result.category).toBe('unavailable');
    expect(result.errorCode).toBe('OPENROUTER_TRANSPORT_NOT_CONFIGURED');
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('not configured');
  });

  it('should return unavailable when both secret resolver and transport are missing', async () => {
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
    });

    const result = await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    // Secret resolution fails first
    expect(result.category).toBe('unavailable');
    expect(result.errorCode).toBe('OPENROUTER_SECRET_NOT_RESOLVED');
  });
});

// ============================================================================
// Unresolved Opaque Reference Fail-Closed Behavior
// ============================================================================

describe('OpenRouterCreativeAdapter - unresolved opaque reference fail-closed', () => {
  it('should return unavailable when secret resolver returns undefined', async () => {
    const secretResolver = new MockSecretResolver({}); // Empty - no secrets
    const transport = new MockHttpTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'nonexistent-key',
      secretResolver,
      transport,
    });

    const result = await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(result.category).toBe('unavailable');
    expect(result.errorCode).toBe('OPENROUTER_SECRET_NOT_RESOLVED');
    expect(result.retryable).toBe(false);
  });

  it('should attempt to resolve the secret with the configured reference', async () => {
    const secretResolver = new MockSecretResolver({});
    const transport = new MockHttpTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'my-secret-ref',
      secretResolver,
      transport,
    });

    await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(secretResolver.getResolveCount('my-secret-ref')).toBe(1);
  });

  it('should return unavailable even with valid secret when transport is missing', async () => {
    const secretResolver = new MockSecretResolver({ 'openrouter-api-key': 'sk-valid-key' });
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
      secretResolver,
      // No transport
    });

    const result = await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(result.category).toBe('unavailable');
    expect(result.errorCode).toBe('OPENROUTER_TRANSPORT_NOT_CONFIGURED');
  });
});

// ============================================================================
// Proof That Injected Transport Is Never Called
// ============================================================================

describe('OpenRouterCreativeAdapter - transport never called', () => {
  it('should never call the injected HTTP transport', async () => {
    const secretResolver = new MockSecretResolver({ 'openrouter-api-key': 'sk-test-key' });
    const transport = new MockHttpTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
      secretResolver,
      transport,
    });

    await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(transport.getCallCount()).toBe(0);
  });

  it('should never call transport even when secret is resolved', async () => {
    const secretResolver = new MockSecretResolver({ 'openrouter-api-key': 'sk-resolved-key' });
    const transport = new MockHttpTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
      secretResolver,
      transport,
    });

    await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(transport.getCallCount()).toBe(0);
    expect(transport.getCalls()).toHaveLength(0);
  });

  it('should never construct Authorization headers', async () => {
    const secretResolver = new MockSecretResolver({ 'openrouter-api-key': 'sk-test-key' });
    const transport = new MockHttpTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
      secretResolver,
      transport,
    });

    await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    const calls = transport.getCalls();
    expect(calls.length).toBe(0);
    // Even if calls were made, none should have authorization headers
    for (const call of calls) {
      expect(call.options.headers).not.toHaveProperty('authorization');
      expect(call.options.headers).not.toHaveProperty('Authorization');
    }
  });
});

// ============================================================================
// Input Immutability
// ============================================================================

describe('OpenRouterCreativeAdapter - input immutability', () => {
  it('should not mutate the input object', async () => {
    const input = { ...MOCK_INPUT } as any;
    const originalSnapshot = { ...input.snapshot };
    const originalRequest = { ...input.request };

    const secretResolver = new MockSecretResolver({ 'openrouter-api-key': 'sk-test-key' });
    const transport = new MockHttpTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
      secretResolver,
      transport,
    });

    await adapter.createBrief(input, MOCK_OPTIONS);

    expect(input.snapshot).toEqual(originalSnapshot);
    expect(input.request).toEqual(originalRequest);
  });

  it('should not mutate the options object', async () => {
    const options: AsyncAdapterOptions = {
      correlationId: 'test-correlation-id',
      timeoutMs: 30000,
      spendLimitUsdCents: 1000,
    };
    const originalOptions = { ...options };

    const secretResolver = new MockSecretResolver({ 'openrouter-api-key': 'sk-test-key' });
    const transport = new MockHttpTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
      secretResolver,
      transport,
    });

    await adapter.createBrief(MOCK_INPUT as any, options);

    expect(options).toEqual(originalOptions);
  });
});

// ============================================================================
// Audit/Error Redaction
// ============================================================================

describe('OpenRouterCreativeAdapter - audit/error redaction', () => {
  it('should emit start audit event with redacted data', async () => {
    const auditSink = {
      emit: vi.fn(),
    };
    const secretResolver = new MockSecretResolver({});
    const transport = new MockHttpTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
      secretResolver,
      transport,
    });

    await adapter.createBrief(MOCK_INPUT as any, {
      ...MOCK_OPTIONS,
      auditSink,
    });

    expect(auditSink.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: 'test-correlation-id',
        adapterName: 'openrouter-creative-v1',
        eventType: 'start',
        status: 'unavailable',
      }),
    );
  });

  it('should emit error audit event with redacted data (no secrets)', async () => {
    const auditSink = {
      emit: vi.fn(),
    };
    const secretResolver = new MockSecretResolver({});
    const transport = new MockHttpTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
      secretResolver,
      transport,
    });

    await adapter.createBrief(MOCK_INPUT as any, {
      ...MOCK_OPTIONS,
      auditSink,
    });

    const errorCall = auditSink.emit.mock.calls.find(
      (call) => (call[0] as any).eventType === 'error',
    );
    expect(errorCall).toBeDefined();
    const errorEvent = (errorCall as any[])[0] as any;
    expect(errorEvent.correlationId).toBe('test-correlation-id');
    expect(errorEvent.adapterName).toBe('openrouter-creative-v1');
    expect(errorEvent.eventType).toBe('error');
    expect(errorEvent.status).toBe('unavailable');
    expect(errorEvent.errorCode).toBe('OPENROUTER_SECRET_NOT_RESOLVED');
    // No secret values in the event
    expect(JSON.stringify(errorEvent)).not.toContain('sk-');
    expect(JSON.stringify(errorEvent)).not.toContain('openrouter-api-key');
  });

  it('should emit error audit event when transport is not configured', async () => {
    const auditSink = {
      emit: vi.fn(),
    };
    const secretResolver = new MockSecretResolver({ 'openrouter-api-key': 'sk-secret-value' });
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
      secretResolver,
      // No transport
    });

    await adapter.createBrief(MOCK_INPUT as any, {
      ...MOCK_OPTIONS,
      auditSink,
    });

    const errorCall = auditSink.emit.mock.calls.find(
      (call) => (call[0] as any).eventType === 'error',
    );
    expect(errorCall).toBeDefined();
    const errorEvent = (errorCall as any[])[0] as any;
    expect(errorEvent.errorCode).toBe('OPENROUTER_TRANSPORT_NOT_CONFIGURED');
    // No secret values in the event
    expect(JSON.stringify(errorEvent)).not.toContain('sk-secret-value');
    expect(JSON.stringify(errorEvent)).not.toContain('sk-');
  });

  it('should return error message without secret values', async () => {
    const secretResolver = new MockSecretResolver({});
    const transport = new MockHttpTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
      secretResolver,
      transport,
    });

    const result = await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(result.message).not.toContain('sk-');
    expect(result.message).not.toContain('openrouter-api-key');
    expect(result.message?.toLowerCase()).toContain('could not be resolved');
  });

  it('should not include secret reference in error code or message', async () => {
    const secretRef = 'my-secret-api-key-ref';
    const secretResolver = new MockSecretResolver({});
    const transport = new MockHttpTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef,
      secretResolver,
      transport,
    });

    const result = await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(result.errorCode).not.toContain(secretRef);
    expect(result.message).not.toContain(secretRef);
  });
});

// ============================================================================
// Clock/Duration Testing
// ============================================================================

describe('OpenRouterCreativeAdapter - clock and duration', () => {
  it('should use injected clock for timing', async () => {
    const mockClock = new MockClock(0);
    const secretResolver = new MockSecretResolver({});
    const transport = new MockHttpTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
      secretResolver,
      transport,
      clock: mockClock,
    });

    const result = await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(result.durationMs).toBe(0);

    mockClock.advance(100);
    // Note: duration is captured at the time of the call, so it should still be 0
    // because we haven't called again
  });

  it('should measure duration using clock', async () => {
    const mockClock = new MockClock(1000);
    const secretResolver = new MockSecretResolver({ 'openrouter-api-key': 'sk-test-key' });
    const transport = new MockHttpTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
      secretResolver,
      transport,
      clock: mockClock,
    });

    const result = await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    // Secret is resolved and transport is provided, but adapter is fail-closed
    expect(result.category).toBe('unavailable');
    expect(result.errorCode).toBe('OPENROUTER_NOT_YET_ENABLED');
    expect(result.durationMs).toBe(0);
  });
});

// ============================================================================
// Type Guard Tests
// ============================================================================

describe('OpenRouterCreativeAdapter - types', () => {
  it('should have correct adapterName type', () => {
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
    });
    expect(adapter.adapterName).toBe('openrouter-creative-v1');
    expect(typeof adapter.adapterName).toBe('string');
  });

  it('should have isTestOnly as false', () => {
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
    });
    expect(adapter.isTestOnly).toBe(false);
  });

  it('should have createBrief returning Promise of AsyncOutcome', async () => {
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'openrouter/mistral-large',
      timeoutMs: 60000,
      spendLimitUsdCents: 500,
      secretRef: 'openrouter-api-key',
    });

    const result = adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(result).toBeInstanceOf(Promise);

    const outcome = await result;
    expect(outcome).toHaveProperty('category');
    expect(outcome).toHaveProperty('retryable');
    expect(outcome).toHaveProperty('durationMs');
  });
});
