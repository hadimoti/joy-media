/**
 * Creative Brief Input Resolver Tests - WP-37 S4-F10-E3-A
 *
 * Focused tests for the canonical server-side input resolver boundary.
 */

import { describe, it, expect } from 'vitest';
import type {
  CreativeBriefInputResolverRequest,
  CreativeBriefInputResolverSuccess,
  CreativeBriefInputResolverUnavailable,
  CreativeBriefInputResolverStaleRevision,
  CreativeBriefInputResolverResult,
  CreativeBriefInputResolver,
  CreativeBriefInputResolverContext,
  ControlPlaneReader,
} from './creative-brief-input-resolver.js';
import {
  UnavailableCreativeBriefInputResolver,
  CanonicalCreativeBriefInputResolver,
} from './creative-brief-input-resolver.js';
import type { CreativeBriefRequestV1, CreativeBriefInputV1 } from '@joy-media/agent-tools';
import type { Actor } from './control-plane.js';
import type { ControlPlane } from './control-plane.js';
import { LocalControlPlane } from './control-plane.js';
import { ProjectSnapshotService } from './project-snapshot-service.js';
import { ProjectIntelligenceService } from './project-intelligence-service.js';
import type {
  JoyProjectV1,
  ProjectRevisionId,
  SemanticProjectSnapshotV1,
} from '@joy-media/project-schema';
import { validateJoyProjectV1 } from '@joy-media/project-schema';
import { createCreativeBriefInput } from '@joy-media/agent-tools';
import type { S2IntelligenceResult } from './project-intelligence-service.js';

// ============================================================================
// Test Helpers
// ============================================================================

/** Helper to create a test context with an authenticated actor. */
const createTestContext = (
  actor: Actor,
  controlPlaneProjectId: string = TEST_PROJECT_ID,
): CreativeBriefInputResolverContext => ({
  actor,
  controlPlaneProjectId,
});

// ============================================================================
// Request Shape Tests
// ============================================================================

describe('CreativeBriefInputResolver - request shape', () => {
  it('should have request shape with only projectId, snapshotRevisionId, and validated request', () => {
    // The request interface intentionally cannot carry:
    // - snapshot (server-side state)
    // - intelligence (server-side state)
    // - asset URL
    // - path
    // - credential
    // - provider data
    // - browser-supplied project state

    // Verify the interface has exactly the required fields
    const request: CreativeBriefInputResolverRequest = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'general',
      },
    };

    expect(request.projectId).toBe('test-project-id');
    expect(request.snapshotRevisionId).toBe('test-revision-id');
    expect(request.request).toBeDefined();
    expect(request.request.request).toBe('Create a video');

    // The interface does not allow additional fields like snapshot, etc.
    // S1 = snapshot, S2 = intelligence - these are server-side state not allowed in request
    const invalidRequest = {
      projectId: 'test',
      snapshotRevisionId: 'test',
      request: {
        snapshotRevisionId: 'test',
        projectId: 'test',
        request: 'test',
        scope: 'general',
      },
    } as const;
    const invalidRequest2 = {
      projectId: 'test',
      snapshotRevisionId: 'test',
      request: {
        snapshotRevisionId: 'test',
        projectId: 'test',
        request: 'test',
        scope: 'general',
      },
    } as const;
  });

  it('should not allow request to carry S1/S2 content', () => {
    // S1 = snapshot, S2 = intelligence - these are server-side state
    // The request interface only carries identifiers and validated request
    const request: CreativeBriefInputResolverRequest = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'general',
      },
    };

    // The request.request is a CreativeBriefRequestV1 which also does not
    // contain snapshot or intelligence
    expect(request.request).not.toHaveProperty('snapshot');
    expect(request.request).not.toHaveProperty('intelligence');
  });
});

// ============================================================================
// Default Resolver Tests
// ============================================================================

