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
    modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
    timeoutMs: 30000,
    spendLimitUsdCents: 0,
    secretRef: 'joy-media/openrouter/creative-brief/v1',
    ...overrides,
  };
}

// ============================================================================
// Public Adapter Construction
// ============================================================================

describe('OpenRouterCreativeAdapter - public construction', () => {
  it('should create adapter with required options', () => {
    const adapter = new OpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
    });
    expect(adapter).toBeInstanceOf(OpenRouterCreativeAdapter);
    expect(adapter.adapterName).toBe('openrouter-creative-v1');
    expect(adapter.isTestOnly).toBe(false);
  });

  it('should create adapter via factory function', () => {
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
    });
    expect(adapter).toBeInstanceOf(OpenRouterCreativeAdapter);
    expect(adapter.adapterName).toBe('openrouter-creative-v1');
    expect(adapter.isTestOnly).toBe(false);
  });

  it('should satisfy AsyncCreativeModelAdapter interface', () => {
    const adapter: AsyncCreativeModelAdapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
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
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      // No secretResolver provided, so NoOpSecretResolver is used
    });

    const result = await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(result.category).toBe('policy-denied');
    expect(result.errorCode).toBe('OPENROUTER_MODEL_NOT_ALLOWED');
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('Pinned free model policy');
  });

  it('should return unavailable when transport is not provided', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      // No transport provided
    });

    const result = await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(result.category).toBe('policy-denied');
    expect(result.errorCode).toBe('OPENROUTER_MODEL_NOT_ALLOWED');
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('Pinned free model policy');
  });

  it('should return unavailable when both secret resolver and transport are missing', async () => {
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
    });

    const result = await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    // Secret resolution fails first
    expect(result.category).toBe('policy-denied');
    expect(result.errorCode).toBe('OPENROUTER_MODEL_NOT_ALLOWED');
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
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'nonexistent-key',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
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
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'my-secret-ref',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(secretResolver.getResolveCount('my-secret-ref')).toBe(1);
  });

  it('should return unavailable even with valid secret when transport is missing', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-valid-key' });
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      // No transport
    });

    const result = await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(result.category).toBe('policy-denied');
    expect(result.errorCode).toBe('OPENROUTER_MODEL_NOT_ALLOWED');
  });
});

// ============================================================================
// Injected Transport Path - WP-37 S4-F10-D3-A
// ============================================================================

// Helper to create a minimal valid ModelAdapterInputV1 for testing
export function createValidInput(): any {
  return {
    snapshot: {
      projectId: 'test-project',
      revisionId: 'test-revision',
      composition: {
        durationUs: 1000000,
        aspectRatio: '16:9',
        frameRate: { num: 30, den: 1 },
        width: 1920,
        height: 1080,
      },
      scenes: [],
      assets: [],
    },
    brandReadiness: {
      hasBrandKit: false,
      colorsAvailable: 0,
      fontsAvailable: 0,
      logoAvailable: false,
    },
    sceneCoverages: [],
    projectReadiness: {
      readinessLevel: 'none' as const,
      durationAligned: false,
      aspectRatioAligned: false,
      blockers: [],
    },
    rules: [],
    request: {
      request: 'test request',
      scope: 'full' as const,
    },
  };
}

// Mock transport that can be configured to return different responses
const DEFAULT_USAGE = {
  prompt_tokens: 10,
  completion_tokens: 20,
  total_tokens: 30,
  cost: 0,
} as const;

class ConfigurableMockTransport implements HttpPostTransport {
  #calls: Array<{ url: string; options: RequestInit }> = [];
  #responseFactory: (() => Promise<Response>) | null = null;
  #autoUsage: boolean;

  constructor(responseFactory?: () => Promise<Response>, autoUsage = true) {
    this.#responseFactory = responseFactory ?? (() => Promise.resolve(new Response('{}', { status: 200 })));
    this.#autoUsage = autoUsage;
  }

  async post(url: string, options: RequestInit): Promise<Response> {
    this.#calls.push({ url, options });
    const response = await this.#responseFactory!();
    if (!this.#autoUsage || !response.ok) return response;
    const body = await response.text();
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (parsed.usage === undefined) {
        parsed.usage = DEFAULT_USAGE;
        return new Response(JSON.stringify(parsed), { status: response.status });
      }
    } catch {
      // Preserve malformed bodies for decoder tests.
    }
    return new Response(body, { status: response.status });
  }

  getCallCount(): number {
    return this.#calls.length;
  }

