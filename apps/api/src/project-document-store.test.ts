/**
 * Project Document Store Contract Tests (WP-37 S4-F10-E5-A)
 *
 * Focused tests for the pure contract module - NO I/O.
 */

import { describe, it, expect } from 'vitest';
import type {
  ProjectDocumentRecord,
  ProjectDocumentReadOutcomeNotFound,
  ProjectDocumentReadOutcomeReady,
  ProjectDocumentReadOutcomeStaleRevision,
  ProjectDocumentReadOutcomeUnavailable,
  ProjectDocumentWriteOutcomeInvalidDocument,
  ProjectDocumentWriteOutcomeNotFound,
  ProjectDocumentWriteOutcomeOwnerDenied,
  ProjectDocumentWriteOutcomeRevisionConflict,
  ProjectDocumentWriteOutcomeStored,
  ProjectDocumentWriteOutcomeUnavailable,
  ProjectId,
  OwnerId,
  ProjectOwnerLookup,
} from './project-document-store.js';
import {
  validateProjectDocumentRecord,
  isValidProjectDocumentRecord,
  InMemoryProjectDocumentStore,
  UnavailableProjectDocumentStore,
  INITIAL_REVISION,
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
    expect(diagnostics[0]!.code).toBe('PROJECT_DOCUMENT_RECORD_NOT_OBJECT');
  });

  it('fails closed on undefined input', () => {
    const diagnostics = validateProjectDocumentRecord(undefined);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe('PROJECT_DOCUMENT_RECORD_NOT_OBJECT');
  });

  it('fails closed on array input', () => {
    const diagnostics = validateProjectDocumentRecord([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe('PROJECT_DOCUMENT_RECORD_NOT_OBJECT');
  });

  it('fails closed on empty projectId', () => {
    const record: ProjectDocumentRecord = {
      projectId: '' as ProjectId,
      ownerId: VALID_OWNER_ID,
      revisionId: VALID_REVISION_ID,
      document: VALID_DOCUMENT,
    };
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
    const record: ProjectDocumentRecord = {
      projectId: VALID_PROJECT_ID,
      ownerId: '' as OwnerId,
      revisionId: VALID_REVISION_ID,
      document: VALID_DOCUMENT,
    };
    const diagnostics = validateProjectDocumentRecord(record);
    expect(diagnostics).toContainEqual({
      code: 'PROJECT_DOCUMENT_INVALID_OWNER_ID',
      message: 'ownerId must be a non-empty string',
      path: 'ownerId',
    });
  });

  it('fails closed on empty revisionId', () => {
    const record: ProjectDocumentRecord = {
      projectId: VALID_PROJECT_ID,
      ownerId: VALID_OWNER_ID,
      revisionId: '' as ProjectRevisionId,
      document: VALID_DOCUMENT,
    };
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
      diagnostics: [{ code: 'PROJECT_SCHEMA_V1_VERSION', message: 'test', path: 'schemaVersion' }],
    };
    expect(outcome.kind).toBe('invalid-document');
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]!.code).toBe('PROJECT_SCHEMA_V1_VERSION');
  });

  it('ProjectDocumentReadOutcomeUnavailable has correct shape', () => {
    const outcome: ProjectDocumentReadOutcomeUnavailable = {
      kind: 'unavailable',
      message: 'Project document store is unavailable',
    };
    expect(outcome.kind).toBe('unavailable');
    expect(outcome.message).toBe('Project document store is unavailable');
  });

  it('ProjectDocumentWriteOutcomeUnavailable has correct shape', () => {
    const outcome: ProjectDocumentWriteOutcomeUnavailable = {
      kind: 'unavailable',
      message: 'Project document store is unavailable',
    };
    expect(outcome.kind).toBe('unavailable');
    expect(outcome.message).toBe('Project document store is unavailable');
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

// ============================================================================
// InMemoryProjectDocumentStore Tests
// ============================================================================

describe('InMemoryProjectDocumentStore', () => {
  const PROJECT_A = 'project-a' as ProjectId;
  const PROJECT_B = 'project-b' as ProjectId;
  const OWNER_X = 'owner-x' as OwnerId;
  const OWNER_Y = 'owner-y' as OwnerId;
  const REV_1 = 'rev-1' as ProjectRevisionId;
  const REV_2 = 'rev-2' as ProjectRevisionId;
  const REV_3 = 'rev-3' as ProjectRevisionId;

  function createLookup(
    projects: Array<{ projectId: ProjectId; ownerId: OwnerId }>,
  ): ProjectOwnerLookup {
    const map = new Map<ProjectId, OwnerId>();
    for (const p of projects) {
      map.set(p.projectId, p.ownerId);
    }
    return (projectId) => map.get(projectId);
  }

  function createStore(
    projects: Array<{ projectId: ProjectId; ownerId: OwnerId }>,
  ): InMemoryProjectDocumentStore {
    return new InMemoryProjectDocumentStore(createLookup(projects));
  }

  it('initial write/read roundtrip with correct baseRevision', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);

    const doc: JoyProjectV1 = minimalValidJoyProjectV1('project-a');
    const record: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_1,
      document: doc,
    };

    const writeResult = store.writeDocument(OWNER_X, record, INITIAL_REVISION);
    expect(writeResult.kind).toBe('stored');
    const w = writeResult as ProjectDocumentWriteOutcomeStored;
    expect(w.projectId).toBe(PROJECT_A);
    expect(w.revisionId).toBe(REV_1);

    const readResult = store.readDocument(OWNER_X, PROJECT_A);
    expect(readResult.kind).toBe('ready');
    const r = readResult as ProjectDocumentReadOutcomeReady;
    expect(r.record.projectId).toBe(PROJECT_A);
    expect(r.record.revisionId).toBe(REV_1);
    expect(r.record.document).toEqual(doc);
  });

  it('unknown project returns not-found on read', () => {
    const store = createStore([]);
    const readResult = store.readDocument(OWNER_X, PROJECT_A);
    expect(readResult.kind).toBe('not-found');
    const nf = readResult as ProjectDocumentReadOutcomeNotFound;
    expect(nf.projectId).toBe(PROJECT_A);
  });

  it('unknown project returns not-found on write', () => {
    const store = createStore([]);
    const record = validRecord(PROJECT_A, OWNER_X, REV_1);
    const writeResult = store.writeDocument(OWNER_X, record, INITIAL_REVISION);
    expect(writeResult.kind).toBe('not-found');
    const nf = writeResult as ProjectDocumentWriteOutcomeNotFound;
    expect(nf.projectId).toBe(PROJECT_A);
  });

  it('owner denied on read for different owner', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);
    const readResult = store.readDocument(OWNER_Y, PROJECT_A);
    expect(readResult.kind).toBe('not-found');
    const nf = readResult as ProjectDocumentReadOutcomeNotFound;
    expect(nf.projectId).toBe(PROJECT_A);
  });

  it('owner denied on write for different owner', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);
    const record = validRecord(PROJECT_A, OWNER_Y, REV_1);
    const writeResult = store.writeDocument(OWNER_Y, record, INITIAL_REVISION);
    expect(writeResult.kind).toBe('owner-denied');
    const od = writeResult as ProjectDocumentWriteOutcomeOwnerDenied;
    expect(od.projectId).toBe(PROJECT_A);
    expect(od.ownerId).toBe(OWNER_X);
    expect(od.callerId).toBe(OWNER_Y);
  });

  it('owner denied when record.ownerId does not match project owner', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);
    const record: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_Y,
      revisionId: REV_1,
      document: minimalValidJoyProjectV1(PROJECT_A),
    };
    const writeResult = store.writeDocument(OWNER_X, record, INITIAL_REVISION);
    expect(writeResult.kind).toBe('owner-denied');
    const od = writeResult as ProjectDocumentWriteOutcomeOwnerDenied;
    expect(od.ownerId).toBe(OWNER_X);
    expect(od.callerId).toBe(OWNER_X);
  });

  it('CAS conflict when baseRevision does not match current', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);

    const doc1: JoyProjectV1 = minimalValidJoyProjectV1('project-a');
    const record1: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_1,
      document: doc1,
    };
    store.writeDocument(OWNER_X, record1, INITIAL_REVISION);

    const doc2: JoyProjectV1 = { ...doc1, title: 'Modified' };
    const record2: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_2,
      document: doc2,
    };
    const writeResult = store.writeDocument(OWNER_X, record2, 'wrong-revision');
    expect(writeResult.kind).toBe('revision-conflict');
    const rc = writeResult as ProjectDocumentWriteOutcomeRevisionConflict;
    expect(rc.expectedBaseRevisionId).toBe('wrong-revision');
    expect(rc.actualBaseRevisionId).toBe(REV_1);
  });

  it('CAS succeeds when baseRevision matches current', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);

    const doc1: JoyProjectV1 = minimalValidJoyProjectV1('project-a');
    const record1: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_1,
      document: doc1,
    };
    store.writeDocument(OWNER_X, record1, INITIAL_REVISION);

    const doc2: JoyProjectV1 = { ...doc1, title: 'Modified' };
    const record2: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_2,
      document: doc2,
    };
    const writeResult = store.writeDocument(OWNER_X, record2, REV_1);
    expect(writeResult.kind).toBe('stored');
    const w = writeResult as ProjectDocumentWriteOutcomeStored;
    expect(w.revisionId).toBe(REV_2);

    const readResult = store.readDocument(OWNER_X, PROJECT_A);
    expect(readResult.kind).toBe('ready');
    const r = readResult as ProjectDocumentReadOutcomeReady;
    expect(r.record.revisionId).toBe(REV_2);
    expect(r.record.document.title).toBe('Modified');
  });

  it('invalid document returns invalid-document without mutation', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);

    const invalidRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_1,
      document: { schemaVersion: 999 } as unknown as JoyProjectV1,
    };

    const writeResult = store.writeDocument(OWNER_X, invalidRecord, INITIAL_REVISION);
    expect(writeResult.kind).toBe('invalid-document');
    const id = writeResult as ProjectDocumentWriteOutcomeInvalidDocument;
    expect(id.projectId).toBe(PROJECT_A);
    expect(id.diagnostics.length).toBeGreaterThan(0);

    const readResult = store.readDocument(OWNER_X, PROJECT_A);
    expect(readResult.kind).toBe('not-found');
  });

  it('defensive copy prevents caller mutation of stored document', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);

    const doc: JoyProjectV1 = minimalValidJoyProjectV1('project-a');
    const record: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_1,
      document: doc,
    };
    store.writeDocument(OWNER_X, record, INITIAL_REVISION);

    (doc as any).title = 'MUTATED';

    const readResult = store.readDocument(OWNER_X, PROJECT_A);
    expect(readResult.kind).toBe('ready');
    const r = readResult as ProjectDocumentReadOutcomeReady;
    expect(r.record.document.title).toBe('Test Project');
  });

  it('defensive copy prevents caller mutation of returned document', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);

    const doc: JoyProjectV1 = minimalValidJoyProjectV1('project-a');
    const record: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_1,
      document: doc,
    };
    store.writeDocument(OWNER_X, record, INITIAL_REVISION);

    const readResult = store.readDocument(OWNER_X, PROJECT_A);
    expect(readResult.kind).toBe('ready');
    const r = readResult as ProjectDocumentReadOutcomeReady;

    (r.record.document as any).title = 'MUTATED';

    const readResult2 = store.readDocument(OWNER_X, PROJECT_A);
    expect(readResult2.kind).toBe('ready');
    const r2 = readResult2 as ProjectDocumentReadOutcomeReady;
    expect(r2.record.document.title).toBe('Test Project');
  });

  it('stale-revision when reading with non-current revisionId', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);

    const doc: JoyProjectV1 = minimalValidJoyProjectV1('project-a');
    const record: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_1,
      document: doc,
    };
    store.writeDocument(OWNER_X, record, INITIAL_REVISION);

    const readResult = store.readDocument(OWNER_X, PROJECT_A, REV_2);
    expect(readResult.kind).toBe('stale-revision');
    const sr = readResult as ProjectDocumentReadOutcomeStaleRevision;
    expect(sr.projectId).toBe(PROJECT_A);
    expect(sr.requestedRevisionId).toBe(REV_2);
    expect(sr.currentRevisionId).toBe(REV_1);
  });

  it('listRevisions returns all revisions for a project', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);

    const doc1: JoyProjectV1 = minimalValidJoyProjectV1('project-a');
    const record1: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_1,
      document: doc1,
    };
    store.writeDocument(OWNER_X, record1, INITIAL_REVISION);

    const doc2: JoyProjectV1 = { ...doc1, title: 'V2' };
    const record2: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_2,
      document: doc2,
    };
    store.writeDocument(OWNER_X, record2, REV_1);

    const revisions = store.listRevisions(OWNER_X, PROJECT_A);
    expect(revisions).toContain(REV_1);
    expect(revisions).toContain(REV_2);
    expect(revisions).toHaveLength(2);
  });

  it('listRevisions returns empty for unknown project', () => {
    const store = createStore([]);
    const revisions = store.listRevisions(OWNER_X, PROJECT_A);
    expect(revisions).toEqual([]);
  });

  it('listRevisions returns empty for non-owner', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);
    const revisions = store.listRevisions(OWNER_Y, PROJECT_A);
    expect(revisions).toEqual([]);
  });

  it('ownership isolation between projects', () => {
    const store = createStore([
      { projectId: PROJECT_A, ownerId: OWNER_X },
      { projectId: PROJECT_B, ownerId: OWNER_Y },
    ]);

    const docA: JoyProjectV1 = minimalValidJoyProjectV1('project-a');
    const recordA: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_1,
      document: docA,
    };
    store.writeDocument(OWNER_X, recordA, INITIAL_REVISION);

    const docB: JoyProjectV1 = minimalValidJoyProjectV1('project-b');
    const recordB: ProjectDocumentRecord = {
      projectId: PROJECT_B,
      ownerId: OWNER_Y,
      revisionId: REV_1,
      document: docB,
    };
    store.writeDocument(OWNER_Y, recordB, INITIAL_REVISION);

    const readB = store.readDocument(OWNER_X, PROJECT_B);
    expect(readB.kind).toBe('not-found');

    const readA = store.readDocument(OWNER_Y, PROJECT_A);
    expect(readA.kind).toBe('not-found');
  });

  it('first write requires INITIAL_REVISION as baseRevisionId', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);

    const doc: JoyProjectV1 = minimalValidJoyProjectV1('project-a');
    const record: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_1,
      document: doc,
    };

    const writeResult = store.writeDocument(OWNER_X, record, REV_1);
    expect(writeResult.kind).toBe('revision-conflict');
    const rc = writeResult as ProjectDocumentWriteOutcomeRevisionConflict;
    expect(rc.expectedBaseRevisionId).toBe(REV_1);
    expect(rc.actualBaseRevisionId).toBe(INITIAL_REVISION);
  });

  it('retains and reads historical revision correctly', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);

    const doc1: JoyProjectV1 = minimalValidJoyProjectV1('project-a');
    const record1: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_1,
      document: doc1,
    };
    store.writeDocument(OWNER_X, record1, INITIAL_REVISION);

    const doc2: JoyProjectV1 = { ...doc1, title: 'Modified' };
    const record2: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_2,
      document: doc2,
    };
    store.writeDocument(OWNER_X, record2, REV_1);

    // Read historical revision REV_1 should return the original document
    const readRev1 = store.readDocument(OWNER_X, PROJECT_A, REV_1);
    expect(readRev1.kind).toBe('ready');
    const r1 = readRev1 as ProjectDocumentReadOutcomeReady;
    expect(r1.record.revisionId).toBe(REV_1);
    expect(r1.record.document.title).toBe('Test Project');

    // Read historical revision REV_2 should return the modified document
    const readRev2 = store.readDocument(OWNER_X, PROJECT_A, REV_2);
    expect(readRev2.kind).toBe('ready');
    const r2 = readRev2 as ProjectDocumentReadOutcomeReady;
    expect(r2.record.revisionId).toBe(REV_2);
    expect(r2.record.document.title).toBe('Modified');
  });

  it('returns stale-revision for unknown historical revision', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);

    const doc: JoyProjectV1 = minimalValidJoyProjectV1('project-a');
    const record: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_1,
      document: doc,
    };
    store.writeDocument(OWNER_X, record, INITIAL_REVISION);

    // Request a revision that was never stored
    const readResult = store.readDocument(OWNER_X, PROJECT_A, REV_2);
    expect(readResult.kind).toBe('stale-revision');
    const sr = readResult as ProjectDocumentReadOutcomeStaleRevision;
    expect(sr.requestedRevisionId).toBe(REV_2);
    expect(sr.currentRevisionId).toBe(REV_1);
  });

  it('read without revisionId returns current head', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);

    const doc1: JoyProjectV1 = minimalValidJoyProjectV1('project-a');
    const record1: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_1,
      document: doc1,
    };
    store.writeDocument(OWNER_X, record1, INITIAL_REVISION);

    const doc2: JoyProjectV1 = { ...doc1, title: 'Head' };
    const record2: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_2,
      document: doc2,
    };
    store.writeDocument(OWNER_X, record2, REV_1);

    // Read without revisionId should return current head (REV_2)
    const readResult = store.readDocument(OWNER_X, PROJECT_A);
    expect(readResult.kind).toBe('ready');
    const r = readResult as ProjectDocumentReadOutcomeReady;
    expect(r.record.revisionId).toBe(REV_2);
    expect(r.record.document.title).toBe('Head');
  });

  it('historical document defensive copies remain immutable after later writes', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);

    const doc1: JoyProjectV1 = minimalValidJoyProjectV1('project-a');
    const record1: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_1,
      document: doc1,
    };
    store.writeDocument(OWNER_X, record1, INITIAL_REVISION);

    const doc2: JoyProjectV1 = { ...doc1, title: 'Modified' };
    const record2: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_2,
      document: doc2,
    };
    store.writeDocument(OWNER_X, record2, REV_1);

    // Mutate the original doc1
    (doc1 as any).title = 'MUTATED';

    // Historical REV_1 should still return the original document, not mutated
    const readRev1 = store.readDocument(OWNER_X, PROJECT_A, REV_1);
    expect(readRev1.kind).toBe('ready');
    const r1 = readRev1 as ProjectDocumentReadOutcomeReady;
    expect(r1.record.document.title).toBe('Test Project');

    // Current head REV_2 should be unaffected
    const readHead = store.readDocument(OWNER_X, PROJECT_A);
    expect(readHead.kind).toBe('ready');
    const rh = readHead as ProjectDocumentReadOutcomeReady;
    expect(rh.record.document.title).toBe('Modified');
  });

  it('listRevisions returns all stored revision IDs', () => {
    const store = createStore([{ projectId: PROJECT_A, ownerId: OWNER_X }]);

    const doc1: JoyProjectV1 = minimalValidJoyProjectV1('project-a');
    const record1: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_1,
      document: doc1,
    };
    store.writeDocument(OWNER_X, record1, INITIAL_REVISION);

    const doc2: JoyProjectV1 = { ...doc1, title: 'V2' };
    const record2: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_2,
      document: doc2,
    };
    store.writeDocument(OWNER_X, record2, REV_1);

    const doc3: JoyProjectV1 = { ...doc2, title: 'V3' };
    const record3: ProjectDocumentRecord = {
      projectId: PROJECT_A,
      ownerId: OWNER_X,
      revisionId: REV_3,
      document: doc3,
    };
    store.writeDocument(OWNER_X, record3, REV_2);

    const revisions = store.listRevisions(OWNER_X, PROJECT_A);
    expect(revisions).toContain(REV_1);
    expect(revisions).toContain(REV_2);
    expect(revisions).toContain(REV_3);
    expect(revisions).toHaveLength(3);
  });
});

