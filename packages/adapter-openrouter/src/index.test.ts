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

// ============================================================================
// OpenRouter Response Decoder Tests - WP-37 S4-F10-B
// ============================================================================

import { decodeOpenRouterResponse } from './index.js';
import type { OpenRouterResponse, OpenRouterDecoderOutcome } from './index.js';
import type { ModelAdapterOutputV1 } from '@joy-media/agent-tools';

// Type helpers for decoder tests - these are safe because we verify category first
type DecoderInvalid = Extract<OpenRouterDecoderOutcome, { category: 'invalid-output' }>;
type DecoderProviderFailed = Extract<OpenRouterDecoderOutcome, { category: 'provider-failed' }>;
type DecoderReady = Extract<OpenRouterDecoderOutcome, { category: 'ready' }>;

const VALID_OUTPUT: ModelAdapterOutputV1 = {
  interpretedGoal: { userIntent: 'u', inferredGoal: 'i', resolvedGoal: 'r', confidence: 'high' },
  distinction: { facts: [], inferences: [] },
  assumptions: [],
  recommendations: [],
  blockedBy: [],
  requiresHumanDecision: [],
};

const VALID_OUTPUT_PERSIAN: ModelAdapterOutputV1 = {
  interpretedGoal: { userIntent: 'فارس', inferredGoal: 'فارس', resolvedGoal: 'فارس', confidence: 'high' },
  distinction: { facts: [{ id: 'f1', statement: 'فارس', source: 's1', evidence: [] }], inferences: [] },
  assumptions: [],
  recommendations: [],
  blockedBy: [],
  requiresHumanDecision: [],
};

function checkInvalid(result: OpenRouterDecoderOutcome): asserts result is DecoderInvalid {
  expect(result.category).toBe('invalid-output');
}
function checkProviderFailed(result: OpenRouterDecoderOutcome): asserts result is DecoderProviderFailed {
  expect(result.category).toBe('provider-failed');
}
function checkReady(result: OpenRouterDecoderOutcome): asserts result is DecoderReady {
  expect(result.category).toBe('ready');
}