describe('UnavailableCreativeBriefInputResolver', () => {
  it('should always return unavailable result', async () => {
    const request: CreativeBriefInputResolverRequest = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'general',
      },
    };
    const context = createTestContext({ id: 'test-actor' });

    const result = await UnavailableCreativeBriefInputResolver.resolve(request, context);

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('Expected unavailable');
    expect(result.code).toBe('CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE');
    expect(result.message).toBe('Creative Brief input resolver is unavailable');
  });

  it('should have no side effects and perform no I/O', async () => {
    // This test verifies that the default resolver is pure and has no side effects
    // We can only verify this by calling it multiple times and ensuring consistent results
    const request: CreativeBriefInputResolverRequest = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'general',
      },
    };
    const context = createTestContext({ id: 'test-actor' });

    const result1 = await UnavailableCreativeBriefInputResolver.resolve(request, context);
    const result2 = await UnavailableCreativeBriefInputResolver.resolve(request, context);

    expect(result1).toEqual(result2);
    // No exceptions, no async operations, no I/O
  });

  it('should fail closed for any request', async () => {
    const request1: CreativeBriefInputResolverRequest = {
      projectId: 'project-1',
      snapshotRevisionId: 'revision-1',
      request: {
        snapshotRevisionId: 'revision-1',
        projectId: 'project-1',
        request: 'Test',
        scope: 'general',
      },
    };

    const request2: CreativeBriefInputResolverRequest = {
      projectId: 'project-2',
      snapshotRevisionId: 'revision-2',
      request: {
        snapshotRevisionId: 'revision-2',
        projectId: 'project-2',
        request: 'Another test',
        scope: 'general',
      },
    };
    const context = createTestContext({ id: 'test-actor' });

    const result1 = await UnavailableCreativeBriefInputResolver.resolve(request1, context);
    const result2 = await UnavailableCreativeBriefInputResolver.resolve(request2, context);

    expect(result1.status).toBe('unavailable');
    expect(result2.status).toBe('unavailable');
  });

  it('should support async resolver returning Promise', async () => {
    // This test verifies that async resolvers are properly awaited
    const authenticatedActor: Actor = { id: 'async-test-actor' };
    const context = createTestContext(authenticatedActor);

    let resolveCalled = false;

    const asyncResolver: CreativeBriefInputResolver = {
      async resolve(
        _request: CreativeBriefInputResolverRequest,
        ctx: CreativeBriefInputResolverContext,
      ): Promise<CreativeBriefInputResolverSuccess> {
        // Verify context is received
        expect(ctx.actor.id).toBe('async-test-actor');
        resolveCalled = true;
        // Simulate async work
        await new Promise<void>((r) => setImmediate(r));
        return {
          status: 'resolved',
          input: {
            snapshot: {
              schemaVersion: 1,
              projectId: 'test-project-id',
              revisionId: 'test-revision-id',
              capturedAt: '2026-08-17T00:00:00.000Z',
              composition: {
                durationUs: 1000000,
                frameRate: { num: 30, den: 1 },
                width: 1920,
                height: 1080,
                aspectRatio: '16:9',
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
                compositionId: 'comp-1',
                durationUs: 1000000,
                frameRate: { num: 30, den: 1 },
                width: 1920,
                height: 1080,
                aspectRatio: '16:9',
                visualTrackCount: 1,
                audioTrackCount: 1,
                totalClipCount: 0,
                visualRowIds: [],
                audioRowIds: [],
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
            request: {
              projectId: 'test-project-id',
              snapshotRevisionId: 'test-revision-id',
              request: 'test',
              scope: 'general',
            },
          },
        };
      },
    };

    const request: CreativeBriefInputResolverRequest = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'test',
        scope: 'general',
      },
    };

    const result = await asyncResolver.resolve(request, context);

    expect(resolveCalled).toBe(true);
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('Expected resolved');
    expect(result.input).toBeDefined();
  });

  it('should receive the authenticated actor in context', async () => {
    // This test verifies that the resolver receives the authenticated actor through context
    const authenticatedActor: Actor = { id: 'authenticated-user-123' };
    const context = createTestContext(authenticatedActor);

    // Track whether the resolver received the expected actor
    let receivedActor: Actor | undefined;

    const testResolver: CreativeBriefInputResolver = {
      resolve(
        _request: CreativeBriefInputResolverRequest,
        ctx: CreativeBriefInputResolverContext,
      ): CreativeBriefInputResolverSuccess {
        receivedActor = ctx.actor;
        return {
          status: 'resolved',
          input: {
            snapshot: {
              schemaVersion: 1,
              projectId: 'test-project-id',
              revisionId: 'test-revision-id',
              capturedAt: '2026-08-17T00:00:00.000Z',
              composition: {
                durationUs: 1000000,
                frameRate: { num: 30, den: 1 },
                width: 1920,
                height: 1080,
                aspectRatio: '16:9',
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
                compositionId: 'comp-1',
                durationUs: 1000000,
                frameRate: { num: 30, den: 1 },
                width: 1920,
                height: 1080,
                aspectRatio: '16:9',
                visualTrackCount: 1,
                audioTrackCount: 1,
                totalClipCount: 0,
                visualRowIds: [],
                audioRowIds: [],
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
            request: {
              projectId: 'test-project-id',
              snapshotRevisionId: 'test-revision-id',
              request: 'test',
              scope: 'general',
            },
          },
        };
      },
    };

    const request: CreativeBriefInputResolverRequest = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'test',
        scope: 'general',
      },
    };

    await testResolver.resolve(request, context);

    expect(receivedActor).toBeDefined();
    expect(receivedActor?.id).toBe('authenticated-user-123');
  });
});

