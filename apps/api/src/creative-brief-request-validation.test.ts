/**
 * Creative Brief Request Validation Tests - WP-37 S4-F3
 *
 * Focused tests for server-side Creative Brief request validation.
 * Tests cover: valid bounded input, every mismatch, unknown fields,
 * forbidden data, oversized input, Persian request preservation, and no mutation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateCreativeBriefServerRequest,
  MAX_CREATIVE_BRIEF_REQUEST_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_INTELLIGENCE_BYTES,
  MAX_REQUEST_LENGTH,
  MAX_BRIEF_LENGTH,
} from './creative-brief-request-validation.js';
import type { SemanticProjectSnapshotV1, ProjectRevisionId } from '@joy-media/project-schema';
import type {
  BrandReadinessV1,
  SceneCoverageV1,
  ProjectReadinessV1,
  IntelligenceRuleV1,
} from '@joy-media/project-schema';
import type { CreativeBriefRequestV1 } from '@joy-media/agent-tools';
import type { CreativeBriefServerRequest } from './creative-brief-request-validation.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_PROJECT_ID = 'test-project-123';
const TEST_REVISION_ID: ProjectRevisionId = 'rev-abc-456';
const TEST_ROUTE_PROJECT_ID = 'test-project-123';
const TEST_ROUTE_REVISION_ID: ProjectRevisionId = 'rev-abc-456';

// Minimal valid SemanticProjectSnapshotV1
function createMinimalSnapshot(
  projectId: string = TEST_PROJECT_ID,
  revisionId: ProjectRevisionId = TEST_REVISION_ID,
): SemanticProjectSnapshotV1 {
  return {
    schemaVersion: 1,
    projectId,
    revisionId,
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
  };
}

// Minimal valid BrandReadinessV1
function createMinimalBrandReadiness(
  projectId: string = TEST_PROJECT_ID,
  revisionId: ProjectRevisionId = TEST_REVISION_ID,
): BrandReadinessV1 {
  return {
    projectId,
    revisionId,
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
  };
}

// Minimal valid SceneCoverageV1 array
function createMinimalSceneCoverages(): readonly SceneCoverageV1[] {
  return [];
}

// Minimal valid ProjectReadinessV1
function createMinimalProjectReadiness(
  projectId: string = TEST_PROJECT_ID,
  revisionId: ProjectRevisionId = TEST_REVISION_ID,
): ProjectReadinessV1 {
  return {
    projectId,
    revisionId,
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
  };
}

// Minimal valid IntelligenceRuleV1 array
function createMinimalRules(): readonly IntelligenceRuleV1[] {
  return [];
}

// Minimal valid CreativeBriefRequestV1
function createMinimalRequest(
  projectId: string = TEST_PROJECT_ID,
  snapshotRevisionId: ProjectRevisionId = TEST_REVISION_ID,
  request: string = 'Test request',
  scope:
    | 'pacing'
    | 'caption-coverage'
    | 'visual-coverage'
    | 'brand-alignment'
    | 'audio-quality'
    | 'structure'
    | 'general' = 'general',
): CreativeBriefRequestV1 {
  return {
    snapshotRevisionId,
    projectId,
    request,
    scope,
  };
}

// Create a valid full envelope
function createValidEnvelope(
  projectId: string = TEST_PROJECT_ID,
  revisionId: ProjectRevisionId = TEST_REVISION_ID,
): CreativeBriefServerRequest {
  return {
    projectId,
    snapshotRevisionId: revisionId,
    snapshot: createMinimalSnapshot(projectId, revisionId),
    intelligence: {
      brandReadiness: createMinimalBrandReadiness(projectId, revisionId),
      sceneCoverages: createMinimalSceneCoverages(),
      projectReadiness: createMinimalProjectReadiness(projectId, revisionId),
      rules: createMinimalRules(),
    },
    request: createMinimalRequest(projectId, revisionId),
  };
}

// ============================================================================
// Test Suites
// ============================================================================

describe('validateCreativeBriefServerRequest', () => {
  describe('valid bounded input', () => {
    it('accepts a valid complete envelope', () => {
      const envelope = createValidEnvelope();
      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts valid envelope with all optional fields', () => {
      const envelope = createValidEnvelope();
      (envelope as any).request = createMinimalRequest(
        TEST_PROJECT_ID,
        TEST_REVISION_ID,
        'Detailed request with brief',
        'pacing',
      );
      (envelope.request as any).brief = 'Additional context';
      (envelope.request as any).destination = 'instagram-reel';
      (envelope.request as any).durationTargetUs = 30000000;
      (envelope.request as any).maxRecommendations = 5;
      (envelope.request as any).allowedRecommendationKinds = ['pacing', 'caption'];

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('project ID matching', () => {
    it('rejects when route projectId does not match envelope projectId', () => {
      const envelope = createValidEnvelope(TEST_PROJECT_ID, TEST_REVISION_ID);
      const result = validateCreativeBriefServerRequest(
        envelope,
        'different-project-id',
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'project-mismatch',
          path: 'projectId',
        }),
      );
    });

    it('rejects when envelope projectId does not match snapshot.projectId', () => {
      const envelope = createValidEnvelope(TEST_PROJECT_ID, TEST_REVISION_ID);
      (envelope as any).snapshot = createMinimalSnapshot(
        'different-project-in-snapshot',
        TEST_REVISION_ID,
      );

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'project-mismatch',
          path: 'snapshot.projectId',
        }),
      );
    });

    it('rejects when envelope projectId does not match request.projectId', () => {
      const envelope = createValidEnvelope(TEST_PROJECT_ID, TEST_REVISION_ID);
      (envelope as any).request = createMinimalRequest(
        'different-project-in-request',
        TEST_REVISION_ID,
      );

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'project-mismatch',
          path: 'request.projectId',
        }),
      );
    });
  });

  describe('revision ID matching', () => {
    it('rejects when route snapshotRevisionId does not match envelope snapshotRevisionId', () => {
      const envelope = createValidEnvelope(TEST_PROJECT_ID, TEST_REVISION_ID);
      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        'different-revision-id',
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'revision-mismatch',
          path: 'snapshotRevisionId',
        }),
      );
    });

    it('rejects when envelope snapshotRevisionId does not match snapshot.revisionId', () => {
      const envelope = createValidEnvelope(TEST_PROJECT_ID, TEST_REVISION_ID);
      (envelope as any).snapshot = createMinimalSnapshot(
        TEST_PROJECT_ID,
        'different-revision-in-snapshot',
      );

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'revision-mismatch',
          path: 'snapshot.revisionId',
        }),
      );
    });

    it('rejects when envelope snapshotRevisionId does not match request.snapshotRevisionId', () => {
      const envelope = createValidEnvelope(TEST_PROJECT_ID, TEST_REVISION_ID);
      (envelope as any).request = createMinimalRequest(
        TEST_PROJECT_ID,
        'different-revision-in-request',
      );

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'revision-mismatch',
          path: 'request.snapshotRevisionId',
        }),
      );
    });
  });

  describe('unknown fields', () => {
    it('rejects envelope with unknown top-level fields', () => {
      const envelope = createValidEnvelope();
      (envelope as any).unknownField = 'should-not-be-allowed';

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-request',
          message: expect.stringContaining('Unknown fields'),
        }),
      );
    });

    it('rejects request with unknown fields', () => {
      const envelope = createValidEnvelope();
      (envelope as any).request = {
        ...createMinimalRequest(),
        unknownRequestField: 'should-not-be-allowed',
      };

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => e.code === 'invalid-request' || e.code === 'forbidden-data'),
      ).toBe(true);
    });
  });

  describe('forbidden data - field names', () => {
    it('rejects envelope with command field', () => {
      const envelope = createValidEnvelope();
      (envelope as any).command = { type: 'execute' };

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with job field', () => {
      const envelope = createValidEnvelope();
      (envelope as any).job = { id: 'job-123' };

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with approval field', () => {
      const envelope = createValidEnvelope();
      (envelope as any).approval = { status: 'pending' };

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with provider field', () => {
      const envelope = createValidEnvelope();
      (envelope as any).provider = { name: 'mistral' };

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with model field', () => {
      const envelope = createValidEnvelope();
      (envelope as any).model = 'mistral-large';

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with secret field', () => {
      const envelope = createValidEnvelope();
      (envelope as any).secret = 'api-key-1234567890';

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with apiKey field', () => {
      const envelope = createValidEnvelope();
      (envelope as any).apiKey = 'sk-1234567890abcdef';

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with token field', () => {
      const envelope = createValidEnvelope();
      (envelope as any).token = 'bearer-token-123';

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with url field', () => {
      const envelope = createValidEnvelope();
      (envelope as any).url = 'https://example.com';

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with path field', () => {
      const envelope = createValidEnvelope();
      (envelope as any).path = '/some/path/to/file';

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with file field', () => {
      const envelope = createValidEnvelope();
      (envelope as any).file = 'file.txt';

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with write field', () => {
      const envelope = createValidEnvelope();
      (envelope as any).write = true;

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });
  });

  describe('forbidden data - string patterns', () => {
    it('rejects envelope with HTTP URL in string field', () => {
      const envelope = createValidEnvelope();
      (envelope as any).request = createMinimalRequest(
        TEST_PROJECT_ID,
        TEST_REVISION_ID,
        'Go to https://example.com for more info',
      );

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with S3 URL in string field', () => {
      const envelope = createValidEnvelope();
      (envelope as any).request = createMinimalRequest(
        TEST_PROJECT_ID,
        TEST_REVISION_ID,
        'Load from s3://bucket/key',
      );

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with OpenAI API key pattern', () => {
      const envelope = createValidEnvelope();
      (envelope as any).request = createMinimalRequest(
        TEST_PROJECT_ID,
        TEST_REVISION_ID,
        'Use key sk-1234567890abcdef1234567890',
      );

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with Bearer token pattern', () => {
      const envelope = createValidEnvelope();
      (envelope.request as any) = createMinimalRequest(
        TEST_PROJECT_ID,
        TEST_REVISION_ID,
        'Auth with Bearer abc123.def456.ghi789',
      );

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with AWS access key pattern', () => {
      const envelope = createValidEnvelope();
      (envelope as any).request = createMinimalRequest(
        TEST_PROJECT_ID,
        TEST_REVISION_ID,
        'AWS key AKIAIOSFODNN7EXAMPLE',
      );

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with S3 URL pattern', () => {
      const envelope = createValidEnvelope();
      (envelope.request as any) = createMinimalRequest(
        TEST_PROJECT_ID,
        TEST_REVISION_ID,
        'Load from s3://my-bucket/data.json',
      );

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });

    it('rejects envelope with Unix path pattern', () => {
      const envelope = createValidEnvelope();
      (envelope.request as any) = createMinimalRequest(
        TEST_PROJECT_ID,
        TEST_REVISION_ID,
        'Read from /usr/local/bin/node',
      );

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'forbidden-data',
        }),
      );
    });
  });

  describe('oversized input', () => {
    it('rejects request with oversized request string', () => {
      const envelope = createValidEnvelope();
      (envelope as any).request = createMinimalRequest(
        TEST_PROJECT_ID,
        TEST_REVISION_ID,
        'a'.repeat(MAX_REQUEST_LENGTH + 1),
      );

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'payload-too-large',
        }),
      );
    });

    it('rejects request with oversized brief string', () => {
      const envelope = createValidEnvelope();
      (envelope as any).request = createMinimalRequest();
      (envelope.request as any).brief = 'a'.repeat(MAX_BRIEF_LENGTH + 1);

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'payload-too-large',
        }),
      );
    });

    it('rejects request with too many allowedRecommendationKinds', () => {
      const envelope = createValidEnvelope();
      (envelope as any).request = createMinimalRequest();
      (envelope.request as any).allowedRecommendationKinds = Array.from(
        { length: 21 },
        (_, i) => `kind-${i}`,
      );

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'payload-too-large',
        }),
      );
    });
  });

  describe('invalid scope', () => {
    it('rejects request with invalid scope', () => {
      const envelope = createValidEnvelope();
      (envelope as any).request = createMinimalRequest(
        TEST_PROJECT_ID,
        TEST_REVISION_ID,
        'Test',
        'invalid-scope' as any,
      );

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-request',
          message: expect.stringContaining('scope must be one of'),
        }),
      );
    });
  });

  describe('invalid destination preset', () => {
    it('rejects request with invalid destination', () => {
      const envelope = createValidEnvelope();
      (envelope as any).request = createMinimalRequest();
      (envelope.request as any).destination = 'invalid-destination';

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-request',
          message: expect.stringContaining('destination must be one of'),
        }),
      );
    });
  });

  describe('invalid numeric fields', () => {
    it('rejects request with negative durationTargetUs', () => {
      const envelope = createValidEnvelope();
      (envelope as any).request = createMinimalRequest();
      (envelope.request as any).durationTargetUs = -1000;

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-request',
          message: expect.stringContaining('durationTargetUs must be a non-negative number'),
        }),
      );
    });

    it('rejects request with negative maxRecommendations', () => {
      const envelope = createValidEnvelope();
      (envelope.request as any).maxRecommendations = -5;

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-request',
          path: 'envelope.request.maxRecommendations',
        }),
      );
    });

    it('rejects request with maxRecommendations of zero', () => {
      const envelope = createValidEnvelope();
      (envelope.request as any).maxRecommendations = 0;

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-request',
          path: 'envelope.request.maxRecommendations',
        }),
      );
    });

    it('rejects request with non-integer maxRecommendations', () => {
      const envelope = createValidEnvelope();
      (envelope.request as any).maxRecommendations = 5.5;

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-request',
          path: 'envelope.request.maxRecommendations',
        }),
      );
    });
  });

  describe('Persian request preservation', () => {
    it('accepts valid request with Persian text', () => {
      const persianRequest = 'درخواست خلاقانه به زبان فارسی';
      const envelope = createValidEnvelope();
      (envelope as any).request = createMinimalRequest(
        TEST_PROJECT_ID,
        TEST_REVISION_ID,
        persianRequest,
      );

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts valid request with mixed Persian and English', () => {
      const mixedRequest = 'Make this video برای شبکه های اجتماعی';
      const envelope = createValidEnvelope();
      (envelope as any).request = createMinimalRequest(
        TEST_PROJECT_ID,
        TEST_REVISION_ID,
        mixedRequest,
      );

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts valid request with Persian brief', () => {
      const persianBrief = 'توضیحات اضافی به زبان فارسی';
      const envelope = createValidEnvelope();
      (envelope as any).request = createMinimalRequest();
      (envelope.request as any).brief = persianBrief;

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('no mutation of input', () => {
    it('does not mutate the envelope object', () => {
      const envelope = createValidEnvelope();
      const envelopeCopy = JSON.parse(JSON.stringify(envelope));

      validateCreativeBriefServerRequest(envelope, TEST_ROUTE_PROJECT_ID, TEST_ROUTE_REVISION_ID);

      expect(envelope).toEqual(envelopeCopy);
    });

    it('does not mutate the request object', () => {
      const envelope = createValidEnvelope();
      const requestCopy = JSON.parse(JSON.stringify(envelope.request));

      validateCreativeBriefServerRequest(envelope, TEST_ROUTE_PROJECT_ID, TEST_ROUTE_REVISION_ID);

      expect(envelope.request).toEqual(requestCopy);
    });

    it('does not mutate the snapshot object', () => {
      const envelope = createValidEnvelope();
      const snapshotCopy = JSON.parse(JSON.stringify(envelope.snapshot));

      validateCreativeBriefServerRequest(envelope, TEST_ROUTE_PROJECT_ID, TEST_ROUTE_REVISION_ID);

      expect(envelope.snapshot).toEqual(snapshotCopy);
    });

    it('does not mutate the intelligence object', () => {
      const envelope = createValidEnvelope();
      const intelligenceCopy = JSON.parse(JSON.stringify(envelope.intelligence));

      validateCreativeBriefServerRequest(envelope, TEST_ROUTE_PROJECT_ID, TEST_ROUTE_REVISION_ID);

      expect(envelope.intelligence).toEqual(intelligenceCopy);
    });
  });

  describe('edge cases', () => {
    it('rejects null envelope', () => {
      const result = validateCreativeBriefServerRequest(
        null,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-request',
        }),
      );
    });

    it('rejects array envelope', () => {
      const result = validateCreativeBriefServerRequest(
        [],
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-request',
        }),
      );
    });

    it('rejects envelope missing projectId', () => {
      const envelope = createValidEnvelope();
      delete (envelope as any).projectId;

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-request',
        }),
      );
    });

    it('rejects envelope with empty projectId string', () => {
      const envelope = createValidEnvelope();
      (envelope as any).projectId = '';

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-request',
        }),
      );
    });

    it('rejects envelope missing snapshotRevisionId', () => {
      const envelope = createValidEnvelope();
      delete (envelope as any).snapshotRevisionId;

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-request',
        }),
      );
    });

    it('rejects envelope with empty snapshotRevisionId string', () => {
      const envelope = createValidEnvelope();
      (envelope as any).snapshotRevisionId = '';

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-request',
        }),
      );
    });

    it('rejects envelope missing snapshot', () => {
      const envelope = createValidEnvelope();
      delete (envelope as any).snapshot;

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-request',
        }),
      );
    });

    it('rejects envelope missing intelligence', () => {
      const envelope = createValidEnvelope();
      delete (envelope as any).intelligence;

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-request',
        }),
      );
    });

    it('rejects envelope missing request', () => {
      const envelope = createValidEnvelope();
      delete (envelope as any).request;

      const result = validateCreativeBriefServerRequest(
        envelope,
        TEST_ROUTE_PROJECT_ID,
        TEST_ROUTE_REVISION_ID,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-request',
        }),
      );
    });
  });
});
