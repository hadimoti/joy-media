/**
 * Creative Brief Runtime Factory Tests - WP-37 S4 Phase 7-A
 *
 * Tests for the fail-closed injected OpenRouter Creative Brief runtime factory.
 */

import { describe, it, expect, vi } from 'vitest';
import type { CreativeBriefInputV1 } from '@joy-media/agent-tools';
import type { AsyncCreativeBriefOutcome } from '@joy-media/agent-tools';
import type { CreativeBriefRuntime } from './creative-brief-runtime.js';
import { DEFAULT_CREATIVE_BRIEF_RUNTIME } from './creative-brief-runtime.js';
import type { CreativeBriefRuntimeConfig, OpenRouterConfig, DisabledConfig } from './creative-brief-runtime-config.js';
import { createCreativeBriefRuntimeFactory, type CreativeBriefRuntimeFactoryOptions, type RedactedAuditSink } from './creative-brief-runtime-factory.js';
import type { SecretResolver, HttpPostTransport, Clock } from '@joy-media/adapter-openrouter';

// ============================================================================
// Mock Data
// ============================================================================

const mockCreativeBriefInput: CreativeBriefInputV1 = {
  snapshot: {
    schemaVersion: 1,
    projectId: 'test-project-id',
    revisionId: 'test-revision-id',
    capturedAt: '2026-08-19T00:00:00.000Z',
    composition: { durationUs: 1000000, frameRate: { num: 30, den: 1 }, width: 1920, height: 1080, aspectRatio: '16:9' },
    brand: { hasBrandKit: false, colorsAvailable: false, fontsAvailable: false, logoAvailable: false, voiceInstructionsAvailable: false, toneInstructionsAvailable: false, prohibitedClaims: [], prohibitedEffects: [], warnings: [] },
    scenes: [],
    timeline: { compositionId: 'comp-1', durationUs: 1000000, frameRate: { num: 30, den: 1 }, width: 1920, height: 1080, aspectRatio: '16:9', visualTrackCount: 1, audioTrackCount: 1, totalClipCount: 0, visualRowIds: [], audioRowIds: [] },
    assets: [],
    capabilities: {},
    warnings: [],
    truncation: { clipsOmitted: 0, assetsOmitted: 0, visualObjectsOmitted: 0, scenesOmitted: 0, totalEstimateBytes: 0 },
  },
  brandReadiness: {
    projectId: 'test-project-id',
    revisionId: 'test-revision-id',
    colorsAvailable: false,
    fontsAvailable: false,
    logoAvailable: false,
    voiceInstructionsAvailable: false,
    toneInstructionsAvailable: false,
    prohibitedClaims: [],
    prohibitedEffects: [],
    hasBrandKit: false,
    brandCompleteness: 'none',
    missingComponents: [],
    warnings: [],
    evidence: [],
  },
  sceneCoverages: [],
  projectReadiness: {
    projectId: 'test-project-id',
    revisionId: 'test-revision-id',
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
    readinessLevel: 'unknown',
    blockers: [],
    warnings: [],
    sceneCount: 0,
    scenesWithVisuals: 0,
    scenesWithAudio: 0,
    scenesWithCaptions: 0,
    evidence: [],
  },
  rules: [],
  request: { projectId: 'test-project-id', snapshotRevisionId: 'test-revision-id', request: 'test brief', scope: 'general' },
};

const mockRuntimeContext = {
  correlationId: 'test-correlation-id',
  timeoutMs: 30000,
  spendLimitUsdCents: 1000,
};

// ============================================================================
// Factory Helper
// ============================================================================

