/**
 * Project Document Sync Request Validation - WP-37 S4 Phase 5-A
 *
 * Strict browser-to-server write envelope validation for project document sync.
 * Validates envelope structure, revision CAS constraints, payload size, and
 * JoyProjectV1 document validity. Forbids projectId, owner, and any server-only fields.
 */

import type { JoyProjectV1, ProjectDiagnostic } from '@joy-media/project-schema';
import { validateJoyProjectV1 } from '@joy-media/project-schema';
import type { ProjectRevisionId, ProjectId } from '@joy-media/project-schema';

// ============================================================================
// Constants
// ============================================================================

/** Maximum serialized JSON payload size in bytes (10 MiB). */
export const MAX_PROJECT_DOCUMENT_SYNC_BYTES = 10 * 1024 * 1024;

/** Sentinel revision ID indicating no previous document exists for a project. */
export const INITIAL_REVISION: ProjectRevisionId = '';

// ============================================================================
// Error Types
// ============================================================================

/** Typed error categories for project document sync request validation. */
export type ProjectDocumentSyncValidationErrorCode =
  | 'invalid-request'
  | 'forbidden-field'
  | 'missing-field'
  | 'project-mismatch'
  | 'revision-mismatch'
  | 'payload-too-large'
  | 'invalid-document';

export interface ProjectDocumentSyncValidationError {
  readonly code: ProjectDocumentSyncValidationErrorCode;
  readonly message: string;
  readonly path?: string;
}

export interface ProjectDocumentSyncValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ProjectDocumentSyncValidationError[];
}

// ============================================================================
// Envelope Types
// ============================================================================

/**
 * Strict browser-to-server write envelope for project document sync.
 * Contains only: baseRevisionId, revisionId, document
 * Project ID comes from URL path, owner from server auth - neither in envelope.
 */
export interface ProjectDocumentSyncEnvelope {
  /**
   * The base revision ID for compare-and-swap.
   * Must be INITIAL_REVISION ('') for first write.
   */
  readonly baseRevisionId: ProjectRevisionId;
  
  /**
   * The new revision ID to store.
   * Must be a non-empty string.
   */
  readonly revisionId: ProjectRevisionId;
  
  /**
   * The JoyProjectV1 document to store.
   * Must pass validateJoyProjectV1 and have document.id === expectedProjectId.
   */
  readonly document: JoyProjectV1;
}

// ============================================================================
// Forbidden Field Names
// ============================================================================

/**
 * Fields that must never appear in the sync envelope.
 * These are server-only concerns determined from URL path and auth.
 */
const FORBIDDEN_TOP_LEVEL_FIELDS = new Set([
  'projectId',
  'ownerId',
  'owner',
  'userId',
  'user',
  'auth',
  'authentication',
  'token',
  'apiKey',
  'secret',
  'password',
  'credential',
  'command',
  'action',
  'execute',
  'apply',
  'run',
  'job',
  'approval',
  'plan',
  'step',
  'write',
  'mutate',
  'update',
  'delete',
  'create',
  'persist',
  'cache',
  'provider',
  'model',
  'adapter',
]);

/**
 * Allowed top-level fields in the sync envelope - must be exactly these.
 */
const ALLOWED_TOP_LEVEL_FIELDS = new Set([
  'baseRevisionId',
  'revisionId',
  'document',
]);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Estimate the size of a JSON-serializable object in bytes.
 */
function estimateJsonSize(obj: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(obj), 'utf8');
  } catch {
    return Infinity;
  }
}

/**
 * Check for forbidden top-level field names.
 */
function checkForbiddenFields(obj: Record<string, unknown>): string[] {
  const forbidden: string[] = [];
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_TOP_LEVEL_FIELDS.has(key)) {
      forbidden.push(key);
    }
  }
  return forbidden;
}

/**
 * Check for unknown top-level field names.
 */
function checkUnknownFields(obj: Record<string, unknown>): string[] {
  const unknown: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(key)) {
      unknown.push(key);
    }
  }
  return unknown;
}

// ============================================================================
// Main Validation Function
// ============================================================================

/**
 * Validate a browser-to-server project document sync request envelope.
 *
 * Checks:
 * - Input is a non-null object
 * - Exact top-level fields (baseRevisionId, revisionId, document) - no more, no less
 * - No forbidden field names (projectId, ownerId, server-only fields)
 * - baseRevisionId is either INITIAL_REVISION ('') or a non-empty string
 * - revisionId is a non-empty string
 * - document is a valid JoyProjectV1 (via validateJoyProjectV1)
 * - document.id matches the expected projectId from URL path
 * - Total serialized payload size <= 10 MiB
 * - Input is not mutated
 *
 * @param envelope - The raw request envelope from the browser
 * @param expectedProjectId - The projectId extracted from the URL path
 * @returns Validation result with typed errors if any
 */