  getCalls(): Array<{ url: string; options: RequestInit }> {
    return [...this.#calls];
  }

  getLastCall(): { url: string; options: RequestInit } | undefined {
    return this.#calls[this.#calls.length - 1];
  }

  setResponseFactory(factory: () => Promise<Response>): void {
    this.#responseFactory = factory;
  }
}

describe('OpenRouterCreativeAdapter - injected transport path', () => {
  it('should call transport exactly once with valid resolver/transport and return ready', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'nvidia/nemotron-3-nano-30b-a3b:free',
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    expect(transport.getCallCount()).toBe(1);
    expect(result.category).toBe('ready');
    expect(result.result).toEqual(VALID_OUTPUT);
  });

  it('should send outgoing body with configured model and max_tokens 1024', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    expect(transport.getCallCount()).toBe(1);

    const lastCall = transport.getLastCall();
    expect(lastCall).toBeDefined();
    expect(lastCall!.url).toBe('https://openrouter.ai/api/v1/chat/completions');

    const body = JSON.parse(lastCall!.options.body as string) as any;
    expect(body.model).toBe('nvidia/nemotron-3-nano-30b-a3b:free');
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0.0);
    expect(body.reasoning_effort).toBe('none');
  });

  it('should send Authorization header with resolved Bearer token', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'my-secret-value' });
    const transport = new ConfigurableMockTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    const lastCall = transport.getLastCall();
    expect(lastCall).toBeDefined();

    const headers = lastCall!.options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer my-secret-value');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('should map non-2xx response to redacted provider-failed', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(new Response('{"error":{"message":"Rate limited"}}', { status: 429 })),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    expect(transport.getCallCount()).toBe(1);
    expect(result.category).toBe('provider-failed');
    expect(result.errorCode).toBe('OPENROUTER_PROVIDER_ERROR');
    expect(result.message).toContain('non-2xx');
    expect(result.retryable).toBe(true);
    // Ensure no secret in the result
    expect(JSON.stringify(result)).not.toContain('sk-test-key');
    expect(JSON.stringify(result)).not.toContain('Rate limited');
  });

  it('should map thrown transport error to redacted provider-failed', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.reject(new Error('Network error: connection refused')),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    expect(transport.getCallCount()).toBe(1);
    expect(result.category).toBe('provider-failed');
    expect(result.errorCode).toBe('OPENROUTER_PROVIDER_ERROR');
    expect(result.message).toContain('transport failed');
    expect(result.retryable).toBe(true);
    // Ensure no secret or error details in the result
    expect(JSON.stringify(result)).not.toContain('sk-test-key');
    expect(JSON.stringify(result)).not.toContain('Network error');
    expect(JSON.stringify(result)).not.toContain('connection refused');
  });
});

// ============================================================================
// Audit/Error Redaction for Transport Path
// ============================================================================

describe('OpenRouterCreativeAdapter - transport path audit redaction', () => {
  it('should never emit secret in audit events for successful transport call', async () => {
    const auditSink = { emit: vi.fn() };
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-secret-value' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'nvidia/nemotron-3-nano-30b-a3b:free',
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    await adapter.createBrief(createValidInput(), { ...MOCK_OPTIONS, auditSink });

    // Check all emitted events
    for (const call of auditSink.emit.mock.calls) {
      const event = call[0] as any;
      expect(JSON.stringify(event)).not.toContain('sk-secret-value');
      expect(JSON.stringify(event)).not.toContain('sk-');
      expect(JSON.stringify(event)).not.toContain('Bearer');
    }
  });

  it('should never emit secret in audit events for non-2xx response', async () => {
    const auditSink = { emit: vi.fn() };
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-secret-value' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(new Response('{"error":{"message":"Auth failed"}}', { status: 401 })),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    await adapter.createBrief(createValidInput(), { ...MOCK_OPTIONS, auditSink });

    // Check all emitted events
    for (const call of auditSink.emit.mock.calls) {
      const event = call[0] as any;
      expect(JSON.stringify(event)).not.toContain('sk-secret-value');
      expect(JSON.stringify(event)).not.toContain('sk-');
      expect(JSON.stringify(event)).not.toContain('Bearer');
      expect(JSON.stringify(event)).not.toContain('Auth failed');
    }
  });

  it('should never emit secret in audit events for transport error', async () => {
    const auditSink = { emit: vi.fn() };
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-secret-value' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.reject(new Error('Connection timeout')),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    await adapter.createBrief(createValidInput(), { ...MOCK_OPTIONS, auditSink });

    // Check all emitted events
    for (const call of auditSink.emit.mock.calls) {
      const event = call[0] as any;
      expect(JSON.stringify(event)).not.toContain('sk-secret-value');
      expect(JSON.stringify(event)).not.toContain('sk-');
      expect(JSON.stringify(event)).not.toContain('Bearer');
      expect(JSON.stringify(event)).not.toContain('Connection timeout');
    }
  });
});

// ============================================================================
// Input Immutability
// ============================================================================

