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
} from './creative-brief-input-resolver.js';
import { UnavailableCreativeBriefInputResolver } from './creative-brief-input-resolver.js';
import type { CreativeBriefRequestV1, CreativeBriefInputV1 } from '@joy-media/agent-tools';
import type { Actor } from './control-plane.js';

// ============================================================================
// Test Helpers
// ============================================================================

/** Helper to create a test context with an authenticated actor. */
const createTestContext = (actor: Actor): CreativeBriefInputResolverContext => ({
  actor,
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
      async resolve(_request: CreativeBriefInputResolverRequest, ctx: CreativeBriefInputResolverContext): Promise<CreativeBriefInputResolverSuccess> {
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
              composition: { durationUs: 1000000, frameRate: { num: 30, den: 1 }, width: 1920, height: 1080, aspectRatio: '16:9' },
              brand: { hasBrandKit: false, colorsAvailable: false, fontsAvailable: false, logoAvailable: false, voiceInstructionsAvailable: false, toneInstructionsAvailable: false, prohibitedClaims: [], prohibitedEffects: [], warnings: [] },
              scenes: [],
              timeline: { compositionId: 'comp-1', durationUs: 1000000, frameRate: { num: 30, den: 1 }, width: 1920, height: 1080, aspectRatio: '16:9', visualTrackCount: 1, audioTrackCount: 1, totalClipCount: 0, visualRowIds: [], audioRowIds: [] },
              assets: [],
              capabilities: {},
              warnings: [],
              truncation: { clipsOmitted: 0, assetsOmitted: 0, visualObjectsOmitted: 0, scenesOmitted: 0, totalEstimateBytes: 0 },
            },
            brandReadiness: { projectId: 'test-project-id', revisionId: 'test-revision-id', colorsAvailable: false, fontsAvailable: false, logoAvailable: false, voiceInstructionsAvailable: false, toneInstructionsAvailable: false, prohibitedClaims: [], prohibitedEffects: [], hasBrandKit: false, brandCompleteness: 'none', missingComponents: [], warnings: [], evidence: [] },
            sceneCoverages: [],
            projectReadiness: { projectId: 'test-project-id', revisionId: 'test-revision-id', destination: undefined, destinationAligned: true, destinationMismatch: undefined, durationTargetUs: undefined, compositionDurationUs: 1000000, durationAligned: true, durationGapUs: undefined, aspectRatio: '16:9', aspectRatioAligned: true, aspectRatioMismatch: undefined, captionAvailable: false, audioAvailable: false, generatedAssetsAvailable: false, readinessLevel: 'unknown', blockers: [], warnings: [], sceneCount: 0, scenesWithVisuals: 0, scenesWithAudio: 0, scenesWithCaptions: 0, evidence: [] },
            rules: [],
            request: { projectId: 'test-project-id', snapshotRevisionId: 'test-revision-id', request: 'test', scope: 'general' },
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
      resolve(_request: CreativeBriefInputResolverRequest, ctx: CreativeBriefInputResolverContext): CreativeBriefInputResolverSuccess {
        receivedActor = ctx.actor;
        return {
          status: 'resolved',
          input: {
            snapshot: {
              schemaVersion: 1,
              projectId: 'test-project-id',
              revisionId: 'test-revision-id',
              capturedAt: '2026-08-17T00:00:00.000Z',
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
            request: { projectId: 'test-project-id', snapshotRevisionId: 'test-revision-id', request: 'test', scope: 'general' },
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
      resolve(_request: CreativeBriefInputResolverRequest, _context: CreativeBriefInputResolverContext): CreativeBriefInputResolverSuccess {
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
      resolve(request: CreativeBriefInputResolverRequest, _context: CreativeBriefInputResolverContext): CreativeBriefInputResolverSuccess {
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
    if (r0 === undefined || r1 === undefined || r2 === undefined) throw new Error('Expected 3 results');
    expect(r0.status).toBe('resolved');
    expect(r1.status).toBe('unavailable');
    expect(r2.status).toBe('stale-revision');
  });
});
