/**
 * Creative Brief Runtime Tests - WP-37 S4-F8
 *
 * Focused tests for the injectable Creative Brief runtime boundary.
 */

import { describe, it, expect, vi } from 'vitest';
import { UnavailableCreativeBriefRuntime, DEFAULT_CREATIVE_BRIEF_RUNTIME } from './creative-brief-runtime.js';
import type { CreativeBriefRuntime, CreativeBriefRuntimeContext } from './creative-brief-runtime.js';
import type { AsyncCreativeBriefOutcome, AsyncOutcomeCategory } from '@joy-media/agent-tools';

const mockServerRequest = {
  projectId: 'test-project-id',
  snapshotRevisionId: 'test-revision-id',
  snapshot: {},
  intelligence: {},
  request: {},
} as const;

const mockRuntimeContext: CreativeBriefRuntimeContext = {
  correlationId: 'test-correlation-id',
  timeoutMs: 30000,
  spendLimitUsdCents: 1000,
};

function makeOutcome(category: AsyncOutcomeCategory, brief?: any): AsyncCreativeBriefOutcome {
  return {
    category,
    brief,
    message: `Test ${category}`,
    errorCode: category.toUpperCase(),
    retryable: category === 'timeout' || category === 'unavailable',
    durationMs: category === 'ready' ? 100 : 0,
  };
}

describe('UnavailableCreativeBriefRuntime', () => {
  it('should return unavailable outcome', async () => {
    const runtime = new UnavailableCreativeBriefRuntime();
    const outcome = await runtime.execute(mockServerRequest as any, mockRuntimeContext);

    expect(outcome.category).toBe('unavailable');
    expect(outcome.errorCode).toBe('RUNTIME_UNAVAILABLE');
    expect(outcome.message).toBe('Creative brief runtime is not configured');
    expect(outcome.retryable).toBe(false);
    expect(outcome.brief).toBeUndefined();
  });

  it('should not make network calls', async () => {
    const runtime = new UnavailableCreativeBriefRuntime();
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = vi.fn(() => {
      fetchCalled = true;
      throw new Error('Unexpected network call');
    });

    try {
      await runtime.execute(mockServerRequest as any, mockRuntimeContext);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    }
  });
});

describe('DEFAULT_CREATIVE_BRIEF_RUNTIME', () => {
  it('should be unavailable runtime', () => {
    expect(DEFAULT_CREATIVE_BRIEF_RUNTIME).toBeInstanceOf(UnavailableCreativeBriefRuntime);
  });

  it('should return unavailable', async () => {
    const outcome = await DEFAULT_CREATIVE_BRIEF_RUNTIME.execute(
      mockServerRequest as any,
      mockRuntimeContext,
    );
    expect(outcome.category).toBe('unavailable');
  });
});

describe('CreativeBriefRuntime contract', () => {
  it('should have execute method', async () => {
    const runtime: CreativeBriefRuntime = {
      execute: vi.fn().mockResolvedValue(makeOutcome('ready')),
    };
    expect(typeof runtime.execute).toBe('function');
  });

  it('should return Promise of AsyncCreativeBriefOutcome', async () => {
    const runtime: CreativeBriefRuntime = {
      execute: vi.fn().mockResolvedValue(makeOutcome('ready')),
    };

    const result = runtime.execute(mockServerRequest as any, mockRuntimeContext);
    expect(result).toBeInstanceOf(Promise);

    const outcome = await result;
    expect(outcome).toHaveProperty('category');
    expect(outcome).toHaveProperty('retryable');
    expect(outcome).toHaveProperty('durationMs');
  });

  it('should propagate all failure categories', async () => {
    const categories: AsyncOutcomeCategory[] = [
      'unavailable', 'policy-denied', 'invalid-output',
      'provider-failed', 'timeout', 'cancelled',
    ];

    for (const category of categories) {
      const runtime: CreativeBriefRuntime = {
        execute: vi.fn().mockResolvedValue(makeOutcome(category)),
      };
      const outcome = await runtime.execute(mockServerRequest as any, mockRuntimeContext);
      expect(outcome.category).toBe(category);
    }
  });

  it('should receive request and context', async () => {
    let receivedRequest: any;
    let receivedContext: any;
    const runtime: CreativeBriefRuntime = {
      execute: vi.fn().mockImplementation((req, ctx) => {
        receivedRequest = req;
        receivedContext = ctx;
        return Promise.resolve(makeOutcome('ready'));
      }),
    };

    await runtime.execute(mockServerRequest as any, mockRuntimeContext);

    expect(receivedRequest).toEqual(mockServerRequest);
    expect(receivedContext).toEqual(mockRuntimeContext);
  });
});
