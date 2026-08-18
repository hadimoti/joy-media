/**
 * Creative Brief Client Request Validation Tests - WP-37 S4-F10-E3-B
 *
 * Focused tests for strict browser-to-resolver request validation.
 */

import { describe, it, expect } from 'vitest';
import {
  validateCreativeBriefClientRequest,
  isValidCreativeBriefClientRequest,
  MAX_CREATIVE_BRIEF_CLIENT_REQUEST_BYTES,
} from './creative-brief-client-request-validation.js';
import type { CreativeBriefRequestV1 } from '@joy-media/agent-tools';

// ============================================================================
// Valid Requests
// ============================================================================

describe('validateCreativeBriefClientRequest - valid requests', () => {
  it('should accept valid English request', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video about nature',
        scope: 'video',
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should accept valid Persian request', () => {
    const persianText = 'به من کمک کن یک ویدئو بسازم';
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: persianText,
        scope: 'video',
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should accept valid request with all optional fields', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
        maxRecommendations: 5,
        brief: 'Additional context',
        durationTargetUs: 1000000,
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should accept valid request with different scopes', () => {
    const scopes = ['video', 'audio', 'image', 'motion-graphic'] as const;

    for (const scope of scopes) {
      const envelope = {
        projectId: 'test-project-id',
        snapshotRevisionId: 'test-revision-id',
        request: {
          snapshotRevisionId: 'test-revision-id',
          projectId: 'test-project-id',
          request: `Create a ${scope}`,
          scope,
        },
      };

      const result = validateCreativeBriefClientRequest(envelope);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    }
  });

  it('should have type guard that matches valid envelope', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
    };

    expect(isValidCreativeBriefClientRequest(envelope)).toBe(true);
  });
});

// ============================================================================
// Project/Revision Mismatch
// ============================================================================

describe('validateCreativeBriefClientRequest - project/revision mismatch', () => {
  it('should reject when top-level projectId does not match request.projectId', () => {
    const envelope = {
      projectId: 'outer-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'inner-project-id',
        request: 'Create a video',
        scope: 'video',
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('project-mismatch');
  });

  it('should reject when top-level snapshotRevisionId does not match request.snapshotRevisionId', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'outer-revision-id',
      request: {
        snapshotRevisionId: 'inner-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('revision-mismatch');
  });
});

// ============================================================================
// Forbidden Fields (S1/S2 Rejection)
// ============================================================================

describe('validateCreativeBriefClientRequest - forbidden fields', () => {
  it('should reject snapshot field at top level', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
      snapshot: { version: 1, projectId: 'test', revisionId: 'test', scenes: [], timeline: { tracks: [], durationUs: 0 }, resources: { assets: new Map(), elements: new Map() }, metadata: { title: '', description: '', tags: [], createdAt: '' } },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'forbidden-field' && e.path === 'snapshot')).toBe(true);
  });

  it('should reject intelligence field at top level', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
      intelligence: { brandReadiness: { score: 0, summary: '' }, sceneCoverages: [], projectReadiness: { score: 0, summary: '' }, rules: [] },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'forbidden-field' && e.path === 'intelligence')).toBe(true);
  });

  it('should reject assets field at top level', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
      assets: [{ id: 'asset-1', url: 'http://example.com' }],
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'forbidden-field' && e.path === 'assets')).toBe(true);
  });

  it('should reject provider field at top level', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
      provider: 'openrouter',
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'forbidden-field' && e.path === 'provider')).toBe(true);
  });

  it('should reject secret field at top level', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
      secret: 'sk-1234567890',
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'forbidden-field' && e.path === 'secret')).toBe(true);
  });

  it('should reject path field at top level', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
      path: '/some/path',
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'forbidden-field' && e.path === 'path')).toBe(true);
  });

  it('should reject url field at top level', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
      url: 'http://example.com',
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'forbidden-field' && e.path === 'url')).toBe(true);
  });

  it('should reject apiKey field at top level', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
      apiKey: 'sk-1234567890',
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'forbidden-field' && e.path === 'apiKey')).toBe(true);
  });
});

// ============================================================================
// Unknown Fields
// ============================================================================

describe('validateCreativeBriefClientRequest - unknown fields', () => {
  it('should reject unknown top-level field', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
      unknownField: 'some-value',
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'unknown-field')).toBe(true);
  });

  it('should reject unknown nested field in request', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
        unknownRequestField: 'some-value',
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-request' && e.path === 'request')).toBe(true);
  });
});

// ============================================================================
// Invalid Envelope Structure
// ============================================================================

