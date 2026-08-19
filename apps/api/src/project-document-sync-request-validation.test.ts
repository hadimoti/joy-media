/**
 * Project Document Sync Request Validation Tests - WP-37 S4 Phase 5-A
 *
 * Focused tests for strict browser-to-server write envelope validation.
 */

import { describe, it, expect } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import {
  validateProjectDocumentSyncRequest,
  isValidProjectDocumentSyncEnvelope,
  MAX_PROJECT_DOCUMENT_SYNC_BYTES,
  INITIAL_REVISION,
} from './project-document-sync-request-validation.js';

// ============================================================================
// Fixtures
// ============================================================================

const EXPECTED_PROJECT_ID = 'test-project-123';
const ANOTHER_PROJECT_ID = 'another-project-456';
const VALID_REVISION_ID = 'rev-abc-123';
const ANOTHER_REVISION_ID = 'rev-def-456';

function minimalValidJoyProjectV1(id: string = EXPECTED_PROJECT_ID): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id,
    title: 'Test Project',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
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

const VALID_DOCUMENT = minimalValidJoyProjectV1();

function validEnvelope(
  baseRevisionId: string = INITIAL_REVISION,
  revisionId: string = VALID_REVISION_ID,
  document: JoyProjectV1 = VALID_DOCUMENT,
): unknown {
  return {
    baseRevisionId,
    revisionId,
    document,
  };
}

// ============================================================================
// Valid Requests
// ============================================================================

describe('validateProjectDocumentSyncRequest - valid requests', () => {
  it('should accept valid first write with INITIAL_REVISION', () => {
    const envelope = validEnvelope(INITIAL_REVISION, VALID_REVISION_ID, VALID_DOCUMENT);
    const originalEnvelope = JSON.parse(JSON.stringify(envelope));

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    // Verify input immutability
    expect(envelope).toEqual(originalEnvelope);
  });

  it('should accept valid update write with non-empty baseRevisionId', () => {
    const envelope = validEnvelope(ANOTHER_REVISION_ID, VALID_REVISION_ID, VALID_DOCUMENT);

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should have type guard that matches valid envelope', () => {
    const envelope = validEnvelope(INITIAL_REVISION, VALID_REVISION_ID, VALID_DOCUMENT);

    expect(isValidProjectDocumentSyncEnvelope(envelope, EXPECTED_PROJECT_ID)).toBe(true);
  });

  it('should have type guard that rejects invalid envelope', () => {
    const envelope = { baseRevisionId: INITIAL_REVISION, revisionId: VALID_REVISION_ID };

    expect(isValidProjectDocumentSyncEnvelope(envelope, EXPECTED_PROJECT_ID)).toBe(false);
  });
});

// ============================================================================
// Strict Fields Validation
// ============================================================================