export function validateProjectDocumentSyncRequest(
  envelope: unknown,
  expectedProjectId: ProjectId,
): ProjectDocumentSyncValidationResult {
  const errors: ProjectDocumentSyncValidationError[] = [];

  // Must be a non-null object
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return {
      valid: false,
      errors: [{
        code: 'invalid-request',
        message: 'Request envelope must be a non-null object',
      }],
    };
  }

  const env = envelope as Record<string, unknown>;

  // Check for forbidden top-level fields
  const forbiddenFields = checkForbiddenFields(env);
  if (forbiddenFields.length > 0) {
    errors.push({
      code: 'forbidden-field',
      message: `Request envelope contains forbidden fields: ${forbiddenFields.join(', ')}`,
    });
  }

  // Check for unknown top-level fields (strict: must be exactly the allowed fields)
  const unknownFields = checkUnknownFields(env);
  if (unknownFields.length > 0) {
    errors.push({
      code: 'invalid-request',
      message: `Request envelope contains unknown fields: ${unknownFields.join(', ')}`,
    });
  }

  // Check for missing required fields
  const missingFields: string[] = [];
  for (const field of ALLOWED_TOP_LEVEL_FIELDS) {
    if (!(field in env)) {
      missingFields.push(field);
    }
  }
  if (missingFields.length > 0) {
    errors.push({
      code: 'missing-field',
      message: `Request envelope is missing required fields: ${missingFields.join(', ')}`,
    });
  }

  // If we have structural errors (forbidden, unknown, or missing fields), return early
  if (errors.length > 0) {
    return { valid: false, errors: Object.freeze(errors.slice()) };
  }

  // At this point we know the envelope has exactly the right fields
  // Now validate each field's value

  // Validate baseRevisionId
  const baseRevisionId = env.baseRevisionId as unknown;
  if (typeof baseRevisionId !== 'string') {
    errors.push({
      code: 'invalid-request',
      message: 'baseRevisionId must be a string',
      path: 'baseRevisionId',
    });
  } else if (baseRevisionId !== INITIAL_REVISION && baseRevisionId.length === 0) {
    errors.push({
      code: 'revision-mismatch',
      message: 'baseRevisionId must be either INITIAL_REVISION (empty string) or a non-empty string',
      path: 'baseRevisionId',
    });
  }

  // Validate revisionId
  const revisionId = env.revisionId as unknown;
  if (typeof revisionId !== 'string') {
    errors.push({
      code: 'invalid-request',
      message: 'revisionId must be a string',
      path: 'revisionId',
    });
  } else if (revisionId.length === 0) {
    errors.push({
      code: 'revision-mismatch',
      message: 'revisionId must be a non-empty string',
      path: 'revisionId',
    });
  }

  // Validate document exists
  const document = env.document as unknown;
  if (document === undefined || document === null) {
    errors.push({
      code: 'invalid-request',
      message: 'document is required',
      path: 'document',
    });
  } else if (typeof document !== 'object' || Array.isArray(document)) {
    errors.push({
      code: 'invalid-request',
      message: 'document must be a non-null object',
      path: 'document',
    });
  } else {
    const doc = document as JoyProjectV1;

    // Check document.id exists and is a string first (before full validation)
    if (typeof doc.id !== 'string') {
      errors.push({
        code: 'invalid-document',
        message: 'document.id must be a string',
        path: 'document.id',
      });
    } else {
      // Check document.id matches expected projectId
      if (doc.id !== expectedProjectId) {
        errors.push({
          code: 'project-mismatch',
          message: `document.id (${doc.id}) does not match expected projectId (${expectedProjectId})`,
          path: 'document.id',
        });
      }
    }

    // Check document is valid JoyProjectV1
    const diagnostics: ProjectDiagnostic[] = validateJoyProjectV1(doc);
    if (diagnostics.length > 0) {
      errors.push({
        code: 'invalid-document',
        message: `document is not a valid JoyProjectV1: ${diagnostics.length} diagnostic(s)`,
        path: 'document',
      });
    }

    // Check payload size
    const size = estimateJsonSize(envelope);
    if (size > MAX_PROJECT_DOCUMENT_SYNC_BYTES) {
      errors.push({
        code: 'payload-too-large',
        message: `Request payload must be <= ${MAX_PROJECT_DOCUMENT_SYNC_BYTES} bytes, estimated ${size}`,
      });
    }
  }

  const valid = errors.length === 0;
  return { valid, errors: Object.freeze(errors.slice()) };
}

// ============================================================================
// Type Guard
// ============================================================================

/**
 * Type guard that checks if a value is a valid ProjectDocumentSyncEnvelope
 * for the given expected projectId.
 */
export function isValidProjectDocumentSyncEnvelope(
  envelope: unknown,
  expectedProjectId: ProjectId,
): envelope is ProjectDocumentSyncEnvelope {
  return validateProjectDocumentSyncRequest(envelope, expectedProjectId).valid;
}