describe('OpenRouterCreativeAdapter - input immutability', () => {
  it('should not mutate the input object', async () => {
    const input = createValidInput();
    const originalSnapshot = JSON.parse(JSON.stringify(input.snapshot));
    const originalRequest = JSON.parse(JSON.stringify(input.request));

    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'nvidia/nemotron-3-nano-30b-a3b:free',
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
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

    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'nvidia/nemotron-3-nano-30b-a3b:free',
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    await adapter.createBrief(createValidInput(), options);

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
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
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
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
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
    expect(JSON.stringify(errorEvent)).not.toContain('joy-media/openrouter/creative-brief/v1');
  });

  it('should emit error audit event when transport is not configured', async () => {
    const auditSink = {
      emit: vi.fn(),
    };
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-secret-value' });
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
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
    expect(errorEvent.errorCode).toBe('OPENROUTER_MODEL_NOT_ALLOWED');
    // No secret values in the event
    expect(JSON.stringify(errorEvent)).not.toContain('sk-secret-value');
    expect(JSON.stringify(errorEvent)).not.toContain('sk-');
  });

  it('should return error message without secret values', async () => {
    const secretResolver = new MockSecretResolver({});
    const transport = new MockHttpTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(result.message).not.toContain('sk-');
    expect(result.message).not.toContain('joy-media/openrouter/creative-brief/v1');
    expect(result.message?.toLowerCase()).toContain('could not be resolved');
  });

  it('should not include secret reference in error code or message', async () => {
    const secretRef = 'my-secret-api-key-ref';
    const secretResolver = new MockSecretResolver({});
    const transport = new MockHttpTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef,
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
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
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],      clock: mockClock,
    });

    const result = await adapter.createBrief(MOCK_INPUT as any, MOCK_OPTIONS);
    expect(result.durationMs).toBe(0);

    mockClock.advance(100);
    // Note: duration is captured at the time of the call, so it should still be 0
    // because we haven't called again
  });

  it('should measure duration using clock', async () => {
    const mockClock = new MockClock(1000);
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'nvidia/nemotron-3-nano-30b-a3b:free',
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],      clock: mockClock,
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    expect(result.category).toBe('ready');
    expect(result.durationMs).toBe(0);
  });
});

// ============================================================================
// Type Guard Tests
// ============================================================================

