/**
 * Project Document Store Contract (WP-37 S4-F10-E5-A)
 *
 * API-internal contract for revisioned server-side JoyProjectV1 persistence.
 * This module defines only types and pure validation - NO I/O.
 */

import type { JoyProjectV1, ProjectDiagnostic } from '@joy-media/project-schema';
import { validateJoyProjectV1 } from '@joy-media/project-schema';
import type { ProjectRevisionId } from '@joy-media/project-schema';

// ============================================================================
// Identity and Record Types
// ============================================================================

/** Opaque project identifier. */
export type ProjectId = string;

/** Opaque owner identifier. */
export type OwnerId = string;

/**
 * A validated project document record for storage.
 * All fields are opaque strings from the caller's perspective.
 */
export interface ProjectDocumentRecord {
  readonly projectId: ProjectId;
  readonly ownerId: OwnerId;
  readonly revisionId: ProjectRevisionId;
  readonly document: JoyProjectV1;
}

// ============================================================================
// Read Outcomes (typed result discriminated union)
// ============================================================================

/** Read succeeded - document is available. */
export interface ProjectDocumentReadOutcomeReady {
  readonly kind: 'ready';
  readonly record: ProjectDocumentRecord;
}

/** Read failed - no such project/revision. */
export interface ProjectDocumentReadOutcomeNotFound {
  readonly kind: 'not-found';
  readonly projectId: ProjectId;
  readonly revisionId: ProjectRevisionId | null;
}

/** Read failed - requested revision is not current. */
export interface ProjectDocumentReadOutcomeStaleRevision {
  readonly kind: 'stale-revision';
  readonly projectId: ProjectId;
  readonly requestedRevisionId: ProjectRevisionId;
  readonly currentRevisionId: ProjectRevisionId;
}

/** All possible read outcomes. */
export type ProjectDocumentReadOutcome =
  | ProjectDocumentReadOutcomeReady
  | ProjectDocumentReadOutcomeNotFound
  | ProjectDocumentReadOutcomeStaleRevision;

// ============================================================================
// Write Outcomes (typed result discriminated union)
// ============================================================================

/** Write succeeded - document stored. */
export interface ProjectDocumentWriteOutcomeStored {
  readonly kind: 'stored';
  readonly projectId: ProjectId;
  readonly ownerId: OwnerId;
  readonly revisionId: ProjectRevisionId;
}

/** Write failed - project not found. */
export interface ProjectDocumentWriteOutcomeNotFound {
  readonly kind: 'not-found';
  readonly projectId: ProjectId;
}

/** Write failed - caller is not the owner. */
export interface ProjectDocumentWriteOutcomeOwnerDenied {
  readonly kind: 'owner-denied';
  readonly projectId: ProjectId;
  readonly ownerId: OwnerId;
  readonly callerId: OwnerId;
}

/** Write failed - base revision does not match current head. */
export interface ProjectDocumentWriteOutcomeRevisionConflict {
  readonly kind: 'revision-conflict';
  readonly projectId: ProjectId;
  readonly expectedBaseRevisionId: ProjectRevisionId;
  readonly actualBaseRevisionId: ProjectRevisionId;
}

/** Write failed - document validation failed. */
export interface ProjectDocumentWriteOutcomeInvalidDocument {
  readonly kind: 'invalid-document';
  readonly projectId: ProjectId;
  readonly diagnostics: readonly ProjectDiagnostic[];
}

/** All possible write outcomes. */
export type ProjectDocumentWriteOutcome =
  | ProjectDocumentWriteOutcomeStored
  | ProjectDocumentWriteOutcomeNotFound
  | ProjectDocumentWriteOutcomeOwnerDenied
  | ProjectDocumentWriteOutcomeRevisionConflict
  | ProjectDocumentWriteOutcomeInvalidDocument;

// ============================================================================
// Store Interface
// ============================================================================

/**
 * Pure document validator.
 * Returns diagnostics (empty array = valid).
 * Fails closed: returns non-empty diagnostics for any invalid input.
 */
