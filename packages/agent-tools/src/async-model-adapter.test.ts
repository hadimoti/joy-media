/**
 * Async Model Adapter Tests - WP-37 S4-F6
 *
 * Tests for the async runtime contract:
 * - AsyncCreativeModelAdapter interface
 * - AsyncAdapterOptions handling
 * - All typed failure categories
 * - Audit event sink
 * - Input immutability
 * - No network/provider activity
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  AsyncCreativeModelAdapter,
  AsyncOutcome,
  AsyncOutcomeCategory,
  AsyncAdapterOptions,
  AuditEventSink,
  FakeAsyncAdapterConfig,
} from './async-model-adapter.js';
import {
  createFakeAsyncModelAdapter,
  createValidFakeAsyncAdapter,
  createUnavailableFakeAsyncAdapter,
  createPolicyDeniedFakeAsyncAdapter,
  createInvalidOutputFakeAsyncAdapter,
  createProviderFailedFakeAsyncAdapter,
  createTimeoutFakeAsyncAdapter,
  createCancelledFakeAsyncAdapter,
} from './async-model-adapter.js';
import type { ModelAdapterInputV1, ModelAdapterOutputV1 } from './model-adapter.js';
import { createValidFakeAdapter } from './model-adapter.js';

// ==========================================================================
// Test Fixtures
// ==========================================================================

/**
 * Create a minimal valid ModelAdapterInputV1 for testing.
 */
function createTestInput(): ModelAdapterInputV1 {
  return {
    snapshot: {
      schemaVersion: 1 as const,
      projectId: 'test-project',
      revisionId: 'test-revision',
      capturedAt: '2026-01-01T00:00:00.000Z',
      composition: {
        durationUs: 1000000,
        aspectRatio: '16:9',
        frameRate: { num: 30, den: 1 } as const,
        width: 1920,
        height: 1080,
      },
      brand: {
        hasBrandKit: false,
        colorsAvailable: false,
        fontsAvailable: false,
        logoAvailable: false,
        voiceInstructionsAvailable: false,
        toneInstructionsAvailable: false,
        prohibitedClaims: [],
        prohibitedEffects: [],
        warnings: [],
      },
      scenes: [
        {
          id: 'scene-1',
          startUs: 0,
          endUs: 500000,
          purpose: 'hook' as const,
          elements: [],
          visualCoverage: 'adequate' as const,
          evidence: [],
        },
        {
          id: 'scene-2',
          startUs: 500000,
          endUs: 1000000,
          purpose: 'explanation' as const,
          elements: [],
          visualCoverage: 'adequate' as const,
          evidence: [],
        },
      ],
      timeline: {
        compositionId: 'comp-001' as const,
        durationUs: 1000000,
        frameRate: { num: 30, den: 1 } as const,
        width: 1920,
        height: 1080,
        aspectRatio: '16:9' as const,
        visualTrackCount: 1,
        audioTrackCount: 1,
        totalClipCount: 1,
        visualRowIds: ['row-001'] as const,
        audioRowIds: ['row-002'] as const,
      },
      assets: [
        {
          id: 'asset-1',
          kind: 'video',
          name: 'test-asset',
          durationUs: 500000,
          hasProvenance: false,
          isGenerated: false,
          warnings: [],
        },
      ],
      capabilities: {},
      warnings: [],
      truncation: {
        clipsOmitted: 0,
        assetsOmitted: 0,
        visualObjectsOmitted: 0,
        scenesOmitted: 0,
        totalEstimateBytes: 0,
      },
    },
    brandReadiness: {
      projectId: 'test-project',
      revisionId: 'test-revision',
      colorsAvailable: false,
      fontsAvailable: false,
      logoAvailable: false,
      voiceInstructionsAvailable: false,
      toneInstructionsAvailable: false,
      prohibitedClaims: [],
      prohibitedEffects: [],
      hasBrandKit: false,
      brandCompleteness: 'none' as const,
      missingComponents: [],
      warnings: [],
      evidence: [],
    },
    sceneCoverages: [
      {
        sceneId: 'scene-1',
        projectId: 'test-project',
        startUs: 0,
        endUs: 500000,
        durationUs: 500000,
        visualElementCount: 10,
        visualDensity: 'adequate' as const,
        hasVisualElements: true,
        hasAudio: true,
        hasNarration: true,
        audioDurationUs: 500000,
        narrationDurationUs: 300000,
        hasCaptions: false,
        captionWordCount: 0,
        captionLocale: undefined,
        captionCoverageRatio: 0,
        visualChangeSignals: [],
        audioGaps: [],
        captionGaps: [],
        evidence: [],
        rules: [],
      },
      {
        sceneId: 'scene-2',
        projectId: 'test-project',
        startUs: 500000,
        endUs: 1000000,
        durationUs: 500000,
        visualElementCount: 10,
        visualDensity: 'adequate' as const,
        hasVisualElements: true,
        hasAudio: true,
        hasNarration: true,
        audioDurationUs: 500000,
        narrationDurationUs: 300000,
        hasCaptions: false,
        captionWordCount: 0,
        captionLocale: undefined,
        captionCoverageRatio: 0,
        visualChangeSignals: [],
        audioGaps: [],
        captionGaps: [],
        evidence: [],
        rules: [],
      },
    ],
    projectReadiness: {
      projectId: 'test-project',
      revisionId: 'test-revision',
      destination: undefined,
      destinationAligned: true,
      destinationMismatch: undefined,
      durationTargetUs: undefined,
      compositionDurationUs: 1000000,
      durationAligned: true,
      durationGapUs: undefined,
      aspectRatio: '16:9',
      aspectRatioAligned: true,
      aspectRatioMismatch: undefined,
      captionAvailable: false,
      audioAvailable: false,
      generatedAssetsAvailable: false,
      readinessLevel: 'unknown' as const,
      blockers: [],
      warnings: [],
      sceneCount: 2,
      scenesWithVisuals: 2,
      scenesWithAudio: 0,
      scenesWithCaptions: 0,
      evidence: [],
    },
    rules: [],
    request: {
      snapshotRevisionId: 'test-revision',
      projectId: 'test-project',
      request: 'Improve pacing and add captions',
      scope: 'pacing',
    },
  };
}