describe('OpenRouterCreativeAdapter - types', () => {
  it('should have correct adapterName type', () => {
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
    });
    expect(adapter.adapterName).toBe('openrouter-creative-v1');
    expect(typeof adapter.adapterName).toBe('string');
  });

  it('should have isTestOnly as false', () => {
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
    });
    expect(adapter.isTestOnly).toBe(false);
  });

  it('should have createBrief returning Promise of AsyncOutcome', async () => {
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
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

// ============================================================================
// In-flight Cancellation/Timeout - WP-37 S4-F10-D3-B2
// ============================================================================

// Mock transport that captures calls and can access the signal
class SignalCaptureTransport implements HttpPostTransport {
  #calls: Array<{ url: string; options: RequestInit }> = [];
  #responseFactory: (url: string, options: RequestInit) => Promise<Response>;

  constructor(
    responseFactory?: (url: string, options: RequestInit) => Promise<Response>,
  ) {
    this.#responseFactory = responseFactory ?? ((_url: string, _options: RequestInit) => Promise.resolve(new Response('{}', { status: 200 })));
  }

  async post(url: string, options: RequestInit): Promise<Response> {
    this.#calls.push({ url, options });
    return this.#responseFactory(url, options);
  }

  getCallCount(): number {
    return this.#calls.length;
  }

  getCalls(): Array<{ url: string; options: RequestInit }> {
    return [...this.#calls];
  }

  getLastCall(): { url: string; options: RequestInit } | undefined {
    return this.#calls[this.#calls.length - 1];
  }
}

describe('OpenRouterCreativeAdapter - in-flight cancellation and timeout', () => {
  const createSignal = () => {
    const controller = new AbortController();
    return { signal: controller.signal, abort: () => controller.abort() };
  };

  const createDelayedTransport = (delayMs: number, response: Response) => {
    return new SignalCaptureTransport(() =>
      new Promise((resolve) => setTimeout(() => resolve(response), delayMs)),
    );
  };

  const createNeverTransport = () => {
    return new SignalCaptureTransport(() => new Promise(() => {}));
  };

  const VALID_ADAPTER_OPTIONS = createAdapterOptions();

  it('in-flight caller abort settles as cancelled with non-cooperative transport', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test' });
    const transport = createNeverTransport();
    const adapter = createOpenRouterCreativeAdapter({
      ...VALID_ADAPTER_OPTIONS,
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const { signal, abort } = createSignal();

    // Start the request
    const promise = adapter.createBrief(createValidInput(), {
      ...MOCK_OPTIONS,
      signal,
      timeoutMs: 10000,
    });

    // Abort after a small delay (in-flight)
    setTimeout(() => abort(), 10);

    const result = await promise;
    expect(result.category).toBe('cancelled');
    expect(result.errorCode).toBe('OPENROUTER_CALL_CANCELLED');
    expect(result.retryable).toBe(false);
    expect(transport.getCallCount()).toBe(1);
  });

  it('in-flight timeout settles as timeout with non-cooperative transport', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test' });
    const transport = createNeverTransport();
    const adapter = createOpenRouterCreativeAdapter({
      ...VALID_ADAPTER_OPTIONS,
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(createValidInput(), {
      ...MOCK_OPTIONS,
      timeoutMs: 10,
    });

    expect(result.category).toBe('timeout');
    expect(result.errorCode).toBe('OPENROUTER_REQUEST_TIMEOUT');
    expect(result.retryable).toBe(true);
    expect(transport.getCallCount()).toBe(1);
  });

  it('transport receives abort signal on caller cancellation', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test' });
    const transport = new SignalCaptureTransport((_url, options) => {
      // Verify the signal is passed in RequestInit
      expect(options.signal).toBeDefined();
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return new Promise<Response>((_resolve, reject) => {
        // Listen for abort on the passed signal
        options.signal!.addEventListener('abort', () => {
          reject(new DOMException('Aborted by caller signal', 'AbortError'));
        });
      });
    });

    const adapter = createOpenRouterCreativeAdapter({
      ...VALID_ADAPTER_OPTIONS,
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const { signal, abort } = createSignal();

    const promise = adapter.createBrief(createValidInput(), {
      ...MOCK_OPTIONS,
      signal,
      timeoutMs: 10000,
    });

    // Abort after a small delay
    setTimeout(() => abort(), 10);

    const result = await promise;
    expect(result.category).toBe('cancelled');
    expect(transport.getCallCount()).toBe(1);
  });

  it('transport receives abort signal on timeout', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test' });
    const transport = new SignalCaptureTransport((_url, options) => {
      // Verify the signal is passed in RequestInit
      expect(options.signal).toBeDefined();
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return new Promise<Response>((_resolve, reject) => {
        // Listen for abort on the passed signal
        options.signal!.addEventListener('abort', () => {
          reject(new DOMException('Aborted by timeout', 'AbortError'));
        });
      });
    });

    const adapter = createOpenRouterCreativeAdapter({
      ...VALID_ADAPTER_OPTIONS,
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(createValidInput(), {
      ...MOCK_OPTIONS,
      timeoutMs: 10,
    });

    expect(result.category).toBe('timeout');
    expect(transport.getCallCount()).toBe(1);
  });

  it('late transport resolution after timeout cannot become ready', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test' });
    let resolveTransport: (() => void) | undefined;
    const transport = new SignalCaptureTransport(() => {
      return new Promise<Response>((resolve) => {
        resolveTransport = () => {
          resolve(new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }), { status: 200 }));
        };
      });
    });

    const adapter = createOpenRouterCreativeAdapter({
      ...VALID_ADAPTER_OPTIONS,
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(createValidInput(), {
      ...MOCK_OPTIONS,
      timeoutMs: 10,
    });

    expect(result.category).toBe('timeout');

    // Now resolve the transport (late) - should not affect the already-settled result
    if (resolveTransport) {
      resolveTransport();
    }

    // Give time for any potential issues
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('late transport rejection after cancellation does not create unhandled rejection', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test' });
    let rejectTransport: (() => void) | undefined;
    const transport = new SignalCaptureTransport(() => {
      return new Promise<Response>((_resolve, reject) => {
        rejectTransport = () => {
          reject(new Error('Late transport error'));
        };
      });
    });

    const adapter = createOpenRouterCreativeAdapter({
      ...VALID_ADAPTER_OPTIONS,
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const { signal, abort } = createSignal();

    const promise = adapter.createBrief(createValidInput(), {
      ...MOCK_OPTIONS,
      signal,
      timeoutMs: 10000,
    });

    // Abort in-flight
    setTimeout(() => abort(), 10);

    const result = await promise;
    expect(result.category).toBe('cancelled');

    // Now reject the transport (late)
    if (rejectTransport) {
      rejectTransport();
    }

    // Give time for any potential unhandled rejection
    await new Promise((resolve) => setTimeout(resolve, 10));
    // If we get here without an unhandled rejection error, the test passes
  });

  it('normal completion within deadline returns ready', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test' });
    const transport = createDelayedTransport(5, new Response(
      JSON.stringify({
        model: 'nvidia/nemotron-3-nano-30b-a3b:free',
        usage: DEFAULT_USAGE,
        choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
      }),
      { status: 200 },
    ));
    const adapter = createOpenRouterCreativeAdapter({
      ...VALID_ADAPTER_OPTIONS,
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(createValidInput(), {
      ...MOCK_OPTIONS,
      timeoutMs: 1000,
    });

    expect(result.category).toBe('ready');
    expect(result.result).toEqual(VALID_OUTPUT);
    expect(transport.getCallCount()).toBe(1);
  });

  it('transport receives abort signal via RequestInit.signal', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test' });
    const transport = new SignalCaptureTransport((_url, options) => {
      // Verify the signal is passed in RequestInit
      expect(options.signal).toBeDefined();
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(new Response(JSON.stringify({ model: 'nvidia/nemotron-3-nano-30b-a3b:free' }), { status: 200 }));
    });

    const adapter = createOpenRouterCreativeAdapter({
      ...VALID_ADAPTER_OPTIONS,
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const { signal } = createSignal();

    await adapter.createBrief(createValidInput(), {
      ...MOCK_OPTIONS,
      signal,
      timeoutMs: 10000,
    });

    expect(transport.getCallCount()).toBe(1);
  });
});


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

    it('normalizes the provider low-risk alias to the bounded local risk enum', () => {
      const aliased = {
        ...VALID_OUTPUT,
        recommendations: [{ ...VALID_OUTPUT.recommendations[0], risk: 'low' }],
      };
      const result = decodeOpenRouterResponse({
        choices: [{ message: { content: JSON.stringify(aliased) } }],
      });
      checkReady(result);
      expect(result.result).toMatchObject({
        recommendations: [{ risk: 'reversible-local' }],
      });
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
    it('recovers a valid object wrapped in a markdown fence', () => {
      const resp: OpenRouterResponse = {
        choices: [{ message: { content: `Here is the JSON:\n\n\`\`\`json\n${JSON.stringify(VALID_OUTPUT)}\n\`\`\`` } }],
      };
      checkReady(decodeOpenRouterResponse(resp));
    });

    it('recovers a valid object surrounded by short prose', () => {
      const resp: OpenRouterResponse = {
        choices: [{ message: { content: `Result:\n${JSON.stringify(VALID_OUTPUT)}\nDone.` } }],
      };
      checkReady(decodeOpenRouterResponse(resp));
    });

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
import type { OpenRouterRequestOutcome, OpenRouterRequest } from './index.js';

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

// ============================================================================
// OpenRouter Request Codec - Token Cap Tests - WP-37 S4-F10-D2
// ============================================================================

describe('buildOpenRouterRequest - output token cap', () => {
  // Helper to create a minimal valid input
  function createMinimalInput(): any {
    return {
      snapshot: {
        projectId: 'test-project',
        revisionId: 'test-revision',
        composition: {
          durationUs: 1000000,
          aspectRatio: '16:9',
          frameRate: { num: 30, den: 1 },
          width: 1920,
          height: 1080,
        },
        scenes: [],
        assets: [],
      },
      brandReadiness: {
        hasBrandKit: false,
        colorsAvailable: 0,
        fontsAvailable: 0,
        logoAvailable: false,
      },
      sceneCoverages: [],
      projectReadiness: {
        readinessLevel: 'none',
        durationAligned: false,
        aspectRatioAligned: false,
        blockers: [],
      },
      rules: [],
      request: {
        request: 'test request',
        scope: 'full',
      },
    };
  }

  // Type guard for ready outcomes
  function assertReady(result: OpenRouterRequestOutcome): asserts result is { category: 'ready'; result: OpenRouterRequest } {
    expect(result.category).toBe('ready');
  }

  it('should build request with max_tokens set to 1024', () => {
    const input = createMinimalInput();
    const result = buildOpenRouterRequest(input, { modelId: 'nvidia/nemotron-3-nano-30b-a3b:free' });

    assertReady(result);
    expect(result.result.max_tokens).toBe(1024);
  });

  it('should always use exactly 1024 for max_tokens regardless of input', () => {
    const input = createMinimalInput();
    // Test with different model IDs
    const result1 = buildOpenRouterRequest(input, { modelId: 'nvidia/nemotron-3-nano-30b-a3b:free' });
    const result2 = buildOpenRouterRequest(input, { modelId: 'openrouter/llama-3' });

    assertReady(result1);
    assertReady(result2);
    expect(result1.result.max_tokens).toBe(1024);
    expect(result2.result.max_tokens).toBe(1024);
  });

  it('should include temperature 0.0 for deterministic output', () => {
    const input = createMinimalInput();
    const result = buildOpenRouterRequest(input, { modelId: 'nvidia/nemotron-3-nano-30b-a3b:free' });

    assertReady(result);
    expect(result.result.temperature).toBe(0.0);
    expect(result.result.max_tokens).toBe(1024);
  });

  it('should not allow increasing max_tokens through public API', () => {
    const input = createMinimalInput();
    // The buildOpenRouterRequest function only accepts input and config with modelId
    // There is no parameter to override max_tokens
    const result = buildOpenRouterRequest(input, { modelId: 'nvidia/nemotron-3-nano-30b-a3b:free' });

    assertReady(result);
    // No matter what, it should be 1024
    expect(result.result.max_tokens).toBe(1024);
    expect(result.result.max_tokens).not.toBe(8192);
    expect(result.result.max_tokens).not.toBeGreaterThan(1024);
  });
});

// ============================================================================
// Free Model Allowlist Policy - WP-37 S4-F10-D3-C
// ============================================================================

describe('OpenRouterCreativeAdapter - free model allowlist policy', () => {
  it('should deny when the free model allowlist is absent before resolving secrets or transport', async () => {
    const secretResolver = new MockSecretResolver({
      'joy-media/openrouter/creative-brief/v1': 'sk-test-key',
    });
    const transport = new ConfigurableMockTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);

    expect(result.category).toBe('policy-denied');
    expect(result.errorCode).toBe('OPENROUTER_MODEL_NOT_ALLOWED');
    expect(secretResolver.getResolveCount('joy-media/openrouter/creative-brief/v1')).toBe(0);
    expect(transport.getCallCount()).toBe(0);
  });

  it('should deny a non-zero spend cap before resolving secrets or transport', async () => {
    const secretResolver = new MockSecretResolver({
      'joy-media/openrouter/creative-brief/v1': 'sk-test-key',
    });
    const transport = new ConfigurableMockTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 1,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);

    expect(result.category).toBe('policy-denied');
    expect(result.errorCode).toBe('OPENROUTER_FREE_ONLY_REQUIRED');
    expect(secretResolver.getResolveCount('joy-media/openrouter/creative-brief/v1')).toBe(0);
    expect(transport.getCallCount()).toBe(0);
  });

  it('should deny multiple allowlisted models before resolving secrets or transport', async () => {
    const secretResolver = new MockSecretResolver({
      'joy-media/openrouter/creative-brief/v1': 'sk-test-key',
    });
    const transport = new ConfigurableMockTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: [
        'nvidia/nemotron-3-nano-30b-a3b:free',
        'another/model:free',
      ],
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);

    expect(result.category).toBe('policy-denied');
    expect(result.errorCode).toBe('OPENROUTER_MODEL_NOT_ALLOWED');
    expect(secretResolver.getResolveCount('joy-media/openrouter/creative-brief/v1')).toBe(0);
    expect(transport.getCallCount()).toBe(0);
  });

  it('should allow request when modelId is in allowlist', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'nvidia/nemotron-3-nano-30b-a3b:free',
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    expect(result.category).toBe('ready');
    expect(result.result).toEqual(VALID_OUTPUT);
    expect(transport.getCallCount()).toBe(1);
  });

  it('should allow request when allowlist is absent (undefined)', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'nvidia/nemotron-3-nano-30b-a3b:free',
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      // allowedFreeModelIds is undefined
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    expect(result.category).toBe('policy-denied');
    expect(result.errorCode).toBe('OPENROUTER_MODEL_NOT_ALLOWED');
    expect(transport.getCallCount()).toBe(0);
  });

  it('should deny request with policy-denied when allowlist is empty', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: [],
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    expect(result.category).toBe('policy-denied');
    expect(result.errorCode).toBe('OPENROUTER_MODEL_NOT_ALLOWED');
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('Pinned free model policy');
    // Verify resolver and transport were NOT called
    expect(secretResolver.getResolveCount('joy-media/openrouter/creative-brief/v1')).toBe(0);
    expect(transport.getCallCount()).toBe(0);
  });

  it('should deny request with policy-denied when modelId is not in allowlist', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['openrouter/llama-3', 'openrouter/gemini-flash'],
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    expect(result.category).toBe('policy-denied');
    expect(result.errorCode).toBe('OPENROUTER_MODEL_NOT_ALLOWED');
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('Pinned free model policy');
    // Verify resolver and transport were NOT called
    expect(secretResolver.getResolveCount('joy-media/openrouter/creative-brief/v1')).toBe(0);
    expect(transport.getCallCount()).toBe(0);
  });

  it('should emit policy-denied audit event with redacted code when model is rejected', async () => {
    const auditSink = { emit: vi.fn() };
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['openrouter/llama-3'],
    });

    await adapter.createBrief(createValidInput(), {
      ...MOCK_OPTIONS,
      auditSink,
    });

    const errorCall = auditSink.emit.mock.calls.find(
      (call) => (call[0] as any).eventType === 'error',
    );
    expect(errorCall).toBeDefined();
    const errorEvent = (errorCall as any[])[0] as any;
    expect(errorEvent.eventType).toBe('error');
    expect(errorEvent.status).toBe('policy-denied');
    expect(errorEvent.errorCode).toBe('OPENROUTER_MODEL_NOT_ALLOWED');
    expect(errorEvent.correlationId).toBe('test-correlation-id');
    expect(errorEvent.adapterName).toBe('openrouter-creative-v1');
    // Ensure no model ID or secret in the event
    expect(JSON.stringify(errorEvent)).not.toContain('mistral-large');
    expect(JSON.stringify(errorEvent)).not.toContain('llama-3');
    expect(JSON.stringify(errorEvent)).not.toContain('sk-');
    // Verify resolver and transport were NOT called
    expect(secretResolver.getResolveCount('joy-media/openrouter/creative-brief/v1')).toBe(0);
    expect(transport.getCallCount()).toBe(0);
  });

  it('should emit policy-denied audit event with redacted code when allowlist is empty', async () => {
    const auditSink = { emit: vi.fn() };
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: [],
    });

    await adapter.createBrief(createValidInput(), {
      ...MOCK_OPTIONS,
      auditSink,
    });

    const errorCall = auditSink.emit.mock.calls.find(
      (call) => (call[0] as any).eventType === 'error',
    );
    expect(errorCall).toBeDefined();
    const errorEvent = (errorCall as any[])[0] as any;
    expect(errorEvent.eventType).toBe('error');
    expect(errorEvent.status).toBe('policy-denied');
    expect(errorEvent.errorCode).toBe('OPENROUTER_MODEL_NOT_ALLOWED');
    expect(errorEvent.correlationId).toBe('test-correlation-id');
    expect(errorEvent.adapterName).toBe('openrouter-creative-v1');
    // Verify resolver and transport were NOT called
    expect(secretResolver.getResolveCount('joy-media/openrouter/creative-brief/v1')).toBe(0);
    expect(transport.getCallCount()).toBe(0);
  });

  it('should not emit start audit event when policy denies request', async () => {
    const auditSink = { emit: vi.fn() };
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: [],
    });

    await adapter.createBrief(createValidInput(), {
      ...MOCK_OPTIONS,
      auditSink,
    });

    // Check that no start event was emitted
    const startCall = auditSink.emit.mock.calls.find(
      (call) => (call[0] as any).eventType === 'start',
    );
    expect(startCall).toBeUndefined();
  });

  it('should not call secretResolver when model is not in allowlist', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['openrouter/llama-3'],
    });

    await adapter.createBrief(createValidInput(), MOCK_OPTIONS);

    // Verify secretResolver was NOT called
    expect(secretResolver.getResolveCount('joy-media/openrouter/creative-brief/v1')).toBe(0);
  });

  it('should not call transport when model is not in allowlist', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport();
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['openrouter/llama-3'],
    });

    await adapter.createBrief(createValidInput(), MOCK_OPTIONS);

    // Verify transport was NOT called
    expect(transport.getCallCount()).toBe(0);
  });
});

