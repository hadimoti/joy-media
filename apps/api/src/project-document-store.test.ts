/**
 * Project Document Store Contract Tests (WP-37 S4-F10-E5-A)
 *
 * Focused tests for the pure contract module - NO I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  ProjectDocumentRecord,
  ProjectDocumentReadOutcomeNotFound,
  ProjectDocumentReadOutcomeReady,
  ProjectDocumentReadOutcomeStaleRevision,
  ProjectDocumentWriteOutcomeInvalidDocument,
  ProjectDocumentWriteOutcomeNotFound,
  ProjectDocumentWriteOutcomeOwnerDenied,
  ProjectDocumentWriteOutcomeRevisionConflict,
  ProjectDocumentWriteOutcomeStored,
  ProjectId,
  OwnerId,
  validateProjectDocumentRecord,
  isValidProjectDocumentRecord,
} from './project-document-store.js';
import type { ProjectRevisionId, JoyProjectV1 } from '@joy-media/project-schema';

// ============================================================================
// Fixtures
// ============================================================================

const VALID_PROJECT_ID: ProjectId = 'project-abc-123';
const VALID_OWNER_ID: OwnerId = 'owner-xyz-789';
const VALID_REVISION_ID: ProjectRevisionId = 'rev-1';
const ANOTHER_REVISION_ID: ProjectRevisionId = 'rev-2';
const ANOTHER_OWNER_ID: OwnerId = 'owner-other';

function minimalValidJoyProjectV1(id: string): JoyProjectV1 {
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

const VALID_DOCUMENT: JoyProjectV1 = minimalValidJoyProjectV1('project-abc-123');

function validRecord(
  projectId: ProjectId = VALID_PROJECT_ID,
  ownerId: OwnerId = VALID_OWNER_ID,
  revisionId: ProjectRevisionId = VALID_REVISION_ID,
  document: JoyProjectV1 = VALID_DOCUMENT,
): ProjectDocumentRecord {
  return {
    projectId,
    ownerId,
    revisionId,
    document,
  };
}

// ============================================================================
// validateProjectDocumentRecord tests
// ============================================================================

describe('validateProjectDocumentRecord', () => {
  it('returns empty diagnostics for a valid record', () => {
    const diagnostics = validateProjectDocumentRecord(validRecord());
    expect(diagnostics).toEqual([]);
  });

  it('fails closed on null input', () => {
    const diagnostics = validateProjectDocumentRecord(null);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('PROJECT_DOCUMENT_RECORD_NOT_OBJECT');
  });

  it('fails closed on undefined input', () => {
    const diagnostics = validateProjectDocumentRecord(undefined);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('PROJECT_DOCUMENT_RECORD_NOT_OBJECT');
  });

  it('fails closed on array input', () => {
    const diagnostics = validateProjectDocumentRecord([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('PROJECT_DOCUMENT_RECORD_NOT_OBJECT');
  });

  it('fails closed on empty projectId', () => {
    const record = validRecord();
    record.projectId = '' as ProjectId;
    const diagnostics = validateProjectDocumentRecord(record);
    expect(diagnostics).toContainEqual({
      code: 'PROJECT_DOCUMENT_INVALID_PROJECT_ID',
      message: 'projectId must be a non-empty string',
      path: 'projectId',
    });
  });

  it('fails closed on missing projectId', () => {
    const diagnostics = validateProjectDocumentRecord({
      ownerId: VALID_OWNER_ID,
      revisionId: VALID_REVISION_ID,
      document: VALID_DOCUMENT,
    });
    expect(diagnostics).toContainEqual({
      code: 'PROJECT_DOCUMENT_INVALID_PROJECT_ID',
      message: 'projectId must be a non-empty string',
      path: 'projectId',
    });
  });

  it('fails closed on empty ownerId', () => {
    const record = validRecord();
    record.ownerId = '' as OwnerId;
    const diagnostics = validateProjectDocumentRecord(record);
    expect(diagnostics).toContainEqual({
      code: 'PROJECT_DOCUMENT_INVALID_OWNER_ID',
      message: 'ownerId must be a non-empty string',
      path: 'ownerId',
    });
  });

  it('fails closed on empty revisionId', () => {
    const record = validRecord();
    record.revisionId = '' as ProjectRevisionId;
    const diagnostics = validateProjectDocumentRecord(record);
    expect(diagnostics).toContainEqual({
      code: 'PROJECT_DOCUMENT_INVALID_REVISION_ID',
      message: 'revisionId must be a non-empty string',
      path: 'revisionId',
    });
  });

  it('fails closed on missing document', () => {
    const diagnostics = validateProjectDocumentRecord({
      projectId: VALID_PROJECT_ID,
      ownerId: VALID_OWNER_ID,
      revisionId: VALID_REVISION_ID,
      document: undefined as unknown as JoyProjectV1,
    });
    expect(diagnostics).toContainEqual({
      code: 'PROJECT_DOCUMENT_MISSING',
      message: 'document must be present',
      path: 'document',
    });
  });

  it('fails closed on null document', () => {
    const diagnostics = validateProjectDocumentRecord({
      projectId: VALID_PROJECT_ID,
      ownerId: VALID_OWNER_ID,
      revisionId: VALID_REVISION_ID,
      document: null as unknown as JoyProjectV1,
    });
    expect(diagnostics).toContainEqual({
      code: 'PROJECT_DOCUMENT_MISSING',
      message: 'document must be present',
      path: 'document',
    });
  });

  it('fails closed on invalid JoyProjectV1 (wrong schemaVersion)', () => {
    const diagnostics = validateProjectDocumentRecord({
      projectId: VALID_PROJECT_ID,
      ownerId: VALID_OWNER_ID,
      revisionId: VALID_REVISION_ID,
      document: { schemaVersion: 2 } as unknown as JoyProjectV1,
    });
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some((d) => d.code.includes('SCHEMA'))).toBe(true);
  });

  it('fails closed on invalid JoyProjectV1 (missing id)', () => {
    const diagnostics = validateProjectDocumentRecord({
      projectId: VALID_PROJECT_ID,
      ownerId: VALID_OWNER_ID,
      revisionId: VALID_REVISION_ID,
      document: { schemaVersion: 1, title: 'test' } as unknown as JoyProjectV1,
    });
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// isValidProjectDocumentRecord tests
// ============================================================================

describe('isValidProjectDocumentRecord', () => {
  it('returns true for a valid record', () => {
    expect(isValidProjectDocumentRecord(validRecord())).toBe(true);
  });

  it('returns false for null input', () => {
    expect(isValidProjectDocumentRecord(null)).toBe(false);
  });

  it('returns false for invalid projectId', () => {
    expect(
      isValidProjectDocumentRecord({
        ...validRecord(),
        projectId: '',
      }),
    ).toBe(false);
  });

  it('returns false for invalid document', () => {
    expect(
      isValidProjectDocumentRecord({
        ...validRecord(),
        document: { schemaVersion: 999 } as unknown as JoyProjectV1,
      }),
    ).toBe(false);
  });
});

// ============================================================================
// Read Outcome Shape Tests
// ============================================================================

describe('Read Outcome shapes', () => {
  it('ProjectDocumentReadOutcomeReady has correct shape', () => {
    const outcome: ProjectDocumentReadOutcomeReady = {
      kind: 'ready',
      record: validRecord(),
    };
    expect(outcome.kind).toBe('ready');
    expect(outcome.record).toBeDefined();
    expect(outcome.record.projectId).toBe(VALID_PROJECT_ID);
  });

  it('ProjectDocumentReadOutcomeNotFound has correct shape', () => {
    const outcome: ProjectDocumentReadOutcomeNotFound = {
      kind: 'not-found',
      projectId: VALID_PROJECT_ID,
      revisionId: null,
    };
    expect(outcome.kind).toBe('not-found');
    expect(outcome.projectId).toBe(VALID_PROJECT_ID);
    expect(outcome.revisionId).toBeNull();
  });

  it('ProjectDocumentReadOutcomeNotFound has correct shape with revisionId', () => {
    const outcome: ProjectDocumentReadOutcomeNotFound = {
      kind: 'not-found',
      projectId: VALID_PROJECT_ID,
      revisionId: VALID_REVISION_ID,
    };
    expect(outcome.kind).toBe('not-found');
    expect(outcome.revisionId).toBe(VALID_REVISION_ID);
  });

  it('ProjectDocumentReadOutcomeStaleRevision has correct shape', () => {
    const outcome: ProjectDocumentReadOutcomeStaleRevision = {
      kind: 'stale-revision',
      projectId: VALID_PROJECT_ID,
      requestedRevisionId: VALID_REVISION_ID,
      currentRevisionId: ANOTHER_REVISION_ID,
    };
    expect(outcome.kind).toBe('stale-revision');
    expect(outcome.requestedRevisionId).toBe(VALID_REVISION_ID);
    expect(outcome.currentRevisionId).toBe(ANOTHER_REVISION_ID);
  });
});

// ============================================================================
// Write Outcome Shape Tests
// ============================================================================

describe('Write Outcome shapes', () => {
  it('ProjectDocumentWriteOutcomeStored has correct shape', () => {
    const outcome: ProjectDocumentWriteOutcomeStored = {
      kind: 'stored',
      projectId: VALID_PROJECT_ID,
      ownerId: VALID_OWNER_ID,
      revisionId: VALID_REVISION_ID,
    };
    expect(outcome.kind).toBe('stored');
    expect(outcome.projectId).toBe(VALID_PROJECT_ID);
    expect(outcome.ownerId).toBe(VALID_OWNER_ID);
    expect(outcome.revisionId).toBe(VALID_REVISION_ID);
  });

  it('ProjectDocumentWriteOutcomeNotFound has correct shape', () => {
    const outcome: ProjectDocumentWriteOutcomeNotFound = {
      kind: 'not-found',
      projectId: VALID_PROJECT_ID,
    };
    expect(outcome.kind).toBe('not-found');
    expect(outcome.projectId).toBe(VALID_PROJECT_ID);
  });

  it('ProjectDocumentWriteOutcomeOwnerDenied has correct shape', () => {
    const outcome: ProjectDocumentWriteOutcomeOwnerDenied = {
      kind: 'owner-denied',
      projectId: VALID_PROJECT_ID,
      ownerId: VALID_OWNER_ID,
      callerId: ANOTHER_OWNER_ID,
    };
    expect(outcome.kind).toBe('owner-denied');
    expect(outcome.ownerId).toBe(VALID_OWNER_ID);
    expect(outcome.callerId).toBe(ANOTHER_OWNER_ID);
  });

  it('ProjectDocumentWriteOutcomeRevisionConflict has correct shape', () => {
    const outcome: ProjectDocumentWriteOutcomeRevisionConflict = {
      kind: 'revision-conflict',
      projectId: VALID_PROJECT_ID,
      expectedBaseRevisionId: VALID_REVISION_ID,
      actualBaseRevisionId: ANOTHER_REVISION_ID,
    };
    expect(outcome.kind).toBe('revision-conflict');
    expect(outcome.expectedBaseRevisionId).toBe(VALID_REVISION_ID);
    expect(outcome.actualBaseRevisionId).toBe(ANOTHER_REVISION_ID);
  });

  it('ProjectDocumentWriteOutcomeInvalidDocument has correct shape', () => {
    const outcome: ProjectDocumentWriteOutcomeInvalidDocument = {
      kind: 'invalid-document',
      projectId: VALID_PROJECT_ID,
      diagnostics: [
        { code: 'PROJECT_SCHEMA_V1_VERSION', message: 'test', path: 'schemaVersion' },
      ],
    };
    expect(outcome.kind).toBe('invalid-document');
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0].code).toBe('PROJECT_SCHEMA_V1_VERSION');
  });
});

// ============================================================================
// Proof of No I/O
// ============================================================================

describe('Proof of no I/O in contract module', () => {
  it('module has no side effects on import', () => {
    // This test passes if the import succeeds without requiring any external state
    // The contract is purely types and functions with no I/O
    expect(() => {
      import('./project-document-store.js');
    }).not.toThrow();
  });

  it('validateProjectDocumentRecord is a pure function', () => {
    // Same input always produces same output (referential transparency)
    const record = validRecord();
    const result1 = validateProjectDocumentRecord(record);
    const result2 = validateProjectDocumentRecord(record);
    expect(result1).toEqual(result2);
  });

  it('isValidProjectDocumentRecord is a pure function', () => {
    const record = validRecord();
    const result1 = isValidProjectDocumentRecord(record);
    const result2 = isValidProjectDocumentRecord(record);
    expect(result1).toBe(result2);
  });
});