/**
 * Create minimal async adapter options.
 */
function createTestOptions(
  overrides: Partial<AsyncAdapterOptions> = {},
): AsyncAdapterOptions {
  return {
    correlationId: 'test-correlation-id',
    ...overrides,
  };
}

/**
 * Capture audit events for testing.
 */
class CapturingAuditSink implements AuditEventSink {
  events: Array<Parameters<AuditEventSink['emit']>[0]> = [];

  emit(event: Parameters<AuditEventSink['emit']>[0]): void {
    this.events.push(event);
  }
}

// ==========================================================================
// Interface and Type Tests
// ==========================================================================

describe('Async Model Adapter - Types and Interfaces', () => {
  it('exports AsyncCreativeModelAdapter interface', () => {
    // This test ensures the interface is properly exported
    const adapter: AsyncCreativeModelAdapter = {
      adapterName: 'test-adapter',
      isTestOnly: true,
      createBrief: async (input, options) => ({
        category: 'ready',
        result: createValidFakeAdapter().createBrief(input),
        retryable: false,
        durationMs: 0,
      }),
    };
    expect(adapter.adapterName).toBe('test-adapter');
    expect(adapter.isTestOnly).toBe(true);
    expect(typeof adapter.createBrief).toBe('function');
  });

  it('exports all AsyncOutcomeCategory values', () => {
    const categories: AsyncOutcomeCategory[] = [
      'ready',
      'unavailable',
      'policy-denied',
      'invalid-output',
      'provider-failed',
      'timeout',
      'cancelled',
    ];
    expect(categories).toHaveLength(7);
    for (const category of categories) {
      expect(category).toBeTruthy();
    }
  });

  it('AsyncOutcome has correct structure for ready category', () => {
    const input = createTestInput();
    const output = createValidFakeAdapter().createBrief(input);
    const outcome: AsyncOutcome<ModelAdapterOutputV1> = {
      category: 'ready',
      result: output,
      retryable: false,
      durationMs: 10,
    };
    expect(outcome.category).toBe('ready');
    expect(outcome.result).toBeDefined();
    expect(outcome.retryable).toBe(false);
    expect(outcome.durationMs).toBe(10);
  });

  it('AsyncOutcome has correct structure for error categories', () => {
    const errorOutcomes: AsyncOutcome[] = [
      { category: 'unavailable', message: 'Not configured', retryable: true, durationMs: 5 },
      { category: 'policy-denied', message: 'Not allowed', retryable: false, durationMs: 0 },
      { category: 'invalid-output', message: 'Validation failed', retryable: false, durationMs: 10 },
      { category: 'provider-failed', message: 'API error', errorCode: 'API_ERROR', retryable: true, durationMs: 15 },
      { category: 'timeout', message: 'Timed out', retryable: true, durationMs: 30000 },
      { category: 'cancelled', message: 'Aborted', retryable: false, durationMs: 50 },
    ];

    for (const outcome of errorOutcomes) {
      expect(outcome.category).not.toBe('ready');
      expect(outcome.result).toBeUndefined();
      expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});

// ==========================================================================
// Valid Deterministic Async Result Tests
// ==========================================================================

describe('Async Model Adapter - Valid Results', () => {
  it('returns valid deterministic async result', async () => {
    const adapter = createValidFakeAsyncAdapter();
    const input = createTestInput();
    const options = createTestOptions();

    const outcome = await adapter.createBrief(input, options);

    expect(outcome.category).toBe('ready');
    expect(outcome.result).toBeDefined();
    expect(outcome.result!.interpretedGoal).toBeDefined();
    expect(outcome.result!.interpretedGoal.userIntent).toBe(input.request.request);
    expect(outcome.result!.recommendations).toBeInstanceOf(Array);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.retryable).toBe(false);
  });

  it('produces byte-stable output for identical inputs', async () => {
    const adapter = createValidFakeAsyncAdapter(42);
    const input = createTestInput();
    const options = createTestOptions();

    const outcome1 = await adapter.createBrief(input, options);
    const outcome2 = await adapter.createBrief(input, options);

    expect(outcome1.category).toBe(outcome2.category);
    expect(JSON.stringify(outcome1.result)).toBe(JSON.stringify(outcome2.result));
  });

  it('different seeds produce different outputs', async () => {
    const adapter1 = createValidFakeAsyncAdapter(42);
    const adapter2 = createValidFakeAsyncAdapter(99);
    const input = createTestInput();
    const options = createTestOptions();

    const outcome1 = await adapter1.createBrief(input, options);
    const outcome2 = await adapter2.createBrief(input, options);

    expect(outcome1.category).toBe('ready');
    expect(outcome2.category).toBe('ready');
    // Different seeds should produce different recommendation IDs
    expect(outcome1.result!.recommendations[0]?.id).not.toBe(
      outcome2.result!.recommendations[0]?.id,
    );
  });

  it('adapter has correct metadata', async () => {
    const adapter = createValidFakeAsyncAdapter();

    expect(adapter.adapterName).toContain('fake-async-valid');
    expect(adapter.isTestOnly).toBe(true);
  });
});

// ==========================================================================
// Typed Failure Category Tests
// ==========================================================================

describe('Async Model Adapter - Failure Categories', () => {
  it('returns unavailable outcome', async () => {
    const adapter = createUnavailableFakeAsyncAdapter();
    const input = createTestInput();
    const options = createTestOptions();

    const outcome = await adapter.createBrief(input, options);

    expect(outcome.category).toBe('unavailable');
    expect(outcome.result).toBeUndefined();
    expect(outcome.message).toContain('not configured');
    expect(outcome.errorCode).toBe('ADAPTER_NOT_CONFIGURED');
    expect(outcome.retryable).toBe(true);
  });

  it('returns policy-denied outcome', async () => {
    const adapter = createPolicyDeniedFakeAsyncAdapter();
    const input = createTestInput();
    const options = createTestOptions();

    const outcome = await adapter.createBrief(input, options);

    expect(outcome.category).toBe('policy-denied');
    expect(outcome.result).toBeUndefined();
    expect(outcome.message).toContain('denied by server policy');
    expect(outcome.errorCode).toBe('NOT_OPTED_IN');
    expect(outcome.retryable).toBe(false);
  });

  it('returns invalid-output outcome', async () => {
    const adapter = createInvalidOutputFakeAsyncAdapter();
    const input = createTestInput();
    const options = createTestOptions();

    const outcome = await adapter.createBrief(input, options);

    expect(outcome.category).toBe('invalid-output');
    expect(outcome.result).toBeUndefined();
    expect(outcome.message).toContain('failed validation');
    expect(outcome.errorCode).toBe('INVALID_OUTPUT_STRUCTURE');
    expect(outcome.retryable).toBe(false);
  });

  it('returns provider-failed outcome', async () => {
    const adapter = createProviderFailedFakeAsyncAdapter();
    const input = createTestInput();
    const options = createTestOptions();

    const outcome = await adapter.createBrief(input, options);

    expect(outcome.category).toBe('provider-failed');
    expect(outcome.result).toBeUndefined();
    expect(outcome.message).toContain('error');
    expect(outcome.errorCode).toBe('PROVIDER_INTERNAL_ERROR');
    expect(outcome.retryable).toBe(true);
  });

  it('returns timeout outcome', async () => {
    const adapter = createTimeoutFakeAsyncAdapter();
    const input = createTestInput();
    const options = createTestOptions();

    const outcome = await adapter.createBrief(input, options);

    expect(outcome.category).toBe('timeout');
    expect(outcome.result).toBeUndefined();
    expect(outcome.message).toContain('timeout');
    expect(outcome.retryable).toBe(true);
  });

  it('returns cancelled outcome', async () => {
    const adapter = createCancelledFakeAsyncAdapter();
    const input = createTestInput();
    const options = createTestOptions();

    const outcome = await adapter.createBrief(input, options);

    expect(outcome.category).toBe('cancelled');
    expect(outcome.result).toBeUndefined();
    expect(outcome.message).toContain('cancelled');
    expect(outcome.retryable).toBe(false);
  });
});

// ==========================================================================
// Already-Aborted Signal Tests
// ==========================================================================

describe('Async Model Adapter - AbortSignal Handling', () => {
  it('handles already-aborted signal', async () => {
    const adapter = createValidFakeAsyncAdapter();
    const input = createTestInput();

    const controller = new AbortController();
    controller.abort(); // Abort immediately

    const options: AsyncAdapterOptions = {
      correlationId: 'test-aborted',
      signal: controller.signal,
    };

    const outcome = await adapter.createBrief(input, options);

    expect(outcome.category).toBe('cancelled');
    expect(outcome.message).toContain('already aborted');
    expect(outcome.retryable).toBe(false);
  });

  it('handles abort during processing', async () => {
    // Use an adapter with a delay to allow aborting during processing
    const adapter = createFakeAsyncModelAdapter({
      mode: 'valid',
      responseDelayMs: 100,
    });
    const input = createTestInput();

    const controller = new AbortController();

    // Abort after a short delay
    setTimeout(() => controller.abort(), 25);

    const options: AsyncAdapterOptions = {
      correlationId: 'test-abort-during',
      signal: controller.signal,
    };

    const outcome = await adapter.createBrief(input, options);

    expect(outcome.category).toBe('cancelled');
    expect(outcome.message).toContain('aborted');
    expect(outcome.retryable).toBe(false);
  });
});

// ==========================================================================
// Timeout Budget Handling Tests
// ==========================================================================

describe('Async Model Adapter - Timeout Handling', () => {
  it('handles immediate timeout (timeoutMs = 0)', async () => {
    const adapter = createValidFakeAsyncAdapter();
    const input = createTestInput();
    const options: AsyncAdapterOptions = {
      correlationId: 'test-timeout-0',
      timeoutMs: 0,
    };

    const outcome = await adapter.createBrief(input, options);

    expect(outcome.category).toBe('timeout');
    expect(outcome.message).toContain('Immediate timeout');
    expect(outcome.retryable).toBe(true);
  });

  it('handles negative timeout', async () => {
    const adapter = createValidFakeAsyncAdapter();
    const input = createTestInput();
    const options: AsyncAdapterOptions = {
      correlationId: 'test-timeout-negative',
      timeoutMs: -1,
    };

    const outcome = await adapter.createBrief(input, options);

    expect(outcome.category).toBe('timeout');
    expect(outcome.retryable).toBe(true);
  });

  it('handles explicit timeout mode', async () => {
    const adapter = createTimeoutFakeAsyncAdapter();
    const input = createTestInput();
    const options: AsyncAdapterOptions = {
      correlationId: 'test-timeout-mode',
      timeoutMs: 5000,
    };

    const outcome = await adapter.createBrief(input, options);

    expect(outcome.category).toBe('timeout');
    expect(outcome.retryable).toBe(true);
  });
});

// ==========================================================================
// Input Immutability Tests
// ==========================================================================

describe('Async Model Adapter - Input Immutability', () => {
  it('does not mutate the input object', async () => {
    const adapter = createValidFakeAsyncAdapter();
    const input = createTestInput();
    const options = createTestOptions();

    // Deep clone the input for comparison
    const inputClone = JSON.parse(JSON.stringify(input));

    await adapter.createBrief(input, options);

    // Verify input was not mutated
    expect(input).toEqual(inputClone);
  });

  it('does not mutate nested input objects', async () => {
    const adapter = createValidFakeAsyncAdapter();
    const input = createTestInput();
    const options = createTestOptions();

    // Store references to nested objects
    const snapshotRef = input.snapshot;
    const scenesRef = input.snapshot.scenes;
    const requestRef = input.request;

    await adapter.createBrief(input, options);

    // Verify references are unchanged
    expect(input.snapshot).toBe(snapshotRef);
    expect(input.snapshot.scenes).toBe(scenesRef);
    expect(input.request).toBe(requestRef);
  });
});

// ==========================================================================
// Audit Event Sink Tests
// ==========================================================================

describe('Async Model Adapter - Audit Events', () => {
  it('emits start event for valid outcome', async () => {
    const adapter = createValidFakeAsyncAdapter();
    const input = createTestInput();
    const auditSink = new CapturingAuditSink();
    const options: AsyncAdapterOptions = {
      correlationId: 'test-audit-valid',
      auditSink,
    };

    await adapter.createBrief(input, options);

    expect(auditSink.events.length).toBeGreaterThanOrEqual(1);
    const startEvent = auditSink.events.find(e => e.eventType === 'start');
    expect(startEvent).toBeDefined();
    expect(startEvent!.correlationId).toBe('test-audit-valid');
    expect(startEvent!.adapterName).toContain('fake-async-valid');
    expect(startEvent!.status).toBe('valid');
  });

  it('emits end event for valid outcome', async () => {
    const adapter = createValidFakeAsyncAdapter();
    const input = createTestInput();
    const auditSink = new CapturingAuditSink();
    const options: AsyncAdapterOptions = {
      correlationId: 'test-audit-end',
      auditSink,
    };

    await adapter.createBrief(input, options);

    const endEvent = auditSink.events.find(e => e.eventType === 'end');
    expect(endEvent).toBeDefined();
    expect(endEvent!.status).toBe('ready');
    expect(endEvent!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits error event for failure outcome', async () => {
    const adapter = createUnavailableFakeAsyncAdapter();
    const input = createTestInput();
    const auditSink = new CapturingAuditSink();
    const options: AsyncAdapterOptions = {
      correlationId: 'test-audit-error',
      auditSink,
    };

    await adapter.createBrief(input, options);

    const errorEvent = auditSink.events.find(e => e.eventType === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.status).toBe('unavailable');
    expect(errorEvent!.errorCode).toBe('ADAPTER_NOT_CONFIGURED');
  });

  it('audit events contain no sensitive data', async () => {
    const adapter = createValidFakeAsyncAdapter();
    const input = createTestInput();
    const auditSink = new CapturingAuditSink();
    const options: AsyncAdapterOptions = {
      correlationId: 'test-audit-no-secrets',
      auditSink,
    };

    await adapter.createBrief(input, options);

    for (const event of auditSink.events) {
      // Verify no request text or other sensitive data
      const eventStr = JSON.stringify(event);
      expect(eventStr).not.toContain(input.request.request);
      expect(eventStr).not.toContain('sk-'); // No API keys
      expect(eventStr).not.toContain('http'); // No URLs
    }
  });

  it('audit events include durationMs for completed requests', async () => {
    const adapter = createValidFakeAsyncAdapter();
    const input = createTestInput();
    const auditSink = new CapturingAuditSink();
    const options: AsyncAdapterOptions = {
      correlationId: 'test-audit-duration',
      auditSink,
    };

    await adapter.createBrief(input, options);

    const endEvent = auditSink.events.find(e => e.eventType === 'end');
    expect(endEvent).toBeDefined();
    expect(endEvent!.durationMs).toBeDefined();
    expect(endEvent!.durationMs!).toBeGreaterThanOrEqual(0);
  });
});

// ==========================================================================
// No Network/Provider Activity Tests
// ==========================================================================

describe('Async Model Adapter - No Network Activity', () => {
  it('fake adapter never makes network calls', async () => {
    // Mock fetch to detect any network activity
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = vi.fn(() => {
      fetchCalled = true;
      throw new Error('Network call detected!');
    });

    try {
      const adapter = createValidFakeAsyncAdapter();
      const input = createTestInput();
      const options = createTestOptions();

      const outcome = await adapter.createBrief(input, options);

      expect(outcome.category).toBe('ready');
      expect(fetchCalled).toBe(false);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    }
  });

  it('all failure modes are simulated without real providers', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = vi.fn(() => {
      fetchCalled = true;
      throw new Error('Network call detected!');
    });

    try {
      const modes = [
        createUnavailableFakeAsyncAdapter(),
        createPolicyDeniedFakeAsyncAdapter(),
        createInvalidOutputFakeAsyncAdapter(),
        createProviderFailedFakeAsyncAdapter(),
        createTimeoutFakeAsyncAdapter(),
        createCancelledFakeAsyncAdapter(),
      ];

      const input = createTestInput();
      const options = createTestOptions();

      for (const adapter of modes) {
        fetchCalled = false;
        await adapter.createBrief(input, options);
        expect(fetchCalled).toBe(false);
      }

      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    }
  });
});

// ==========================================================================
// Fake Adapter Not Exported from Package Root Tests
// ==========================================================================

describe('Async Model Adapter - Production Boundaries', () => {
  it('fake adapter is marked as testOnly', async () => {
    const fakeAdapters = [
      createValidFakeAsyncAdapter(),
      createUnavailableFakeAsyncAdapter(),
      createPolicyDeniedFakeAsyncAdapter(),
      createInvalidOutputFakeAsyncAdapter(),
      createProviderFailedFakeAsyncAdapter(),
      createTimeoutFakeAsyncAdapter(),
      createCancelledFakeAsyncAdapter(),
    ];

    for (const adapter of fakeAdapters) {
      expect(adapter.isTestOnly).toBe(true);
      expect(adapter.adapterName).toContain('fake');
    }
  });

  it('custom config adapter is marked as testOnly', async () => {
    const adapter = createFakeAsyncModelAdapter({
      mode: 'valid',
      seed: 123,
    });

    expect(adapter.isTestOnly).toBe(true);
    expect(adapter.adapterName).toContain('fake-async-valid');
  });

  it('adapterName identifies fake adapters', async () => {
    const adapters = [
      createValidFakeAsyncAdapter(),
      createUnavailableFakeAsyncAdapter(),
      createPolicyDeniedFakeAsyncAdapter(),
      createInvalidOutputFakeAsyncAdapter(),
      createProviderFailedFakeAsyncAdapter(),
      createTimeoutFakeAsyncAdapter(),
      createCancelledFakeAsyncAdapter(),
    ];

    for (const adapter of adapters) {
      expect(adapter.adapterName.toLowerCase()).toContain('fake');
    }
  });
});

// ==========================================================================
// Edge Cases and Boundary Tests
// ==========================================================================

describe('Async Model Adapter - Edge Cases', () => {
  it('handles minimal input with single scene', async () => {
    const adapter = createValidFakeAsyncAdapter();
    const minimalInput: ModelAdapterInputV1 = {
      snapshot: {
        schemaVersion: 1 as const,
        projectId: 'minimal',
        revisionId: 'rev-1',
        capturedAt: '2026-01-01T00:00:00.000Z',
        composition: {
          durationUs: 1000,
          aspectRatio: '1:1',
          frameRate: { num: 24, den: 1 } as const,
          width: 100,
          height: 100,
        },
        brand: {
          hasBrandKit: false,
          colorsAvailable: false,
          fontsAvailable: false,
          logoAvailable: false,
          voiceInstructionsAvailable: false,
          toneInstructionsAvailable: false,
          prohibitedClaims: [],
          prohibitedEffects: [],
          warnings: [],
        },
        scenes: [
          {
            id: 'only-scene',
            startUs: 0,
            endUs: 1000,
            purpose: 'hook' as const,
            elements: [],
            visualCoverage: 'adequate' as const,
            evidence: [],
          },
        ],
        timeline: {
          compositionId: 'comp-001' as const,
          durationUs: 1000,
          frameRate: { num: 24, den: 1 } as const,
          width: 100,
          height: 100,
          aspectRatio: '1:1' as const,
          visualTrackCount: 1,
          audioTrackCount: 1,
          totalClipCount: 1,
          visualRowIds: ['row-001'] as const,
          audioRowIds: ['row-002'] as const,
        },
        assets: [],
        capabilities: {},
        warnings: [],
        truncation: {
          clipsOmitted: 0,
          assetsOmitted: 0,
          visualObjectsOmitted: 0,
          scenesOmitted: 0,
          totalEstimateBytes: 0,
        },
      },
      brandReadiness: {
        projectId: 'minimal',
        revisionId: 'rev-1',
        colorsAvailable: false,
        fontsAvailable: false,
        logoAvailable: false,
        voiceInstructionsAvailable: false,
        toneInstructionsAvailable: false,
        prohibitedClaims: [],
        prohibitedEffects: [],
        hasBrandKit: false,
        brandCompleteness: 'none' as const,
        missingComponents: [],
        warnings: [],
        evidence: [],
      },
      sceneCoverages: [],
      projectReadiness: {
        projectId: 'minimal',
        revisionId: 'rev-1',
        destination: undefined,
        destinationAligned: true,
        destinationMismatch: undefined,
        durationTargetUs: undefined,
        compositionDurationUs: 1000,
        durationAligned: true,
        durationGapUs: undefined,
        aspectRatio: '1:1',
        aspectRatioAligned: true,
        aspectRatioMismatch: undefined,
        captionAvailable: false,
        audioAvailable: false,
        generatedAssetsAvailable: false,
        readinessLevel: 'unknown' as const,
        blockers: [],
        warnings: [],
        sceneCount: 1,
        scenesWithVisuals: 1,
        scenesWithAudio: 0,
        scenesWithCaptions: 0,
        evidence: [],
      },
      rules: [],
      request: {
        snapshotRevisionId: 'rev-1',
        projectId: 'minimal',
        request: 'test',
        scope: 'pacing',
      },
    };
    const options = createTestOptions();

    const outcome = await adapter.createBrief(minimalInput, options);

    expect(outcome.category).toBe('ready');
    expect(outcome.result).toBeDefined();
    expect(outcome.result!.interpretedGoal.userIntent).toBe('test');
  });

  it('handles input with empty arrays', async () => {
    const adapter = createValidFakeAsyncAdapter();
    const emptyArraysInput: ModelAdapterInputV1 = {
      snapshot: {
        schemaVersion: 1 as const,
        projectId: 'empty',
        revisionId: 'rev-1',
        capturedAt: '2026-01-01T00:00:00.000Z',
        composition: {
          durationUs: 1000,
          aspectRatio: '16:9',
          frameRate: { num: 30, den: 1 } as const,
          width: 1920,
          height: 1080,
        },
        brand: {
          hasBrandKit: false,
          colorsAvailable: false,
          fontsAvailable: false,
          logoAvailable: false,
          voiceInstructionsAvailable: false,
          toneInstructionsAvailable: false,
          prohibitedClaims: [],
          prohibitedEffects: [],
          warnings: [],
        },
        scenes: [],
        timeline: {
          compositionId: 'comp-001' as const,
          durationUs: 1000,
          frameRate: { num: 30, den: 1 } as const,
          width: 1920,
          height: 1080,
          aspectRatio: '16:9' as const,
          visualTrackCount: 0,
          audioTrackCount: 0,
          totalClipCount: 0,
          visualRowIds: [] as const,
          audioRowIds: [] as const,
        },
        assets: [],
        capabilities: {},
        warnings: [],
        truncation: {
          clipsOmitted: 0,
          assetsOmitted: 0,
          visualObjectsOmitted: 0,
          scenesOmitted: 0,
          totalEstimateBytes: 0,
        },
      },
      brandReadiness: {
        projectId: 'empty',
        revisionId: 'rev-1',
        colorsAvailable: false,
        fontsAvailable: false,
        logoAvailable: false,
        voiceInstructionsAvailable: false,
        toneInstructionsAvailable: false,
        prohibitedClaims: [],
        prohibitedEffects: [],
        hasBrandKit: false,
        brandCompleteness: 'none' as const,
        missingComponents: [],
        warnings: [],
        evidence: [],
      },
      sceneCoverages: [],
      projectReadiness: {
        projectId: 'empty',
        revisionId: 'rev-1',
        destination: undefined,
        destinationAligned: true,
        destinationMismatch: undefined,
        durationTargetUs: undefined,
        compositionDurationUs: 1000,
        durationAligned: true,
        durationGapUs: undefined,
        aspectRatio: '16:9',
        aspectRatioAligned: true,
        aspectRatioMismatch: undefined,
        captionAvailable: false,
        audioAvailable: false,
        generatedAssetsAvailable: false,
        readinessLevel: 'unknown' as const,
        blockers: [],
        warnings: [],
        sceneCount: 0,
        scenesWithVisuals: 0,
        scenesWithAudio: 0,
        scenesWithCaptions: 0,
        evidence: [],
      },
      rules: [],
      request: {
        snapshotRevisionId: 'rev-1',
        projectId: 'empty',
        request: '',
        scope: 'pacing',
      },
    };
    const options = createTestOptions();

    const outcome = await adapter.createBrief(emptyArraysInput, options);

    expect(outcome.category).toBe('ready');
    expect(outcome.result).toBeDefined();
  });

  it('respects processingTimeMs from config', async () => {
    const processingTimeMs = 123;
    const adapter = createFakeAsyncModelAdapter({
      mode: 'valid',
      processingTimeMs,
    });
    const input = createTestInput();
    const options = createTestOptions();

    const outcome = await adapter.createBrief(input, options);

    expect(outcome.category).toBe('ready');
    expect(outcome.result!.meta?.processingTimeMs).toBe(processingTimeMs);
  });

  it('handles missing correlationId gracefully', async () => {
    const adapter = createValidFakeAsyncAdapter();
    const input = createTestInput();
    // @ts-expect-error - testing runtime behavior with missing required field
    const options: AsyncAdapterOptions = {};

    // correlationId is required by type but adapter handles undefined gracefully
    const outcome = await adapter.createBrief(input, options);
    expect(outcome.category).toBe('ready');
  });
});