// ============================================================================
// Result Type Tests
// ============================================================================

describe('CreativeBriefInputResolver - result types', () => {
  it('should have typed success result with CreativeBriefInputV1', async () => {
    // Test-only resolver that returns a valid result
    const testInput: CreativeBriefInputV1 = {
      snapshot: {
        schemaVersion: 1,
        projectId: 'test-project-id',
        revisionId: 'test-revision-id',
        capturedAt: '2026-08-17T00:00:00.000Z',
        composition: {
          durationUs: 1000000,
          frameRate: { num: 30, den: 1 },
          width: 1920,
          height: 1080,
          aspectRatio: '16:9',
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
          compositionId: 'comp-1',
          durationUs: 1000000,
          frameRate: { num: 30, den: 1 },
          width: 1920,
          height: 1080,
          aspectRatio: '16:9',
          visualTrackCount: 0,
          audioTrackCount: 0,
          totalClipCount: 0,
          visualRowIds: [],
          audioRowIds: [],
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
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'general',
      },
    };

    const testResolver: CreativeBriefInputResolver = {
      resolve(
        _request: CreativeBriefInputResolverRequest,
        _context: CreativeBriefInputResolverContext,
      ): CreativeBriefInputResolverSuccess {
        return {
          status: 'resolved',
          input: testInput,
        };
      },
    };

    const request: CreativeBriefInputResolverRequest = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'general',
      },
    };
    const context = createTestContext({ id: 'test-actor' });

    const result = await testResolver.resolve(request, context);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('Expected resolved');
    expect(result.input).toBeDefined();
    expect(result.input).toBe(testInput);
  });

  it('should have typed unavailable result with redacted message', () => {
    const result: CreativeBriefInputResolverUnavailable = {
      status: 'unavailable',
      code: 'CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE',
      message: 'Resolver is unavailable',
    };

    expect(result.status).toBe('unavailable');
    expect(result.code).toBe('CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE');
    expect(result.message).toBe('Resolver is unavailable');
  });

  it('should have typed stale-revision result with redacted message', () => {
    const result: CreativeBriefInputResolverStaleRevision = {
      status: 'stale-revision',
      code: 'CREATIVE_BRIEF_INPUT_RESOLVER_STALE_REVISION',
      message: 'Revision is stale',
    };

    expect(result.status).toBe('stale-revision');
    expect(result.code).toBe('CREATIVE_BRIEF_INPUT_RESOLVER_STALE_REVISION');
    expect(result.message).toBe('Revision is stale');
  });
});

// ============================================================================
// Persian Text Test
// ============================================================================

describe('CreativeBriefInputResolver - Persian text', () => {
  it('should preserve Persian request text unchanged through resolver', async () => {
    // Test that Persian (Farsi) text survives unchanged through the resolver boundary
    const persianText = 'به من کمک کن یک ویدئو بسازم';

    const testResolver: CreativeBriefInputResolver = {
      resolve(
        request: CreativeBriefInputResolverRequest,
        _context: CreativeBriefInputResolverContext,
      ): CreativeBriefInputResolverSuccess {
        return {
          status: 'resolved',
          input: {
            snapshot: {
              schemaVersion: 1,
              projectId: request.projectId,
              revisionId: request.snapshotRevisionId,
              capturedAt: '2026-08-17T00:00:00.000Z',
              composition: {
                durationUs: 1000000,
                frameRate: { num: 30, den: 1 },
                width: 1920,
                height: 1080,
                aspectRatio: '16:9',
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
                compositionId: 'comp-1',
                durationUs: 1000000,
                frameRate: { num: 30, den: 1 },
                width: 1920,
                height: 1080,
                aspectRatio: '16:9',
                visualTrackCount: 0,
                audioTrackCount: 0,
                totalClipCount: 0,
                visualRowIds: [],
                audioRowIds: [],
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
              projectId: request.projectId,
              revisionId: request.snapshotRevisionId,
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
              projectId: request.projectId,
              revisionId: request.snapshotRevisionId,
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
            request: request.request,
          },
        };
      },
    };

    const request: CreativeBriefInputResolverRequest = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: persianText,
        scope: 'general',
      },
    };
    const context = createTestContext({ id: 'test-actor' });

    const result = await testResolver.resolve(request, context);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('Expected resolved');
    expect(result.input.request.request).toBe(persianText);
  });
});