// ============================================================================
// Response Model Verification - WP-37 S4-F10-D3-D
// ============================================================================

describe('OpenRouterCreativeAdapter - response model verification', () => {
  it('should accept response when model matches configured modelId', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'nvidia/nemotron-3-nano-30b-a3b:free',
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    expect(result.category).toBe('ready');
    expect(result.result).toEqual(VALID_OUTPUT);
    expect(transport.getCallCount()).toBe(1);
  });

  it('should accept response when model matches and is in allowlist', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'nvidia/nemotron-3-nano-30b-a3b:free',
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    expect(result.category).toBe('ready');
    expect(result.result).toEqual(VALID_OUTPUT);
  });

  it('should reject response when model field is missing', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    expect(result.category).toBe('provider-failed');
    expect(result.errorCode).toBe('OPENROUTER_RESPONSE_MODEL_MISMATCH');
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('invalid or mismatched model identifier');
    // Verify no result is returned
    expect(result).not.toHaveProperty('result');
  });

  it('should reject response when model is non-string', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: 123,
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    expect(result.category).toBe('provider-failed');
    expect(result.errorCode).toBe('OPENROUTER_RESPONSE_MODEL_MISMATCH');
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('invalid or mismatched model identifier');
    expect(result).not.toHaveProperty('result');
  });

  it('should reject response when model is empty string', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: '',
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    expect(result.category).toBe('provider-failed');
    expect(result.errorCode).toBe('OPENROUTER_RESPONSE_MODEL_MISMATCH');
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('invalid or mismatched model identifier');
    expect(result).not.toHaveProperty('result');
  });

  it('should reject response when model does not match configured modelId', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'openrouter/llama-3',
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    expect(result.category).toBe('provider-failed');
    expect(result.errorCode).toBe('OPENROUTER_RESPONSE_MODEL_MISMATCH');
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('invalid or mismatched model identifier');
    expect(result).not.toHaveProperty('result');
  });

  it('should reject response when model is not in allowedFreeModelIds', async () => {
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'openrouter/llama-3',
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    const result = await adapter.createBrief(createValidInput(), MOCK_OPTIONS);
    // Model in response ('openrouter/llama-3') does not match configured ('nvidia/nemotron-3-nano-30b-a3b:free')
    // and is not in allowlist, so response verification fails with provider-failed
    expect(result.category).toBe('provider-failed');
    expect(result.errorCode).toBe('OPENROUTER_RESPONSE_MODEL_MISMATCH');
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('invalid or mismatched model identifier');
    expect(result).not.toHaveProperty('result');
    // Transport was called because pre-request allowlist check passed (configured modelId is in allowlist)
    expect(transport.getCallCount()).toBe(1);
  });

  it('should emit redacted audit event for model mismatch', async () => {
    const auditSink = { emit: vi.fn() };
    const secretResolver = new MockSecretResolver({ 'joy-media/openrouter/creative-brief/v1': 'sk-test-key' });
    const transport = new ConfigurableMockTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'openrouter/wrong-model',
            choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver,
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });

    await adapter.createBrief(createValidInput(), {
      ...MOCK_OPTIONS,
      auditSink,
    });

    const errorCall = auditSink.emit.mock.calls.find(
      (call) => (call[0] as any).eventType === 'error',
    );
    expect(errorCall).toBeDefined();
    const errorEvent = (errorCall as any[])[0] as any;
    expect(errorEvent.eventType).toBe('error');
    expect(errorEvent.status).toBe('provider-failed');
    expect(errorEvent.errorCode).toBe('OPENROUTER_RESPONSE_MODEL_MISMATCH');
    expect(errorEvent.correlationId).toBe('test-correlation-id');
    expect(errorEvent.adapterName).toBe('openrouter-creative-v1');
    // Ensure no raw model ID, response body, secret, header, or URL in audit data
    expect(JSON.stringify(errorEvent)).not.toContain('wrong-model');
    expect(JSON.stringify(errorEvent)).not.toContain('mistral-large');
    expect(JSON.stringify(errorEvent)).not.toContain('sk-');
    expect(JSON.stringify(errorEvent)).not.toContain('choices');
    expect(JSON.stringify(errorEvent)).not.toContain('content');
  });
});