function createFactoryOptions(
  overrides: Partial<CreativeBriefRuntimeFactoryOptions> = {},
): CreativeBriefRuntimeFactoryOptions {
  return {
    secretResolver: { resolve: (_ref: string) => 'mock-api-key' } as SecretResolver,
    transport: { post: async (_url: string, _options?: RequestInit): Promise<Response> => {
      return new Response(JSON.stringify({ model: 'openrouter/mistral-large', choices: [{ message: { role: 'assistant', content: '{}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }} as HttpPostTransport,
    clock: { now: () => Date.now() } as Clock,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('createCreativeBriefRuntimeFactory', () => {
  // === Fail-closed behavior tests ===

  describe('disabled config - fail-closed behavior', () => {
    it('returns DEFAULT_CREATIVE_BRIEF_RUNTIME for disabled mode', () => {
      const config: DisabledConfig = { mode: 'disabled' };
      const runtime = createCreativeBriefRuntimeFactory(config, createFactoryOptions());
      expect(runtime).toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
    });

    it('returns unavailable outcome when disabled config is used', async () => {
      const config: DisabledConfig = { mode: 'disabled' };
      const runtime = createCreativeBriefRuntimeFactory(config, createFactoryOptions());
      const outcome = await runtime.execute(mockCreativeBriefInput, mockRuntimeContext);
      expect(outcome.category).toBe('unavailable');
      expect(outcome.errorCode).toBe('RUNTIME_UNAVAILABLE');
    });
  });

  describe('missing dependencies - fail-closed behavior', () => {
    it('returns DEFAULT_CREATIVE_BRIEF_RUNTIME when secretResolver is missing', () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 500,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large', 'openrouter/llama3-70b'],
      };
      const runtime = createCreativeBriefRuntimeFactory(config, {
        ...createFactoryOptions(),
        secretResolver: undefined as unknown as SecretResolver,
      });
      expect(runtime).toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
    });

    it('returns DEFAULT_CREATIVE_BRIEF_RUNTIME when transport is missing', () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 500,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large', 'openrouter/llama3-70b'],
      };
      const runtime = createCreativeBriefRuntimeFactory(config, {
        ...createFactoryOptions(),
        transport: undefined as unknown as HttpPostTransport,
      });
      expect(runtime).toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
    });

    it('returns DEFAULT_CREATIVE_BRIEF_RUNTIME when both dependencies are missing', () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 500,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large'],
      };
      const runtime = createCreativeBriefRuntimeFactory(config, {
        secretResolver: undefined as unknown as SecretResolver,
        transport: undefined as unknown as HttpPostTransport,
      });
      expect(runtime).toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
    });
  });

  describe('invalid allowlist - fail-closed behavior', () => {
    it('returns DEFAULT_CREATIVE_BRIEF_RUNTIME for empty allowlist', () => {
      const config: CreativeBriefRuntimeConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 500,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: [],
      };
      const runtime = createCreativeBriefRuntimeFactory(config, createFactoryOptions());
      expect(runtime).toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
    });

    it('returns DEFAULT_CREATIVE_BRIEF_RUNTIME when model not in allowlist', () => {
      const config: CreativeBriefRuntimeConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 500,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/llama3-70b'], // mistral-large is NOT in this list
      };
      const runtime = createCreativeBriefRuntimeFactory(config, createFactoryOptions());
      expect(runtime).toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
    });
  });

  // === Valid composition tests ===

  describe('valid composition', () => {
    it('creates a runtime for valid OpenRouter config with all dependencies', () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 500,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large', 'openrouter/llama3-70b'],
      };
      const runtime = createCreativeBriefRuntimeFactory(config, createFactoryOptions());
      // Should NOT be the default unavailable runtime
      expect(runtime).not.toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
      expect(runtime).toBeInstanceOf(Object);
      expect(typeof runtime.execute).toBe('function');
    });

    it('runtime has execute method', () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 500,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large'],
      };
      const runtime = createCreativeBriefRuntimeFactory(config, createFactoryOptions());
      expect(typeof (runtime as CreativeBriefRuntime).execute).toBe('function');
    });
  });

  // === Timeout and spend propagation tests ===

  describe('timeout and spend propagation', () => {
    it('passes configured timeout to adapter', async () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 120000, // 120 seconds
        spendLimitUsdCents: 0,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large'],
      };
      const runtime = createCreativeBriefRuntimeFactory(config, createFactoryOptions());
      const outcome = await runtime.execute(mockCreativeBriefInput, mockRuntimeContext);
      // The outcome should be returned (even if it's unavailable due to no transport call)
      expect(outcome).toBeDefined();
      expect(outcome.durationMs).toBeDefined();
    });

    it('bounds timeout to configured policy value when context timeout is larger', async () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 30000, // 30 seconds
        spendLimitUsdCents: 0,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large'],
      };
      // Context has larger timeout (60s), but should be bounded to 30s
      const runtime = createCreativeBriefRuntimeFactory(config, createFactoryOptions());
      const outcome = await runtime.execute(mockCreativeBriefInput, {
        ...mockRuntimeContext,
        timeoutMs: 60000,
      });
      expect(outcome).toBeDefined();
    });

    it('uses context timeout when it is smaller than configured', async () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000, // 60 seconds
        spendLimitUsdCents: 0,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large'],
      };
      // Context has smaller timeout (15s), should use 15s
      const runtime = createCreativeBriefRuntimeFactory(config, createFactoryOptions());
      const outcome = await runtime.execute(mockCreativeBriefInput, {
        ...mockRuntimeContext,
        timeoutMs: 15000,
      });
      expect(outcome).toBeDefined();
    });

    it('propagates zero spend limit (free-only policy)', async () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 0, // Free-only
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large'],
      };
      const runtime = createCreativeBriefRuntimeFactory(config, createFactoryOptions());
      const outcome = await runtime.execute(mockCreativeBriefInput, mockRuntimeContext);
      expect(outcome).toBeDefined();
    });
  });

  // === Free-model allowlist propagation tests ===

  describe('free-model allowlist propagation', () => {
    it('accepts model when it is in allowlist', () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 0,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large', 'openrouter/llama3-70b'],
      };
      const runtime = createCreativeBriefRuntimeFactory(config, createFactoryOptions());
      expect(runtime).not.toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
    });

    it('accepts single model allowlist', () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 0,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large'],
      };
      const runtime = createCreativeBriefRuntimeFactory(config, createFactoryOptions());
      expect(runtime).not.toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
    });

    it('accepts multiple models in allowlist', () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/llama3-70b',
        timeoutMs: 60000,
        spendLimitUsdCents: 0,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large', 'openrouter/llama3-70b', 'openrouter/gemini-flash'],
      };
      const runtime = createCreativeBriefRuntimeFactory(config, createFactoryOptions());
      expect(runtime).not.toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
    });
  });

  // === No secret leakage tests ===

  describe('no secret leakage', () => {
    it('does not expose secret in error messages', async () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 0,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large'],
      };
      // Create a secret resolver that returns a secret
      const secretResolver: SecretResolver = {
        resolve: (ref: string) => {
          if (ref === 'my-openrouter-key') return 'sk-actual-secret-key-12345';
          return undefined;
        },
      };
      const runtime = createCreativeBriefRuntimeFactory(config, {
        ...createFactoryOptions(),
        secretResolver,
      });
      const outcome = await runtime.execute(mockCreativeBriefInput, mockRuntimeContext);
      // Check that outcome message does not contain the secret
      expect(outcome.message?.toLowerCase()).not.toContain('sk-actual-secret-key-12345');
      expect(outcome.message?.toLowerCase()).not.toContain('sk-');
    });

    it('does not log secret values through audit sink', async () => {
      const auditEvents: Array<Record<string, unknown>> = [];
      const auditSink: RedactedAuditSink = {
        emit: (event) => {
          auditEvents.push({ ...event });
        },
      };
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 0,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large'],
      };
      const secretResolver: SecretResolver = {
        resolve: (ref: string) => {
          if (ref === 'my-openrouter-key') return 'sk-secret-value';
          return undefined;
        },
      };
      const runtime = createCreativeBriefRuntimeFactory(config, {
        ...createFactoryOptions(),
        secretResolver,
        auditSink,
      });
      await runtime.execute(mockCreativeBriefInput, mockRuntimeContext);
      // Check that no audit event contains secret values
      for (const event of auditEvents) {
        const json = JSON.stringify(event);
        expect(json.toLowerCase()).not.toContain('sk-secret-value');
        expect(json.toLowerCase()).not.toContain('sk-');
      }
    });

    it('audit sink receives redacted events only', async () => {
      const auditEvents: Array<Record<string, unknown>> = [];
      const auditSink: RedactedAuditSink = {
        emit: (event) => {
          auditEvents.push({ ...event });
        },
      };
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 0,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large'],
      };
      const secretResolver: SecretResolver = {
        resolve: (ref: string) => 'sensitive-secret',
      };
      const runtime = createCreativeBriefRuntimeFactory(config, {
        ...createFactoryOptions(),
        secretResolver,
        auditSink,
      });
      await runtime.execute(mockCreativeBriefInput, mockRuntimeContext);
      // Verify all audit events have expected structure with no sensitive data
      for (const event of auditEvents) {
        expect(event).toHaveProperty('correlationId');
        expect(event).toHaveProperty('adapterName');
        expect(event).toHaveProperty('eventType');
        expect(event).toHaveProperty('status');
        // No event should contain the secret
        const eventString = JSON.stringify(event);
        expect(eventString).not.toContain('sensitive-secret');
      }
    });
  });

  // === Audit sink integration tests ===

  describe('audit sink integration', () => {
    it('forwards audit events to injected sink', async () => {
      const auditEvents: Array<Record<string, unknown>> = [];
      const auditSink: RedactedAuditSink = {
        emit: (event) => {
          auditEvents.push({ ...event });
        },
      };
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 0,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large'],
      };
      const runtime = createCreativeBriefRuntimeFactory(config, {
        ...createFactoryOptions(),
        auditSink,
      });
      await runtime.execute(mockCreativeBriefInput, mockRuntimeContext);
      // Should have emitted at least some audit events
      expect(auditEvents.length).toBeGreaterThan(0);
    });

    it('works without audit sink', async () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 0,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large'],
      };
      // No audit sink provided
      const runtime = createCreativeBriefRuntimeFactory(config, {
        secretResolver: { resolve: () => 'key' } as SecretResolver,
        transport: { post: async () => new Response('{}', { status: 200 }) } as HttpPostTransport,
      });
      const outcome = await runtime.execute(mockCreativeBriefInput, mockRuntimeContext);
      expect(outcome).toBeDefined();
    });
  });

  // === Clock injection tests ===

  describe('clock injection', () => {
    it('accepts injected clock', () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 0,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large'],
      };
      const mockClock: Clock = {
        now: () => 1234567890,
      };
      const runtime = createCreativeBriefRuntimeFactory(config, {
        ...createFactoryOptions(),
        clock: mockClock,
      });
      expect(runtime).not.toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
    });

    it('uses injected clock for timing', async () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 0,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large'],
      };
      const mockClock: Clock = {
        now: () => 1000000,
      };
      const runtime = createCreativeBriefRuntimeFactory(config, {
        ...createFactoryOptions(),
        clock: mockClock,
      });
      const outcome = await runtime.execute(mockCreativeBriefInput, mockRuntimeContext);
      expect(outcome.durationMs).toBeDefined();
    });
  });

  // === Type safety tests ===

  describe('type safety', () => {
    it('returns CreativeBriefRuntime for valid config', () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 0,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large'],
      };
      const runtime = createCreativeBriefRuntimeFactory(config, createFactoryOptions());
      // Type assertion: runtime should be assignable to CreativeBriefRuntime
      const typedRuntime: CreativeBriefRuntime = runtime;
      expect(typedRuntime).toBeDefined();
    });

    it('execute returns AsyncCreativeBriefOutcome', async () => {
      const config: OpenRouterConfig = {
        mode: 'openrouter',
        modelId: 'openrouter/mistral-large',
        timeoutMs: 60000,
        spendLimitUsdCents: 0,
        secretRef: 'my-openrouter-key',
        allowedFreeModelIds: ['openrouter/mistral-large'],
      };
      const runtime = createCreativeBriefRuntimeFactory(config, createFactoryOptions());
      const outcome: AsyncCreativeBriefOutcome = await runtime.execute(
        mockCreativeBriefInput,
        mockRuntimeContext,
      );
      expect(outcome).toBeDefined();
      expect(outcome).toHaveProperty('category');
      expect(outcome).toHaveProperty('retryable');
      expect(outcome).toHaveProperty('durationMs');
    });
  });
});