describe('decodeOpenRouterResponse', () => {
  describe('valid outputs', () => {
    it('returns ready for valid ModelAdapterOutputV1', () => {
      const resp: OpenRouterResponse = {
        choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
      };
      const result = decodeOpenRouterResponse(resp);
      checkReady(result);
      expect(result.result).toEqual(VALID_OUTPUT);
    });

    it('preserves Persian text', () => {
      const resp: OpenRouterResponse = {
        choices: [{ message: { content: JSON.stringify(VALID_OUTPUT_PERSIAN) } }],
      };
      const result = decodeOpenRouterResponse(resp);
      checkReady(result);
      expect(result.result).toEqual(VALID_OUTPUT_PERSIAN);
    });

    it('handles extra whitespace in JSON', () => {
      const resp: OpenRouterResponse = {
        choices: [{ message: { content: `  ${JSON.stringify(VALID_OUTPUT)}  ` } }],
      };
      checkReady(decodeOpenRouterResponse(resp));
    });
  });

  describe('empty/malformed envelopes', () => {
    it('returns invalid-output for empty choices', () => {
      const resp: OpenRouterResponse = { choices: [] };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(result.errorCode).toBe('OPENROUTER_EMPTY_RESPONSE');
      expect(result.message).toContain('No assistant message content');
      expect(result.retryable).toBe(false);
    });

    it('returns invalid-output for missing choices', () => {
      const resp: OpenRouterResponse = {};
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(result.errorCode).toBe('OPENROUTER_EMPTY_RESPONSE');
    });

    it('returns invalid-output for missing message', () => {
      const resp: OpenRouterResponse = { choices: [{} as any] };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(result.errorCode).toBe('OPENROUTER_EMPTY_RESPONSE');
    });

    it('returns invalid-output for missing content', () => {
      const resp: OpenRouterResponse = { choices: [{ message: {} }] };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(result.errorCode).toBe('OPENROUTER_EMPTY_RESPONSE');
    });

    it('returns invalid-output for non-string content', () => {
      const resp: OpenRouterResponse = { choices: [{ message: { content: 123 as any } }] };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(result.errorCode).toBe('OPENROUTER_EMPTY_RESPONSE');
    });

    it('returns invalid-output for empty string content', () => {
      const resp: OpenRouterResponse = { choices: [{ message: { content: '' } }] };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(result.errorCode).toBe('OPENROUTER_EMPTY_RESPONSE');
    });

    it('only checks first choice', () => {
      const resp: OpenRouterResponse = {
        choices: [{}, { message: { content: JSON.stringify(VALID_OUTPUT) } }],
      };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(result.errorCode).toBe('OPENROUTER_EMPTY_RESPONSE');
    });

    it('handles undefined choices', () => {
      const resp: OpenRouterResponse = { choices: undefined };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(result.errorCode).toBe('OPENROUTER_EMPTY_RESPONSE');
    });
  });

  describe('invalid JSON', () => {
    it('returns invalid-output for malformed JSON', () => {
      const resp: OpenRouterResponse = {
        choices: [{ message: { content: '{ bad json }' } }],
      };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(result.errorCode).toBe('OPENROUTER_INVALID_JSON');
      expect(result.message).toContain('not valid JSON');
      expect(result.retryable).toBe(false);
    });

    it('returns invalid-output for non-JSON string', () => {
      const resp: OpenRouterResponse = {
        choices: [{ message: { content: 'plain text' } }],
      };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(result.errorCode).toBe('OPENROUTER_INVALID_JSON');
    });

    it('returns invalid-output for JSON with trailing comma', () => {
      const resp: OpenRouterResponse = {
        choices: [{ message: { content: '{"k":"v",}' } }],
      };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(result.errorCode).toBe('OPENROUTER_INVALID_JSON');
    });
  });

  describe('invalid schema', () => {
    it('returns invalid-output for incomplete output', () => {
      const resp: OpenRouterResponse = {
        choices: [{ message: { content: '{"interpretedGoal":{}}' } }],
      };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(result.errorCode).toBe('OPENROUTER_INVALID_SCHEMA');
      expect(result.message).toContain('ModelAdapterOutputV1');
      expect(result.retryable).toBe(false);
    });

    it('returns invalid-output for empty object', () => {
      const resp: OpenRouterResponse = { choices: [{ message: { content: '{}' } }] };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(result.errorCode).toBe('OPENROUTER_INVALID_SCHEMA');
    });

    it('returns invalid-output for null', () => {
      const resp: OpenRouterResponse = { choices: [{ message: { content: 'null' } }] };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(result.errorCode).toBe('OPENROUTER_INVALID_SCHEMA');
    });

    it('returns invalid-output for array', () => {
      const resp: OpenRouterResponse = { choices: [{ message: { content: '[1,2]' } }] };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(result.errorCode).toBe('OPENROUTER_INVALID_SCHEMA');
    });
  });

  describe('provider errors', () => {
    it('returns provider-failed for explicit error', () => {
      const resp: OpenRouterResponse = {
        error: { message: 'Rate limit', type: 'BadRequestError', code: 'RATE_LIMIT' },
      };
      const result = decodeOpenRouterResponse(resp);
      checkProviderFailed(result);
      expect(result.errorCode).toBe('OPENROUTER_PROVIDER_ERROR');
      expect(result.message).toContain('OpenRouter provider');
      expect(result.retryable).toBe(true);
    });

    it('returns provider-failed for minimal error', () => {
      const resp: OpenRouterResponse = { error: { message: 'Unauth' } };
      const result = decodeOpenRouterResponse(resp);
      checkProviderFailed(result);
      expect(result.errorCode).toBe('OPENROUTER_PROVIDER_ERROR');
    });

    it('error takes precedence over choices', () => {
      const resp: OpenRouterResponse = {
        choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
        error: { message: 'Internal' },
      };
      const result = decodeOpenRouterResponse(resp);
      checkProviderFailed(result);
      expect(result.errorCode).toBe('OPENROUTER_PROVIDER_ERROR');
    });
  });

  describe('unknown keys and boundary values', () => {
    it('ignores unknown top-level keys', () => {
      const resp: OpenRouterResponse = {
        choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
        id: 'c1',
        created: 123,
        model: 'm1',
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      } as any;
      checkReady(decodeOpenRouterResponse(resp));
    });

    it('handles whitespace-only content', () => {
      const resp: OpenRouterResponse = { choices: [{ message: { content: '   \n\t  ' } }] };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(result.errorCode).toBe('OPENROUTER_INVALID_JSON');
    });
  });

  describe('redaction proof', () => {
    it('does not expose secrets in invalid-output', () => {
      const resp: OpenRouterResponse = {
        choices: [{ message: { content: '{"secret":"sk-123","key":"abc"}' } }],
      };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(JSON.stringify(result)).not.toContain('sk-123');
      expect(JSON.stringify(result)).not.toContain('abc');
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(JSON.stringify(result)).not.toContain('key');
    });

    it('does not expose provider error details', () => {
      const resp: OpenRouterResponse = {
        error: { message: 'API key invalid: sk-xyz', code: 'INVALID' },
      };
      const result = decodeOpenRouterResponse(resp);
      checkProviderFailed(result);
      expect(JSON.stringify(result)).not.toContain('sk-xyz');
      expect(JSON.stringify(result)).not.toContain('API key invalid');
      expect(result.message).toBe('OpenRouter provider returned an error');
    });

    it('does not expose URLs', () => {
      const resp: OpenRouterResponse = {
        choices: [{ message: { content: 'https://api.openrouter.ai/v1' } }],
      };
      const result = decodeOpenRouterResponse(resp);
      checkInvalid(result);
      expect(JSON.stringify(result)).not.toContain('https://');
      expect(JSON.stringify(result)).not.toContain('api.openrouter.ai');
    });

    it('returns consistent error codes', () => {
      expect((decodeOpenRouterResponse({} as OpenRouterResponse) as DecoderInvalid).errorCode).toBe('OPENROUTER_EMPTY_RESPONSE');
      expect((decodeOpenRouterResponse({ choices: [{ message: { content: 'x' } }] } as OpenRouterResponse) as DecoderInvalid).errorCode).toBe('OPENROUTER_INVALID_JSON');
      expect((decodeOpenRouterResponse({ choices: [{ message: { content: '{}' } }] } as OpenRouterResponse) as DecoderInvalid).errorCode).toBe('OPENROUTER_INVALID_SCHEMA');
      expect((decodeOpenRouterResponse({ error: { message: 'e' } } as OpenRouterResponse) as DecoderProviderFailed).errorCode).toBe('OPENROUTER_PROVIDER_ERROR');
    });
  });

  describe('type safety', () => {
    it('ready has result', () => {
      const resp: OpenRouterResponse = {
        choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
      };
      const result = decodeOpenRouterResponse(resp);
      if (result.category !== 'ready') throw new Error('Expected ready');
      expect(result.result).toBeDefined();
      expect(typeof result.result).toBe('object');
    });

    it('invalid-output has error fields', () => {
      const resp: OpenRouterResponse = { choices: [{ message: { content: 'bad' } }] };
      const result = decodeOpenRouterResponse(resp);
      if (result.category !== 'invalid-output') throw new Error('Expected invalid-output');
      expect(result.errorCode).toBeDefined();
      expect(result.message).toBeDefined();
      expect(typeof result.retryable).toBe('boolean');
    });

    it('provider-failed has error fields', () => {
      const resp: OpenRouterResponse = { error: { message: 'e' } };
      const result = decodeOpenRouterResponse(resp);
      if (result.category !== 'provider-failed') throw new Error('Expected provider-failed');
      expect(result.errorCode).toBeDefined();
      expect(result.message).toBeDefined();
      expect(typeof result.retryable).toBe('boolean');
    });
  });
});

// ============================================================================
// OpenRouter Request Codec Tests - WP-37 S4-F10-C
// ============================================================================

import { buildOpenRouterRequest, OpenRouterCodec } from './index.js';
import type { OpenRouterRequestOutcome } from './index.js';

describe('buildOpenRouterRequest - basic functionality', () => {
  // Minimal test to verify the codec exports and basic functionality
  // Full type testing is complex due to cross-package type dependencies
  it('exports buildOpenRouterRequest function', () => {
    expect(typeof buildOpenRouterRequest).toBe('function');
  });

  it('exports OpenRouterCodec object', () => {
    expect(typeof OpenRouterCodec).toBe('object');
    expect(typeof OpenRouterCodec.build).toBe('function');
    expect(typeof OpenRouterCodec.decode).toBe('function');
  });
});