export function validateProjectDocumentRecord(
  candidate: unknown,
): readonly ProjectDiagnostic[] {
  // Fail closed on non-record
  if (!isRecord(candidate)) {
    return [
      {
        code: 'PROJECT_DOCUMENT_RECORD_NOT_OBJECT',
        message: 'Project document record must be an object',
        path: '',
      },
    ];
  }

  const record = candidate as Partial<ProjectDocumentRecord>;
  const diagnostics: ProjectDiagnostic[] = [];

  // Validate projectId
  if (!isNonEmptyString(record.projectId)) {
    diagnostics.push({
      code: 'PROJECT_DOCUMENT_INVALID_PROJECT_ID',
      message: 'projectId must be a non-empty string',
      path: 'projectId',
    });
  }

  // Validate ownerId
  if (!isNonEmptyString(record.ownerId)) {
    diagnostics.push({
      code: 'PROJECT_DOCUMENT_INVALID_OWNER_ID',
      message: 'ownerId must be a non-empty string',
      path: 'ownerId',
    });
  }

  // Validate revisionId
  if (!isNonEmptyString(record.revisionId)) {
    diagnostics.push({
      code: 'PROJECT_DOCUMENT_INVALID_REVISION_ID',
      message: 'revisionId must be a non-empty string',
      path: 'revisionId',
    });
  }

  // Validate document exists and is an object
  if (record.document === undefined || record.document === null) {
    diagnostics.push({
      code: 'PROJECT_DOCUMENT_MISSING',
      message: 'document must be present',
      path: 'document',
    });
  } else {
    // Validate JoyProjectV1 structure
    const docDiagnostics = validateJoyProjectV1(record.document);
    diagnostics.push(...docDiagnostics);
  }

  return diagnostics;
}

/**
 * Type guard: is the value a valid ProjectDocumentRecord?
 * Performs runtime validation matching the interface contract.
 */
export function isValidProjectDocumentRecord(
  candidate: unknown,
): candidate is ProjectDocumentRecord {
  const diagnostics = validateProjectDocumentRecord(candidate);
  return diagnostics.length === 0;
}

/**
 * ProjectDocumentStore - API-internal contract for revisioned project document storage.
 * 
 * Implementations MUST:
 * - Enforce owner-scoped access
 * - Use compare-and-swap on write (baseRevision must match current head)
 * - Fail closed on any invalid identity/revision/document
 * - NOT use Date.now (clock must be injected by caller)
 * - Perform NO I/O in this module (pure contract only)
 */
export interface ProjectDocumentStore {
  /**
   * Read the current revision of a project document.
   * 
   * @param callerId - The caller's owner ID (for authorization in implementations)
   * @param projectId - The project to read
   * @param revisionId - Optional: specific revision to fetch. If omitted, returns current.
   * @returns Typed outcome: ready, not-found, or stale-revision
   */
  readDocument(
    callerId: OwnerId,
    projectId: ProjectId,
    revisionId?: ProjectRevisionId,
  ): ProjectDocumentReadOutcome | Promise<ProjectDocumentReadOutcome>;

  /**
   * Write a project document with compare-and-swap.
   * 
   * @param callerId - The caller's owner ID (must match record.ownerId)
   * @param record - The complete document record to store
   * @param baseRevisionId - The expected current revision; write fails if this doesn't match
   * @returns Typed outcome: stored, not-found, owner-denied, revision-conflict, or invalid-document
   */
  writeDocument(
    callerId: OwnerId,
    record: ProjectDocumentRecord,
    baseRevisionId: ProjectRevisionId,
  ): ProjectDocumentWriteOutcome | Promise<ProjectDocumentWriteOutcome>;

  /**
   * List all revision IDs for a project (for debugging/diagnostics).
   * 
   * @param callerId - The caller's owner ID
   * @param projectId - The project to list revisions for
   * @returns Array of revision IDs, or empty if not found/denied
   */
  listRevisions(
    callerId: OwnerId,
    projectId: ProjectId,
  ): readonly ProjectRevisionId[] | Promise<readonly ProjectRevisionId[]>;
}

// ============================================================================
// Helper Type Guards
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
