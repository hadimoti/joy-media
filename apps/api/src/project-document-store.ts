/**
 * Project Document Store Contract (WP-37 S4-F10-E5-A)
 *
 * API-internal contract for revisioned server-side JoyProjectV1 persistence.
 * This module defines only types and pure validation - NO I/O.
 */

import type {
  JoyProjectV1,
  LookInstancesDocument,
  ProjectDiagnostic,
} from '@joy-media/project-schema';
import { validateJoyProjectV1, validateLookInstancesDocument } from '@joy-media/project-schema';
import type { ProjectRevisionId } from '@joy-media/project-schema';

/**
 * Server-side cap on one project's Look Instances document (R2 / GAP 1a). Looks
 * are few — a handful per composition — so a small ceiling on the instance count
 * and the serialized size is a defence-in-depth guard, not a real product limit.
 */
export const MAX_LOOK_INSTANCES_PER_DOCUMENT = 128;
export const MAX_LOOK_INSTANCES_DOCUMENT_BYTES = 256 * 1024;

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
  /**
   * The canonical Look Instances document (R2 / GAP 1a). Written under the SAME
   * `revisionId` as `document` — one atomic CAS row.
   *
   * `undefined` means "this write did not carry Look info" — a legacy client, or
   * a visual-only save. The store then **copies forward** the previous
   * revision's value (omission is never deletion). An explicit
   * `{ id, schemaVersion: 1, instances: {} }` is a real value that replaces it —
   * that is how an intentional "all Looks detached" state is persisted.
   */
  readonly lookInstances?: LookInstancesDocument;
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

/** Read failed - store is unavailable. */
export interface ProjectDocumentReadOutcomeUnavailable {
  readonly kind: 'unavailable';
  readonly message: 'Project document store is unavailable';
}

/** All possible read outcomes. */
export type ProjectDocumentReadOutcome =
  | ProjectDocumentReadOutcomeReady
  | ProjectDocumentReadOutcomeNotFound
  | ProjectDocumentReadOutcomeStaleRevision
  | ProjectDocumentReadOutcomeUnavailable;

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

/** Write failed - store is unavailable. */
export interface ProjectDocumentWriteOutcomeUnavailable {
  readonly kind: 'unavailable';
  readonly message: 'Project document store is unavailable';
}

/** All possible write outcomes. */
export type ProjectDocumentWriteOutcome =
  | ProjectDocumentWriteOutcomeStored
  | ProjectDocumentWriteOutcomeNotFound
  | ProjectDocumentWriteOutcomeOwnerDenied
  | ProjectDocumentWriteOutcomeRevisionConflict
  | ProjectDocumentWriteOutcomeInvalidDocument
  | ProjectDocumentWriteOutcomeUnavailable;

// ============================================================================
// Store Interface
// ============================================================================

/**
 * Pure document validator.
 * Returns diagnostics (empty array = valid).
 * Fails closed: returns non-empty diagnostics for any invalid input.
 */
export function validateProjectDocumentRecord(candidate: unknown): readonly ProjectDiagnostic[] {
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

  // Validate the optional Look Instances document (R2 / GAP 1a). `undefined` is
  // a legacy / visual-only write and is carried forward by the store; only a
  // present value is structurally validated + capped here.
  if (record.lookInstances !== undefined) {
    diagnostics.push(...validateLookInstancesDocument(record.lookInstances, 'lookInstances'));
    const instances = isRecord(record.lookInstances)
      ? (record.lookInstances as { readonly instances?: unknown }).instances
      : undefined;
    if (isRecord(instances) && Object.keys(instances).length > MAX_LOOK_INSTANCES_PER_DOCUMENT) {
      diagnostics.push({
        code: 'PROJECT_DOCUMENT_LOOK_INSTANCES_TOO_MANY',
        message: `lookInstances.instances must not exceed ${MAX_LOOK_INSTANCES_PER_DOCUMENT} entries`,
        path: 'lookInstances.instances',
      });
    }
    if (serializedByteLength(record.lookInstances) > MAX_LOOK_INSTANCES_DOCUMENT_BYTES) {
      diagnostics.push({
        code: 'PROJECT_DOCUMENT_LOOK_INSTANCES_TOO_LARGE',
        message: `lookInstances must serialize to at most ${MAX_LOOK_INSTANCES_DOCUMENT_BYTES} bytes`,
        path: 'lookInstances',
      });
    }
  }

  return diagnostics;
}