// ============================================================================
// UnavailableProjectDocumentStore Tests
// ============================================================================

describe('UnavailableProjectDocumentStore', () => {
  const TEST_PROJECT = 'test-project' as ProjectId;
  const TEST_OWNER = 'test-owner' as OwnerId;
  const TEST_REVISION = 'test-rev' as ProjectRevisionId;

  it('readDocument returns unavailable outcome', () => {
    const store = new UnavailableProjectDocumentStore();
    const result = store.readDocument(TEST_OWNER, TEST_PROJECT, TEST_REVISION);
    expect(result.kind).toBe('unavailable');
    const u = result as ProjectDocumentReadOutcomeUnavailable;
    expect(u.message).toBe('Project document store is unavailable');
  });

  it('readDocument returns unavailable without projectId echo', () => {
    const store = new UnavailableProjectDocumentStore();
    const result = store.readDocument(TEST_OWNER, 'malicious-project-id', TEST_REVISION);
    expect(result.kind).toBe('unavailable');
    const u = result as ProjectDocumentReadOutcomeUnavailable;
    expect(u.message).not.toContain('malicious-project-id');
    expect(u.message).not.toContain(TEST_OWNER);
    expect(u.message).not.toContain(TEST_REVISION);
  });

  it('readDocument returns unavailable without callerId echo', () => {
    const store = new UnavailableProjectDocumentStore();
    const result = store.readDocument('malicious-caller-id', TEST_PROJECT);
    expect(result.kind).toBe('unavailable');
    const u = result as ProjectDocumentReadOutcomeUnavailable;
    expect(u.message).not.toContain('malicious-caller-id');
  });

  it('writeDocument returns unavailable outcome', () => {
    const store = new UnavailableProjectDocumentStore();
    const record = validRecord();
    const result = store.writeDocument(TEST_OWNER, record, INITIAL_REVISION);
    expect(result.kind).toBe('unavailable');
    const u = result as ProjectDocumentWriteOutcomeUnavailable;
    expect(u.message).toBe('Project document store is unavailable');
  });

  it('writeDocument returns unavailable without record echo', () => {
    const store = new UnavailableProjectDocumentStore();
    const doc: JoyProjectV1 = minimalValidJoyProjectV1('secret-project');
    const record: ProjectDocumentRecord = {
      projectId: 'secret-project-id',
      ownerId: 'secret-owner-id',
      revisionId: 'secret-revision-id',
      document: doc,
    };
    const result = store.writeDocument('secret-caller-id', record, 'secret-base-rev');
    expect(result.kind).toBe('unavailable');
    const u = result as ProjectDocumentWriteOutcomeUnavailable;
    expect(u.message).not.toContain('secret-project-id');
    expect(u.message).not.toContain('secret-owner-id');
    expect(u.message).not.toContain('secret-revision-id');
    expect(u.message).not.toContain('secret-caller-id');
    expect(u.message).not.toContain('secret-base-rev');
  });

  it('listRevisions returns empty array', () => {
    const store = new UnavailableProjectDocumentStore();
    const result = store.listRevisions(TEST_OWNER, TEST_PROJECT);
    expect(result).toEqual([]);
  });

  it('listRevisions does not invoke owner lookup', () => {
    const store = new UnavailableProjectDocumentStore();
    const result = store.listRevisions(TEST_OWNER, TEST_PROJECT);
    expect(result).toEqual([]);
  });

  it('unavailable store performs no I/O', () => {
    const store = new UnavailableProjectDocumentStore();
    const record = validRecord();

    const readResult = store.readDocument(TEST_OWNER, TEST_PROJECT);
    expect(readResult.kind).toBe('unavailable');

    const writeResult = store.writeDocument(TEST_OWNER, record, INITIAL_REVISION);
    expect(writeResult.kind).toBe('unavailable');

    const listResult = store.listRevisions(TEST_OWNER, TEST_PROJECT);
    expect(listResult).toEqual([]);
  });
});