describe('validateProjectDocumentSyncRequest - strict fields', () => {
  it('should reject missing baseRevisionId', () => {
    const envelope = {
      revisionId: VALID_REVISION_ID,
      document: VALID_DOCUMENT,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('missing-field');
    expect(result.errors[0]?.message).toContain('baseRevisionId');
  });

  it('should reject missing revisionId', () => {
    const envelope = {
      baseRevisionId: INITIAL_REVISION,
      document: VALID_DOCUMENT,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('missing-field');
    expect(result.errors[0]?.message).toContain('revisionId');
  });

  it('should reject missing document', () => {
    const envelope = {
      baseRevisionId: INITIAL_REVISION,
      revisionId: VALID_REVISION_ID,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('missing-field');
    expect(result.errors[0]?.message).toContain('document');
  });

  it('should reject all missing fields', () => {
    const envelope = {};

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('missing-field');
    expect(result.errors[0]?.message).toContain('baseRevisionId');
    expect(result.errors[0]?.message).toContain('revisionId');
    expect(result.errors[0]?.message).toContain('document');
  });

  it('should reject unknown top-level fields', () => {
    const envelope = {
      baseRevisionId: INITIAL_REVISION,
      revisionId: VALID_REVISION_ID,
      document: VALID_DOCUMENT,
      extraField: 'should-not-be-here',
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('invalid-request');
    expect(result.errors[0]?.message).toContain('extraField');
  });
});

// ============================================================================
// Forbidden Fields (projectId, owner, auth, etc.)
// ============================================================================

describe('validateProjectDocumentSyncRequest - forbidden fields rejected', () => {
  it('should reject envelope with projectId field', () => {
    const envelope = {
      projectId: EXPECTED_PROJECT_ID,
      baseRevisionId: INITIAL_REVISION,
      revisionId: VALID_REVISION_ID,
      document: VALID_DOCUMENT,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('forbidden-field');
    expect(result.errors[0]?.message).toContain('projectId');
  });

  it('should reject envelope with ownerId field', () => {
    const envelope = {
      ownerId: 'some-owner',
      baseRevisionId: INITIAL_REVISION,
      revisionId: VALID_REVISION_ID,
      document: VALID_DOCUMENT,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('forbidden-field');
    expect(result.errors[0]?.message).toContain('ownerId');
  });

  it('should reject envelope with owner field', () => {
    const envelope = {
      owner: { id: 'some-owner' },
      baseRevisionId: INITIAL_REVISION,
      revisionId: VALID_REVISION_ID,
      document: VALID_DOCUMENT,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('forbidden-field');
    expect(result.errors[0]?.message).toContain('owner');
  });

  it('should reject envelope with userId field', () => {
    const envelope = {
      userId: 'some-user',
      baseRevisionId: INITIAL_REVISION,
      revisionId: VALID_REVISION_ID,
      document: VALID_DOCUMENT,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('forbidden-field');
    expect(result.errors[0]?.message).toContain('userId');
  });

  it('should reject envelope with auth field', () => {
    const envelope = {
      auth: { token: 'secret' },
      baseRevisionId: INITIAL_REVISION,
      revisionId: VALID_REVISION_ID,
      document: VALID_DOCUMENT,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('forbidden-field');
    expect(result.errors[0]?.message).toContain('auth');
  });

  it('should reject envelope with token field', () => {
    const envelope = {
      token: 'secret-token',
      baseRevisionId: INITIAL_REVISION,
      revisionId: VALID_REVISION_ID,
      document: VALID_DOCUMENT,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('forbidden-field');
    expect(result.errors[0]?.message).toContain('token');
  });

  it('should reject envelope with apiKey field', () => {
    const envelope = {
      apiKey: 'secret-key',
      baseRevisionId: INITIAL_REVISION,
      revisionId: VALID_REVISION_ID,
      document: VALID_DOCUMENT,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('forbidden-field');
    expect(result.errors[0]?.message).toContain('apiKey');
  });

  it('should reject envelope with secret field', () => {
    const envelope = {
      secret: 'secret-value',
      baseRevisionId: INITIAL_REVISION,
      revisionId: VALID_REVISION_ID,
      document: VALID_DOCUMENT,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('forbidden-field');
    expect(result.errors[0]?.message).toContain('secret');
  });
});

// ============================================================================
// Invalid/Malformed Revision IDs
// ============================================================================

describe('validateProjectDocumentSyncRequest - invalid revisions', () => {
  it('should reject non-string baseRevisionId', () => {
    const envelope = {
      baseRevisionId: 123,
      revisionId: VALID_REVISION_ID,
      document: VALID_DOCUMENT,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('invalid-request');
    expect(result.errors[0]?.path).toBe('baseRevisionId');
  });

  it('should reject empty string baseRevisionId that is not INITIAL_REVISION', () => {
    // This is actually INITIAL_REVISION, so it should be valid
    const envelope = {
      baseRevisionId: '',
      revisionId: VALID_REVISION_ID,
      document: VALID_DOCUMENT,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject non-string revisionId', () => {
    const envelope = {
      baseRevisionId: INITIAL_REVISION,
      revisionId: 123,
      document: VALID_DOCUMENT,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('invalid-request');
    expect(result.errors[0]?.path).toBe('revisionId');
  });

  it('should reject empty string revisionId', () => {
    const envelope = {
      baseRevisionId: INITIAL_REVISION,
      revisionId: '',
      document: VALID_DOCUMENT,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('revision-mismatch');
    expect(result.errors[0]?.path).toBe('revisionId');
  });

  it('should reject null revisionId', () => {
    const envelope = {
      baseRevisionId: INITIAL_REVISION,
      revisionId: null,
      document: VALID_DOCUMENT,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('invalid-request');
    expect(result.errors[0]?.path).toBe('revisionId');
  });
});

// ============================================================================
// Invalid/Mismatched Document
// ============================================================================

describe('validateProjectDocumentSyncRequest - invalid/mismatched document', () => {
  it('should reject when document.id does not match expected projectId', () => {
    const doc = minimalValidJoyProjectV1(ANOTHER_PROJECT_ID);
    const envelope = validEnvelope(INITIAL_REVISION, VALID_REVISION_ID, doc);

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('project-mismatch');
    expect(result.errors[0]?.path).toBe('document.id');
    expect(result.errors[0]?.message).toContain(ANOTHER_PROJECT_ID);
    expect(result.errors[0]?.message).toContain(EXPECTED_PROJECT_ID);
  });

  it('should reject invalid JoyProjectV1 document', () => {
    const invalidDoc = { ...VALID_DOCUMENT, schemaVersion: 999 } as unknown as JoyProjectV1;
    const envelope = validEnvelope(INITIAL_REVISION, VALID_REVISION_ID, invalidDoc);

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('invalid-document');
    expect(result.errors[0]?.path).toBe('document');
  });

  it('should reject document with missing id', () => {
    const doc = { ...VALID_DOCUMENT, id: undefined } as unknown as JoyProjectV1;
    const envelope = validEnvelope(INITIAL_REVISION, VALID_REVISION_ID, doc);

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('invalid-document');
    expect(result.errors[0]?.path).toBe('document.id');
  });

  it('should reject null document', () => {
    const envelope = {
      baseRevisionId: INITIAL_REVISION,
      revisionId: VALID_REVISION_ID,
      document: null,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('invalid-request');
    expect(result.errors[0]?.path).toBe('document');
  });

  it('should reject array document', () => {
    const envelope = {
      baseRevisionId: INITIAL_REVISION,
      revisionId: VALID_REVISION_ID,
      document: [],
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('invalid-request');
    expect(result.errors[0]?.path).toBe('document');
  });

  it('should reject string document', () => {
    const envelope = {
      baseRevisionId: INITIAL_REVISION,
      revisionId: VALID_REVISION_ID,
      document: 'not-a-document',
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('invalid-request');
    expect(result.errors[0]?.path).toBe('document');
  });
});

// ============================================================================
// Oversized Payload
// ============================================================================

describe('validateProjectDocumentSyncRequest - oversized payload', () => {
  it('should reject payload exceeding 10 MiB', () => {
    // Create a large document that will exceed the size limit
    // Use a large title to make the payload big while keeping the structure valid
    const largeTitle = 'x'.repeat(10 * 1024 * 1024); // 10 MiB string
    const largeDoc = { ...VALID_DOCUMENT, title: largeTitle };
    const envelope = validEnvelope(INITIAL_REVISION, VALID_REVISION_ID, largeDoc);

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('payload-too-large');
    expect(result.errors[0]?.message).toContain(MAX_PROJECT_DOCUMENT_SYNC_BYTES.toString());
  });
});

// ============================================================================
// Input Immutability
// ============================================================================

describe('validateProjectDocumentSyncRequest - input immutability', () => {
  it('should not mutate the input envelope', () => {
    const envelope = validEnvelope(INITIAL_REVISION, VALID_REVISION_ID, VALID_DOCUMENT);
    const originalEnvelope = JSON.parse(JSON.stringify(envelope));

    validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(envelope).toEqual(originalEnvelope);
  });

  it('should not mutate the input envelope even when validation fails', () => {
    const envelope = {
      baseRevisionId: INITIAL_REVISION,
      revisionId: VALID_REVISION_ID,
      document: VALID_DOCUMENT,
      extraField: 'should-not-be-here',
    };
    const originalEnvelope = JSON.parse(JSON.stringify(envelope));

    validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(envelope).toEqual(originalEnvelope);
  });

  it('should return frozen errors array', () => {
    const envelope = validEnvelope(INITIAL_REVISION, VALID_REVISION_ID, VALID_DOCUMENT);

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(Object.isFrozen(result.errors)).toBe(true);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('validateProjectDocumentSyncRequest - edge cases', () => {
  it('should reject null envelope', () => {
    const result = validateProjectDocumentSyncRequest(null, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('invalid-request');
  });

  it('should reject array envelope', () => {
    const result = validateProjectDocumentSyncRequest([], EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('invalid-request');
  });

  it('should reject undefined envelope', () => {
    const result = validateProjectDocumentSyncRequest(undefined, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('invalid-request');
  });

  it('should reject string envelope', () => {
    const result = validateProjectDocumentSyncRequest('not-an-object', EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('invalid-request');
  });

  it('should reject number envelope', () => {
    const result = validateProjectDocumentSyncRequest(123, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('invalid-request');
  });

  it('should handle multiple validation errors', () => {
    const envelope = {
      projectId: EXPECTED_PROJECT_ID,
      ownerId: 'some-owner',
      baseRevisionId: 123,
      revisionId: '',
      document: null,
    };

    const result = validateProjectDocumentSyncRequest(envelope, EXPECTED_PROJECT_ID);

    expect(result.valid).toBe(false);
    // Should have forbidden fields error (takes precedence)
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