/**
 * Binding-consistency check (R2 / GAP 1a R5), mirroring the editor's
 * `EditorSession#assertLookInstanceReferencesResolve`: a NEW or RETARGETED
 * `entityBindings` target (or a new `createdEntityIds` entry) on an instance
 * must name a visual object present in the SAME write's `document`. A binding
 * that already dangled from an earlier deletion is left alone — the editor keeps
 * such an instance as `orphaned`, and rejecting its round-trip here would break
 * cross-device sync.
 */
export function validateLookInstanceBindingsResolve(
  next: LookInstancesDocument | undefined,
  prior: LookInstancesDocument | undefined,
  document: JoyProjectV1,
): readonly ProjectDiagnostic[] {
  if (next === undefined) return [];
  const priorInstances = (prior?.instances ?? {}) as Record<
    string,
    {
      readonly entityBindings?: Record<string, string>;
      readonly createdEntityIds?: readonly string[];
    }
  >;
  const visualObjects = (document.visualObjects ?? {}) as Record<string, unknown>;
  const diagnostics: ProjectDiagnostic[] = [];
  for (const [id, rawInstance] of Object.entries(next.instances)) {
    const instance = rawInstance as {
      readonly entityBindings?: Record<string, string>;
      readonly createdEntityIds?: readonly string[];
    };
    const stored = priorInstances[id];
    if (stored !== undefined && JSON.stringify(stored) === JSON.stringify(rawInstance)) continue;
    const entityBindings = instance.entityBindings ?? {};
    const createdEntityIds = instance.createdEntityIds ?? [];
    const missing = [
      ...Object.entries(entityBindings)
        .filter(
          ([key, entityId]) => stored === undefined || stored.entityBindings?.[key] !== entityId,
        )
        .map(([, entityId]) => entityId),
      ...createdEntityIds.filter(
        (entityId) => stored === undefined || !(stored.createdEntityIds ?? []).includes(entityId),
      ),
    ].filter((entityId) => visualObjects[entityId] === undefined);
    if (missing.length > 0) {
      diagnostics.push({
        code: 'PROJECT_DOCUMENT_LOOK_INSTANCE_DANGLING',
        message: `lookInstances instance "${id}" references visual object(s) absent from this write's document: ${[
          ...new Set(missing),
        ].join(', ')}`,
        path: `lookInstances.instances.${id}`,
      });
    }
  }
  return diagnostics;
}

function serializedByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
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
// In-Memory Implementation
// ============================================================================

/**
 * Sentinel revision ID indicating no previous document exists for a project.
 * First write to a project MUST use this as the baseRevisionId.
 */
export const INITIAL_REVISION: ProjectRevisionId = '';

/**
 * Project-owner lookup function type.
 * Returns the ownerId for a given projectId, or undefined if the project doesn't exist.
 * This is injected to avoid direct ControlPlane access.
 */
export type ProjectOwnerLookup = (projectId: ProjectId) => OwnerId | undefined;

/**
 * Internal stored document with all revision metadata.
 * Uses defensive copies to prevent caller mutation.
 */
interface StoredDocument {
  readonly ownerId: OwnerId;
  readonly revisionId: ProjectRevisionId;
  readonly document: JoyProjectV1;
  /** Present once any revision has carried Look info; carried forward otherwise. */
  readonly lookInstances?: LookInstancesDocument;
}