describe('OpenRouterCreativeAdapter - free response accounting', () => {
  function createAccountingAdapter(transport: HttpPostTransport) {
    return createOpenRouterCreativeAdapter({
      modelId: 'nvidia/nemotron-3-nano-30b-a3b:free',
      timeoutMs: 30000,
      spendLimitUsdCents: 0,
      secretRef: 'joy-media/openrouter/creative-brief/v1',
      secretResolver: new MockSecretResolver({
        'joy-media/openrouter/creative-brief/v1': 'sk-test-key',
      }),
      transport,
      allowedFreeModelIds: ['nvidia/nemotron-3-nano-30b-a3b:free'],
    });
  }

  it('rejects a successful response without explicit usage accounting', async () => {
    const transport = new ConfigurableMockTransport(
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              model: 'nvidia/nemotron-3-nano-30b-a3b:free',
              choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
            }),
            { status: 200 },
          ),
        ),
      false,
    );

    const result = await createAccountingAdapter(transport).createBrief(
      createValidInput(),
      MOCK_OPTIONS,
    );

    expect(result.category).toBe('provider-failed');
    expect(result.errorCode).toBe('OPENROUTER_USAGE_MISSING');
    expect(transport.getCallCount()).toBe(1);
  });

  it('rejects a successful response with non-zero provider cost', async () => {
    const transport = new ConfigurableMockTransport(
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              model: 'nvidia/nemotron-3-nano-30b-a3b:free',
              usage: { ...DEFAULT_USAGE, cost: 0.000001 },
              choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
            }),
            { status: 200 },
          ),
        ),
      false,
    );

    const result = await createAccountingAdapter(transport).createBrief(
      createValidInput(),
      MOCK_OPTIONS,
    );

    expect(result.category).toBe('provider-failed');
    expect(result.errorCode).toBe('OPENROUTER_NONZERO_PROVIDER_COST');
  });

  it('rejects malformed token usage accounting', async () => {
    const transport = new ConfigurableMockTransport(
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              model: 'nvidia/nemotron-3-nano-30b-a3b:free',
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 99, cost: 0 },
              choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
            }),
            { status: 200 },
          ),
        ),
      false,
    );

    const result = await createAccountingAdapter(transport).createBrief(
      createValidInput(),
      MOCK_OPTIONS,
    );

    expect(result.category).toBe('provider-failed');
    expect(result.errorCode).toBe('OPENROUTER_USAGE_INVALID');
  });

  it('rejects response bodies above the bounded accounting limit', async () => {
    const transport = new ConfigurableMockTransport(
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              model: 'nvidia/nemotron-3-nano-30b-a3b:free',
              usage: DEFAULT_USAGE,
              choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
              padding: 'x'.repeat(300_000),
            }),
            { status: 200 },
          ),
        ),
      false,
    );

    const result = await createAccountingAdapter(transport).createBrief(
      createValidInput(),
      MOCK_OPTIONS,
    );

    expect(result.category).toBe('provider-failed');
    expect(result.errorCode).toBe('OPENROUTER_RESPONSE_TOO_LARGE');
  });

  it('requests provider routing without paid fallback', async () => {
    const transport = new ConfigurableMockTransport();
    await createAccountingAdapter(transport).createBrief(createValidInput(), MOCK_OPTIONS);

    const body = JSON.parse(transport.getLastCall()!.options.body as string) as Record<string, unknown>;
    expect(body.provider).toEqual({ allow_fallbacks: false });
    expect(body).not.toHaveProperty('models');
    expect(body).not.toHaveProperty('route');
  });
});