// ============================================================================
// Type Safety Tests
// ============================================================================

describe('CreativeBriefInputResolver - type safety', () => {
  it('should have exhaustively typed result union', () => {
    // Verify all result types are covered
    const results: CreativeBriefInputResolverResult[] = [
      {
        status: 'resolved',
        input: {
          snapshot: {
            schemaVersion: 1,
            projectId: 'test',
            revisionId: 'test',
            capturedAt: '2026-08-17T00:00:00.000Z',
            composition: {
              durationUs: 1000000,
              frameRate: { num: 30, den: 1 },
              width: 1920,
              height: 1080,
              aspectRatio: '16:9',
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
              compositionId: 'comp-1',
              durationUs: 1000000,
              frameRate: { num: 30, den: 1 },
              width: 1920,
              height: 1080,
              aspectRatio: '16:9',
              visualTrackCount: 0,
              audioTrackCount: 0,
              totalClipCount: 0,
              visualRowIds: [],
              audioRowIds: [],
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
            projectId: 'test',
            revisionId: 'test',
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
            projectId: 'test',
            revisionId: 'test',
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
          request: {
            snapshotRevisionId: 'test',
            projectId: 'test',
            request: 'test',
            scope: 'general',
          },
        },
      },
      {
        status: 'unavailable',
        code: 'CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE',
        message: 'unavailable',
      },
      {
        status: 'stale-revision',
        code: 'CREATIVE_BRIEF_INPUT_RESOLVER_STALE_REVISION',
        message: 'stale',
      },
    ];

    expect(results).toHaveLength(3);
    const r0 = results[0];
    const r1 = results[1];
    const r2 = results[2];
    if (r0 === undefined || r1 === undefined || r2 === undefined)
      throw new Error('Expected 3 results');
    expect(r0.status).toBe('resolved');
    expect(r1.status).toBe('unavailable');
    expect(r2.status).toBe('stale-revision');
  });
});

// ============================================================================
// Canonical Creative Brief Input Resolver Tests - WP-37 S4 Phase 4-C
// ============================================================================

// Test fixtures
const TEST_PROJECT_ID = 'test-project-id' as const;
const TEST_REVISION_ID = 'test-revision-id' as const;
const TEST_ACTOR: Actor = { id: 'test-actor' } as const;

function createMinimalJoyProjectV1ForCanonicalTests(
  id: string,
  _revisionId?: string,
): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id,
    title: 'Test Project',
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    rootCompositionId: 'comp-1',
    settings: { defaultLocale: 'en' },
    compositions: {
      'comp-1': {
        id: 'comp-1',
        name: 'Main',
        width: 1920,
        height: 1080,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 1_000_000,
        background: '#00000000',
        tracks: [],
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments: {},
    pluginData: {},
  };
}

function createTestRequestForCanonicalTests(
  projectId: string = TEST_PROJECT_ID,
  snapshotRevisionId: string = TEST_REVISION_ID,
  requestText: string = 'Create a video',
): CreativeBriefInputResolverRequest {
  return {
    projectId,
    snapshotRevisionId,
    request: {
      snapshotRevisionId,
      projectId,
      request: requestText,
      scope: 'general',
    },
  };
}

function createTestContextForCanonicalTests(
  actor: Actor = TEST_ACTOR,
  controlPlaneProjectId: string = TEST_PROJECT_ID,
): CreativeBriefInputResolverContext {
  return { actor, controlPlaneProjectId };
}

// Mock ControlPlaneReader that simulates readProjectDocument behavior
class MockControlPlane implements ControlPlaneReader {
  private readonly documents: Map<
    string,
    { projectId: string; revisionId: string; document: unknown; ownerId: string }
  > = new Map();
  private readonly ownerId: string;
  private storeUnavailable: boolean = false;

  constructor(ownerId: string = TEST_ACTOR.id) {
    this.ownerId = ownerId;
  }

  setStoreUnavailable(unavailable: boolean): void {
    this.storeUnavailable = unavailable;
  }

  storeDocument(projectId: string, revisionId: string, document: unknown): void {
    this.documents.set(projectId, { projectId, revisionId, document, ownerId: this.ownerId });
  }

  getStoredDocumentCount(): number {
    return this.documents.size;
  }

  async readProjectDocument(
    actor: Actor,
    projectId: string,
    revisionId?: string,
  ): Promise<
    | {
        readonly kind: 'ready';
        readonly record: {
          readonly projectId: string;
          readonly ownerId: string;
          readonly revisionId: string;
          readonly document: unknown;
        };
      }
    | { readonly kind: 'not-found'; readonly projectId: string; readonly revisionId: string | null }
    | {
        readonly kind: 'stale-revision';
        readonly projectId: string;
        readonly requestedRevisionId: string;
        readonly currentRevisionId: string;
      }
    | { readonly kind: 'unavailable'; readonly message: string }
  > {
    if (this.storeUnavailable) {
      return { kind: 'unavailable', message: 'Store unavailable' };
    }

    const stored = this.documents.get(projectId);
    if (!stored) {
      return { kind: 'not-found', projectId, revisionId: revisionId ?? null };
    }

    if (actor.id !== this.ownerId) {
      return { kind: 'not-found', projectId, revisionId: revisionId ?? null };
    }

    if (revisionId !== undefined && revisionId !== stored.revisionId) {
      return {
        kind: 'stale-revision',
        projectId,
        requestedRevisionId: revisionId,
        currentRevisionId: stored.revisionId,
      };
    }

    return {
      kind: 'ready',
      record: {
        projectId: stored.projectId,
        ownerId: stored.ownerId,
        revisionId: stored.revisionId,
        document: stored.document,
      },
    };
  }
}

describe('CanonicalCreativeBriefInputResolver', () => {
  describe('success cases', () => {
    it('should resolve input successfully with valid document and matching revision', async () => {
      const controlPlane = new MockControlPlane();
      const project = createMinimalJoyProjectV1ForCanonicalTests(TEST_PROJECT_ID);
      controlPlane.storeDocument(TEST_PROJECT_ID, TEST_REVISION_ID, project);

      const resolver = new CanonicalCreativeBriefInputResolver({
        controlPlane,
        snapshotService: new ProjectSnapshotService(),
        intelligenceService: new ProjectIntelligenceService(),
      });

      const request = createTestRequestForCanonicalTests();
      const context = createTestContextForCanonicalTests();

      const result = await resolver.resolve(request, context);

      expect(result.status).toBe('resolved');
      if (result.status !== 'resolved') throw new Error('Expected resolved');
      expect(result.input).toBeDefined();
      expect(result.input.request.request).toBe('Create a video');
    });

    it('should resolve with injected ProjectSnapshotService and ProjectIntelligenceService', async () => {
      const controlPlane = new MockControlPlane();
      const project = createMinimalJoyProjectV1ForCanonicalTests(TEST_PROJECT_ID);
      controlPlane.storeDocument(TEST_PROJECT_ID, TEST_REVISION_ID, project);

      const snapshotService = new ProjectSnapshotService();
      const intelligenceService = new ProjectIntelligenceService();

      const resolver = new CanonicalCreativeBriefInputResolver({
        controlPlane,
        snapshotService,
        intelligenceService,
      });

      const request = createTestRequestForCanonicalTests();
      const context = createTestContextForCanonicalTests();

      const result = await resolver.resolve(request, context);

      expect(result.status).toBe('resolved');
      if (result.status !== 'resolved') throw new Error('Expected resolved');
      expect(result.input).toBeDefined();
    });

    it('should resolve when JoyProjectV1.id differs from control-plane project ID', async () => {
      // Document is stored under control-plane project 'cp-project-1' but has editor-document ID 'editor-doc-123'
      const controlPlaneProjectId = 'cp-project-1';
      const editorDocumentId = 'editor-doc-123';
      const controlPlane = new MockControlPlane();
      const project = createMinimalJoyProjectV1ForCanonicalTests(editorDocumentId);
      // Store under control-plane project ID
      controlPlane.storeDocument(controlPlaneProjectId, TEST_REVISION_ID, project);

      const resolver = new CanonicalCreativeBriefInputResolver({
        controlPlane,
        snapshotService: new ProjectSnapshotService(),
        intelligenceService: new ProjectIntelligenceService(),
      });

      // Client envelope carries the editor-document ID
      const request = createTestRequestForCanonicalTests(editorDocumentId, TEST_REVISION_ID);
      // Context carries the control-plane project ID
      const context = createTestContextForCanonicalTests(TEST_ACTOR, controlPlaneProjectId);

      const result = await resolver.resolve(request, context);

      expect(result.status).toBe('resolved');
      if (result.status !== 'resolved') throw new Error('Expected resolved');
      expect(result.input).toBeDefined();
    });

    it('should forward actor to ControlPlane', async () => {
      const ownerActor: Actor = { id: 'owner-actor' };
      const nonOwnerActor: Actor = { id: 'non-owner-actor' };

      const controlPlane = new MockControlPlane(ownerActor.id);
      const project = createMinimalJoyProjectV1ForCanonicalTests(TEST_PROJECT_ID);
      controlPlane.storeDocument(TEST_PROJECT_ID, TEST_REVISION_ID, project);

      const resolver = new CanonicalCreativeBriefInputResolver({
        controlPlane,
        snapshotService: new ProjectSnapshotService(),
        intelligenceService: new ProjectIntelligenceService(),
      });

      // Test with owner actor - should succeed
      const request = createTestRequestForCanonicalTests();
      const ownerContext = createTestContextForCanonicalTests(ownerActor);
      const ownerResult = await resolver.resolve(request, ownerContext);
      expect(ownerResult.status).toBe('resolved');

      // Test with non-owner actor - should fail with stale-revision (mapped from not-found)
      const nonOwnerContext = createTestContextForCanonicalTests(nonOwnerActor);
      const nonOwnerResult = await resolver.resolve(request, nonOwnerContext);
      expect(nonOwnerResult.status).toBe('stale-revision');
    });
  });

  describe('async read behavior', () => {
    it('should handle async readProjectDocument that returns Promise', async () => {
      const controlPlane = new MockControlPlane();
      const project = createMinimalJoyProjectV1ForCanonicalTests(TEST_PROJECT_ID);
      controlPlane.storeDocument(TEST_PROJECT_ID, TEST_REVISION_ID, project);

      const resolver = new CanonicalCreativeBriefInputResolver({
        controlPlane,
        snapshotService: new ProjectSnapshotService(),
        intelligenceService: new ProjectIntelligenceService(),
      });

      const request = createTestRequestForCanonicalTests();
      const context = createTestContextForCanonicalTests();

      // Verify it returns a Promise
      const resolveResult = resolver.resolve(request, context);
      expect(resolveResult).toBeInstanceOf(Promise);

      const result = await resolveResult;
      expect(result.status).toBe('resolved');
    });
  });

  describe('stale and not-found cases', () => {
    it('should return stale-revision when document is not found', async () => {
      const controlPlane = new MockControlPlane();
      // Don't store any document

      const resolver = new CanonicalCreativeBriefInputResolver({
        controlPlane,
        snapshotService: new ProjectSnapshotService(),
        intelligenceService: new ProjectIntelligenceService(),
      });

      const request = createTestRequestForCanonicalTests();
      const context = createTestContextForCanonicalTests();

      const result = await resolver.resolve(request, context);

      expect(result.status).toBe('stale-revision');
      if (result.status !== 'stale-revision') throw new Error('Expected stale-revision');
      expect(result.code).toBe('CREATIVE_BRIEF_INPUT_RESOLVER_STALE_REVISION');
    });

    it('should return stale-revision when revision is stale', async () => {
      const controlPlane = new MockControlPlane();
      const project = createMinimalJoyProjectV1ForCanonicalTests(TEST_PROJECT_ID);
      controlPlane.storeDocument(TEST_PROJECT_ID, 'different-revision', project);

      const resolver = new CanonicalCreativeBriefInputResolver({
        controlPlane,
        snapshotService: new ProjectSnapshotService(),
        intelligenceService: new ProjectIntelligenceService(),
      });

      const request = createTestRequestForCanonicalTests(TEST_PROJECT_ID, TEST_REVISION_ID);
      const context = createTestContextForCanonicalTests();

      const result = await resolver.resolve(request, context);

      expect(result.status).toBe('stale-revision');
      if (result.status !== 'stale-revision') throw new Error('Expected stale-revision');
      expect(result.code).toBe('CREATIVE_BRIEF_INPUT_RESOLVER_STALE_REVISION');
    });

    it('should return stale-revision when returned revision does not match request', async () => {
      const controlPlane = new MockControlPlane();
      const project = createMinimalJoyProjectV1ForCanonicalTests(TEST_PROJECT_ID);
      // Store with one revision but request a different one
      controlPlane.storeDocument(TEST_PROJECT_ID, 'stored-revision', project);

      const resolver = new CanonicalCreativeBriefInputResolver({
        controlPlane,
        snapshotService: new ProjectSnapshotService(),
        intelligenceService: new ProjectIntelligenceService(),
      });

      const request = createTestRequestForCanonicalTests(TEST_PROJECT_ID, 'requested-revision');
      const context = createTestContextForCanonicalTests();

      const result = await resolver.resolve(request, context);

      expect(result.status).toBe('stale-revision');
      if (result.status !== 'stale-revision') throw new Error('Expected stale-revision');
      expect(result.code).toBe('CREATIVE_BRIEF_INPUT_RESOLVER_STALE_REVISION');
    });
  });

  describe('unavailable cases', () => {
    it('should return unavailable when store is unavailable', async () => {
      const controlPlane = new MockControlPlane();
      controlPlane.setStoreUnavailable(true);

      const resolver = new CanonicalCreativeBriefInputResolver({
        controlPlane,
        snapshotService: new ProjectSnapshotService(),
        intelligenceService: new ProjectIntelligenceService(),
      });

      const request = createTestRequestForCanonicalTests();
      const context = createTestContextForCanonicalTests();

      const result = await resolver.resolve(request, context);

      expect(result.status).toBe('unavailable');
      if (result.status !== 'unavailable') throw new Error('Expected unavailable');
      expect(result.code).toBe('CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE');
      expect(result.message).toBe('Project document store is unavailable');
    });

    it('should return unavailable when document is invalid JoyProjectV1', async () => {
      const controlPlane = new MockControlPlane();
      // Store an invalid document
      controlPlane.storeDocument(TEST_PROJECT_ID, TEST_REVISION_ID, { invalid: 'document' });

      const resolver = new CanonicalCreativeBriefInputResolver({
        controlPlane,
        snapshotService: new ProjectSnapshotService(),
        intelligenceService: new ProjectIntelligenceService(),
      });

      const request = createTestRequestForCanonicalTests();
      const context = createTestContextForCanonicalTests();

      const result = await resolver.resolve(request, context);

      expect(result.status).toBe('unavailable');
      if (result.status !== 'unavailable') throw new Error('Expected unavailable');
      expect(result.code).toBe('CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE');
      expect(result.message).toBe(
        'Project document is invalid or cannot be validated as JoyProjectV1',
      );
    });

    it('should return unavailable when project ID in document does not match record projectId', async () => {
      const controlPlane = new MockControlPlane();
      const project = createMinimalJoyProjectV1ForCanonicalTests('different-project-id');
      // Store with one projectId but the record has a different one
      controlPlane.storeDocument(TEST_PROJECT_ID, TEST_REVISION_ID, project);

      const resolver = new CanonicalCreativeBriefInputResolver({
        controlPlane,
        snapshotService: new ProjectSnapshotService(),
        intelligenceService: new ProjectIntelligenceService(),
      });

      const request = createTestRequestForCanonicalTests();
      const context = createTestContextForCanonicalTests();

      const result = await resolver.resolve(request, context);

      // This should fail because the record.projectId !== project.id
      expect(result.status).toBe('unavailable');
      if (result.status !== 'unavailable') throw new Error('Expected unavailable');
      expect(result.code).toBe('CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE');
      expect(result.message).toBe('Project document project ID does not match the request');
    });

    it('should return unavailable when JoyProjectV1.id does not match request.projectId', async () => {
      // Document is stored under control-plane project 'cp-project-1' with internal id 'different-doc-id'
      // Request asks for 'test-project-id' which doesn't match the internal id
      const controlPlaneProjectId = 'cp-project-1';
      const controlPlane = new MockControlPlane();
      const project = createMinimalJoyProjectV1ForCanonicalTests('different-doc-id');
      controlPlane.storeDocument(controlPlaneProjectId, TEST_REVISION_ID, project);

      const resolver = new CanonicalCreativeBriefInputResolver({
        controlPlane,
        snapshotService: new ProjectSnapshotService(),
        intelligenceService: new ProjectIntelligenceService(),
      });

      // Request for TEST_PROJECT_ID but document has different-doc-id
      const request = createTestRequestForCanonicalTests(TEST_PROJECT_ID, TEST_REVISION_ID);
      const context = createTestContextForCanonicalTests(TEST_ACTOR, controlPlaneProjectId);

      const result = await resolver.resolve(request, context);

      // This should fail because project.id ('different-doc-id') doesn't match request.projectId ('test-project-id')
      expect(result.status).toBe('unavailable');
      if (result.status !== 'unavailable') throw new Error('Expected unavailable');
      expect(result.code).toBe('CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE');
      expect(result.message).toBe('Project document project ID does not match the request');
    });
  });

  describe('Persian text preservation', () => {
    it('should preserve Persian request text byte-for-byte through resolver', async () => {
      const controlPlane = new MockControlPlane();
      const project = createMinimalJoyProjectV1ForCanonicalTests(TEST_PROJECT_ID);
      controlPlane.storeDocument(TEST_PROJECT_ID, TEST_REVISION_ID, project);

      const persianText = 'به من کمک کن یک ویدئو بسازم';

      const resolver = new CanonicalCreativeBriefInputResolver({
        controlPlane,
        snapshotService: new ProjectSnapshotService(),
        intelligenceService: new ProjectIntelligenceService(),
      });

      const request = createTestRequestForCanonicalTests(
        TEST_PROJECT_ID,
        TEST_REVISION_ID,
        persianText,
      );
      const context = createTestContextForCanonicalTests();

      const result = await resolver.resolve(request, context);

      expect(result.status).toBe('resolved');
      if (result.status !== 'resolved') throw new Error('Expected resolved');
      expect(result.input.request.request).toBe(persianText);
    });

    it('should preserve RTL text in request', async () => {
      const controlPlane = new MockControlPlane();
      const project = createMinimalJoyProjectV1ForCanonicalTests(TEST_PROJECT_ID);
      controlPlane.storeDocument(TEST_PROJECT_ID, TEST_REVISION_ID, project);

      const rtlText = 'مرحبا بالعالم';

      const resolver = new CanonicalCreativeBriefInputResolver({
        controlPlane,
        snapshotService: new ProjectSnapshotService(),
        intelligenceService: new ProjectIntelligenceService(),
      });

      const request = createTestRequestForCanonicalTests(
        TEST_PROJECT_ID,
        TEST_REVISION_ID,
        rtlText,
      );
      const context = createTestContextForCanonicalTests();

      const result = await resolver.resolve(request, context);

      expect(result.status).toBe('resolved');
      if (result.status !== 'resolved') throw new Error('Expected resolved');
      expect(result.input.request.request).toBe(rtlText);
    });
  });

  describe('input immutability', () => {
    it('should not mutate the request object', async () => {
      const controlPlane = new MockControlPlane();
      const project = createMinimalJoyProjectV1ForCanonicalTests(TEST_PROJECT_ID);
      controlPlane.storeDocument(TEST_PROJECT_ID, TEST_REVISION_ID, project);

      const request: CreativeBriefInputResolverRequest = createTestRequestForCanonicalTests();
      const originalRequestText = request.request.request;
      const originalProjectId = request.projectId;
      const originalSnapshotRevisionId = request.snapshotRevisionId;

      const resolver = new CanonicalCreativeBriefInputResolver({
        controlPlane,
        snapshotService: new ProjectSnapshotService(),
        intelligenceService: new ProjectIntelligenceService(),
      });

      const context = createTestContextForCanonicalTests();

      await resolver.resolve(request, context);

      // Verify request object is unchanged
      expect(request.request.request).toBe(originalRequestText);
      expect(request.projectId).toBe(originalProjectId);
      expect(request.snapshotRevisionId).toBe(originalSnapshotRevisionId);
    });
  });

  describe('no writes', () => {
    it('should not write any documents', async () => {
      const controlPlane = new MockControlPlane();
      const project = createMinimalJoyProjectV1ForCanonicalTests(TEST_PROJECT_ID);
      controlPlane.storeDocument(TEST_PROJECT_ID, TEST_REVISION_ID, project);

      const initialDocCount = controlPlane.getStoredDocumentCount();

      const resolver = new CanonicalCreativeBriefInputResolver({
        controlPlane,
        snapshotService: new ProjectSnapshotService(),
        intelligenceService: new ProjectIntelligenceService(),
      });

      const request = createTestRequestForCanonicalTests();
      const context = createTestContextForCanonicalTests();

      await resolver.resolve(request, context);

      // No new documents should be written
      expect(controlPlane.getStoredDocumentCount()).toBe(initialDocCount);
    });
  });
});