/**
 * In-memory project document store implementation.
 *
 * Guarantees:
 * - Owner-scoped access
 * - Compare-and-swap writes
 * - First write requires baseRevisionId === INITIAL_REVISION
 * - Subsequent writes require baseRevisionId === current head
 * - Invalid documents rejected without mutation
 * - Defensive copies on all read/write operations
 * - Retains immutable historical revisions for each project
 * - NO I/O: no clock, filesystem, database, network, environment, or secret access
 */
export class InMemoryProjectDocumentStore implements ProjectDocumentStore {
  private readonly documents: Map<ProjectId, Map<ProjectRevisionId, StoredDocument>> = new Map();
  private readonly currentHead: Map<ProjectId, ProjectRevisionId> = new Map();

  constructor(private readonly lookupOwner: ProjectOwnerLookup) {}

  private recordFromStored(
    projectId: ProjectId,
    ownerId: OwnerId,
    stored: StoredDocument,
  ): ProjectDocumentRecord {
    return {
      projectId,
      ownerId,
      revisionId: stored.revisionId,
      document: this.deepCopy(stored.document),
      ...(stored.lookInstances === undefined
        ? {}
        : { lookInstances: this.deepCopy(stored.lookInstances) }),
    };
  }

  readDocument(
    callerId: OwnerId,
    projectId: ProjectId,
    revisionId?: ProjectRevisionId,
  ): ProjectDocumentReadOutcome {
    // Check if project exists
    const ownerId = this.lookupOwner(projectId);
    if (ownerId === undefined) {
      return {
        kind: 'not-found',
        projectId,
        revisionId: revisionId ?? null,
      };
    }

    // Check ownership
    if (ownerId !== callerId) {
      return {
        kind: 'not-found',
        projectId,
        revisionId: revisionId ?? null,
      };
    }

    // Get the document map for this project
    const docMap = this.documents.get(projectId);
    if (docMap === undefined || docMap.size === 0) {
      return {
        kind: 'not-found',
        projectId,
        revisionId: revisionId ?? null,
      };
    }

    const currentHeadRev = this.currentHead.get(projectId);

    // If specific revision requested
    if (revisionId !== undefined) {
      const stored = docMap.get(revisionId);
      if (stored !== undefined) {
        // Found the historical revision - return it
        return {
          kind: 'ready',
          record: this.recordFromStored(projectId, ownerId, stored),
        };
      } else {
        // Revision doesn't exist - return stale with current head info
        if (currentHeadRev !== undefined) {
          return {
            kind: 'stale-revision',
            projectId,
            requestedRevisionId: revisionId,
            currentRevisionId: currentHeadRev,
          };
        } else {
          // No current head but revision requested - shouldn't happen but safe
          return {
            kind: 'not-found',
            projectId,
            revisionId,
          };
        }
      }
    }

    // No specific revision requested - return current head
    if (currentHeadRev !== undefined) {
      const stored = docMap.get(currentHeadRev);
      if (stored !== undefined) {
        return {
          kind: 'ready',
          record: this.recordFromStored(projectId, ownerId, stored),
        };
      }
    }

    // Fallback: no current head stored
    return {
      kind: 'not-found',
      projectId,
      revisionId: null,
    };
  }