describe('validateCreativeBriefClientRequest - invalid envelope', () => {
  it('should reject null envelope', () => {
    const result = validateCreativeBriefClientRequest(null);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('invalid-envelope');
  });

  it('should reject array envelope', () => {
    const result = validateCreativeBriefClientRequest(['projectId', 'snapshotRevisionId']);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('invalid-envelope');
  });

  it('should reject missing projectId', () => {
    const envelope = {
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-envelope' && e.path === 'projectId')).toBe(true);
  });

  it('should reject missing snapshotRevisionId', () => {
    const envelope = {
      projectId: 'test-project-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-envelope' && e.path === 'snapshotRevisionId')).toBe(true);
  });

  it('should reject missing request', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-envelope' && e.path === 'request')).toBe(true);
  });

  it('should reject empty projectId', () => {
    const envelope = {
      projectId: '',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-envelope' && e.path === 'projectId')).toBe(true);
  });

  it('should reject whitespace-only projectId', () => {
    const envelope = {
      projectId: '   ',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-envelope' && e.path === 'projectId')).toBe(true);
  });

  it('should reject empty snapshotRevisionId', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: '',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-envelope' && e.path === 'snapshotRevisionId')).toBe(true);
  });

  it('should reject non-string projectId', () => {
    const envelope = {
      projectId: 123,
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-envelope' && e.path === 'projectId')).toBe(true);
  });

  it('should reject non-object request', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: 'not-an-object',
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-request' && e.path === 'request')).toBe(true);
  });
});

// ============================================================================
// Invalid Request Fields
// ============================================================================

describe('validateCreativeBriefClientRequest - invalid request fields', () => {
  it('should reject missing required fields in request', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        request: 'Create a video',
        scope: 'video',
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-request' && e.path === 'request')).toBe(true);
  });

  it('should reject empty request string', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: '',
        scope: 'video',
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-request' && e.path === 'request.request')).toBe(true);
  });

  it('should reject missing scope', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-request' && e.path === 'request')).toBe(true);
  });

  it('should reject invalid scope', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'invalid-scope',
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-request' && e.path === 'request.scope')).toBe(true);
  });

  it('should reject invalid maxRecommendations', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
        maxRecommendations: 0,
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-request' && e.path === 'request.maxRecommendations')).toBe(true);
  });

  it('should reject maxRecommendations above 20', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
        maxRecommendations: 21,
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-request' && e.path === 'request.maxRecommendations')).toBe(true);
  });

  it('should reject negative durationTargetUs', () => {
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
        durationTargetUs: -1,
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-request' && e.path === 'request.durationTargetUs')).toBe(true);
  });

  it('should reject oversized brief', () => {
    const oversizedBrief = 'a'.repeat(1001);
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
        brief: oversizedBrief,
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'invalid-request' && e.path === 'request.brief')).toBe(true);
  });
});

// ============================================================================
// Payload Size
// ============================================================================

describe('validateCreativeBriefClientRequest - payload size', () => {
  it('should have maximum payload size constant', () => {
    expect(MAX_CREATIVE_BRIEF_CLIENT_REQUEST_BYTES).toBe(256 * 1024);
  });

  it('should reject payload that is too large', () => {
    // Create a very large request object
    const largeBrief = 'a'.repeat(260 * 1024);
    const envelope = {
      projectId: 'test-project-id',
      snapshotRevisionId: 'test-revision-id',
      request: {
        snapshotRevisionId: 'test-revision-id',
        projectId: 'test-project-id',
        request: 'Create a video',
        scope: 'video',
        brief: largeBrief,
      },
    };

    const result = validateCreativeBriefClientRequest(envelope);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'payload-too-large')).toBe(true);
  });
});

// ============================================================================
// Type Guard Tests
// ============================================================================

describe('isValidCreativeBriefClientRequest', () => {
  it('should return false for null', () => {
    expect(isValidCreativeBriefClientRequest(null)).toBe(false);
  });

  it('should return false for array', () => {
    expect(isValidCreativeBriefClientRequest([])).toBe(false);
  });

  it('should return false for missing projectId', () => {
    const envelope = {
      snapshotRevisionId: 'test',
      request: { snapshotRevisionId: 'test', projectId: 'test', request: 'test', scope: 'video' },
    };
    expect(isValidCreativeBriefClientRequest(envelope)).toBe(false);
  });

  it('should return false for missing snapshotRevisionId', () => {
    const envelope = {
      projectId: 'test',
      request: { snapshotRevisionId: 'test', projectId: 'test', request: 'test', scope: 'video' },
    };
    expect(isValidCreativeBriefClientRequest(envelope)).toBe(false);
  });

  it('should return false for missing request', () => {
    const envelope = {
      projectId: 'test',
      snapshotRevisionId: 'test',
    };
    expect(isValidCreativeBriefClientRequest(envelope)).toBe(false);
  });

  it('should return true for valid envelope', () => {
    const envelope = {
      projectId: 'test',
      snapshotRevisionId: 'test',
      request: { snapshotRevisionId: 'test', projectId: 'test', request: 'test', scope: 'video' },
    };
    expect(isValidCreativeBriefClientRequest(envelope)).toBe(true);
  });
});