  writeDocument(
    callerId: OwnerId,
    record: ProjectDocumentRecord,
    baseRevisionId: ProjectRevisionId,
  ): ProjectDocumentWriteOutcome {
    // Validate the record first
    const diagnostics = validateProjectDocumentRecord(record);
    if (diagnostics.length > 0) {
      return {
        kind: 'invalid-document',
        projectId: record.projectId,
        diagnostics,
      };
    }

    // Check if project exists
    const ownerId = this.lookupOwner(record.projectId);
    if (ownerId === undefined) {
      return {
        kind: 'not-found',
        projectId: record.projectId,
      };
    }

    // Check ownership
    if (ownerId !== callerId) {
      return {
        kind: 'owner-denied',
        projectId: record.projectId,
        ownerId,
        callerId,
      };
    }

    // Check that record.ownerId matches the project owner
    if (record.ownerId !== ownerId) {
      return {
        kind: 'owner-denied',
        projectId: record.projectId,
        ownerId,
        callerId,
      };
    }

    // Get current head for CAS check
    const currentHeadRev = this.currentHead.get(record.projectId) ?? INITIAL_REVISION;

    // CAS: baseRevisionId must match current head
    if (baseRevisionId !== currentHeadRev) {
      return {
        kind: 'revision-conflict',
        projectId: record.projectId,
        expectedBaseRevisionId: baseRevisionId,
        actualBaseRevisionId: currentHeadRev,
      };
    }

    // Get or create the document map for this project
    let docMap = this.documents.get(record.projectId);
    if (docMap === undefined) {
      docMap = new Map();
      this.documents.set(record.projectId, docMap);
    }

    // Look Instances (R2 / GAP 1a): an absent value carries forward the previous
    // revision's document (omission is never deletion); an explicit value —
    // including `{ instances: {} }` — replaces it.
    const priorHead = docMap.get(this.currentHead.get(record.projectId) ?? INITIAL_REVISION);
    const nextLookInstances =
      record.lookInstances !== undefined ? record.lookInstances : priorHead?.lookInstances;

    const bindingDiagnostics = validateLookInstanceBindingsResolve(
      record.lookInstances,
      priorHead?.lookInstances,
      record.document,
    );
    if (bindingDiagnostics.length > 0) {
      return {
        kind: 'invalid-document',
        projectId: record.projectId,
        diagnostics: bindingDiagnostics,
      };
    }

    // Store defensive copy of the new document
    const stored: StoredDocument = {
      ownerId,
      revisionId: record.revisionId,
      document: this.deepCopy(record.document),
      ...(nextLookInstances === undefined
        ? {}
        : { lookInstances: this.deepCopy(nextLookInstances) }),
    };
    docMap.set(record.revisionId, stored);

    // Update current head to the new revision
    this.currentHead.set(record.projectId, record.revisionId);

    return {
      kind: 'stored',
      projectId: record.projectId,
      ownerId: record.ownerId,
      revisionId: record.revisionId,
    };
  }

  listRevisions(callerId: OwnerId, projectId: ProjectId): readonly ProjectRevisionId[] {
    // Check if project exists
    const ownerId = this.lookupOwner(projectId);
    if (ownerId === undefined) {
      return [];
    }

    // Check ownership
    if (ownerId !== callerId) {
      return [];
    }

    const docMap = this.documents.get(projectId);
    if (docMap === undefined || docMap.size === 0) {
      return [];
    }

    return Array.from(docMap.keys());
  }

  /**
   * Create a defensive deep copy of a JoyProjectV1 document.
   * Prevents caller mutation from affecting stored canonical bytes.
   */
  private deepCopy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }
}

// ============================================================================
// Unavailable Implementation
// ============================================================================

/**
 * Unavailable project document store implementation.
 *
 * Guarantees:
 * - Every read/write returns typed 'unavailable' outcome
 * - No owner lookup, validation, storage mutation, I/O, logging, clock access, or secret access
 * - Public errors/messages are fixed and redacted (no project IDs, owner IDs, revision IDs, or document content)
 */
export class UnavailableProjectDocumentStore implements ProjectDocumentStore {
  readDocument(
    _callerId: OwnerId,
    _projectId: ProjectId,
    _revisionId?: ProjectRevisionId,
  ): ProjectDocumentReadOutcome {
    return {
      kind: 'unavailable',
      message: 'Project document store is unavailable',
    };
  }

  writeDocument(
    _callerId: OwnerId,
    _record: ProjectDocumentRecord,
    _baseRevisionId: ProjectRevisionId,
  ): ProjectDocumentWriteOutcome {
    return {
      kind: 'unavailable',
      message: 'Project document store is unavailable',
    };
  }

  listRevisions(_callerId: OwnerId, _projectId: ProjectId): readonly ProjectRevisionId[] {
    return [];
  }
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
