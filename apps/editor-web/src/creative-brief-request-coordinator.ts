import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { JoyProjectV1, ProjectRevisionId } from '@joy-media/project-schema';
import type { CreativeBriefRequestV1, CreativeBriefV1 } from '@joy-media/agent-tools';
import type { ControlPlaneProjectBinding } from './project-control-plane.js';
import { syncProjectDocumentBinding, type DocumentSyncResult } from './project-document-sync.js';
import type { SyncProjectDocument } from './project-document-sync.js';

/**
 * Result type for a successful sync-then-brief coordination.
 */
export interface CreativeBriefCoordinationSuccess {
  readonly kind: 'success';
  readonly syncResult: DocumentSyncResult;
  readonly brief: CreativeBriefV1;
}

/**
 * Result type indicating request parity check failure.
 * No network calls are made when this occurs.
 */
export interface CreativeBriefCoordinationParityFailure {
  readonly kind: 'parity-failure';
  readonly reason: 'projectId-mismatch' | 'snapshotRevisionId-mismatch';
  readonly expectedProjectId: string;
  readonly actualProjectId: string;
  readonly expectedSnapshotRevisionId: ProjectRevisionId;
  readonly actualSnapshotRevisionId: ProjectRevisionId;
}

/**
 * Result type indicating sync conflict (stale document).
 * The brief transport is NOT called.
 */
export interface CreativeBriefCoordinationStale {
  readonly kind: 'stale';
  readonly syncConflict: DocumentSyncResult;
}

/**
 * Result type for sync failures.
 * The brief transport is NOT called.
 */
export interface CreativeBriefCoordinationSyncFailure {
  readonly kind: 'sync-failure';
  readonly syncResult: DocumentSyncResult;
}

/**
 * Result type for brief transport failures after successful sync.
 * The sync succeeded but the brief request failed.
 */
export interface CreativeBriefCoordinationBriefFailure {
  readonly kind: 'brief-failure';
  readonly syncResult: DocumentSyncResult;
  readonly error: unknown;
}

/** Union of all possible coordination outcomes. */
export type CreativeBriefCoordinationResult =
  | CreativeBriefCoordinationSuccess
  | CreativeBriefCoordinationParityFailure
  | CreativeBriefCoordinationStale
  | CreativeBriefCoordinationSyncFailure
  | CreativeBriefCoordinationBriefFailure;

/**
 * Injected Creative Brief client transport.
 * Matches the control-plane client method signature.
 */
export type CreativeBriefTransport = (
  controlPlaneProjectId: string,
  request: CreativeBriefRequestV1,
) => Promise<CreativeBriefV1>;

/**
 * Options for the creative brief request coordinator.
 */
export interface CreativeBriefCoordinationOptions {
  /** Owner key for the binding (default: 'local'). */
  readonly ownerKey?: string;
}

/**
 * Coordinates sync-then-request-Creative-Brief with narrow injected transports.
 *
 * 1. Synchronizes the canonical JoyProjectV1 using `syncProjectDocumentBinding`.
 * 2. Only after successful sync, calls the injected Creative Brief client transport.
 *
 * Requires request parity before any network work:
 * - `request.projectId === document.id`
 * - `request.snapshotRevisionId === supplied ProjectRevisionId`
 * Fails closed if either differs.
 *
 * Calls the brief transport with:
 * - opaque control-plane project ID from the binding as the path target
 * - the original canonical CreativeBriefRequestV1 unchanged
 *
 * Maps sync conflict to a typed stale result and does not call the brief transport.
 * Keeps other sync/brief failures typed and preserves their original error object.
 *
 * This is a pure coordinator: it does NOT mount UI, auto-sync, modify API contracts,
 * or change server code.
 */
export function coordinateCreativeBriefRequest(
  binding: ControlPlaneProjectBinding,
  document: JoyProjectV1,
  revisionId: ProjectRevisionId,
  request: CreativeBriefRequestV1,
  storage: BrowserKeyValueStore,
  syncProjectDocument: SyncProjectDocument,
  creativeBriefTransport: CreativeBriefTransport,
  options: CreativeBriefCoordinationOptions = {},
): Promise<CreativeBriefCoordinationResult> {
  // Require request parity before any network work
  if (request.projectId !== document.id) {
    return Promise.resolve({
      kind: 'parity-failure',
      reason: 'projectId-mismatch',
      expectedProjectId: document.id,
      actualProjectId: request.projectId,
      expectedSnapshotRevisionId: revisionId,
      actualSnapshotRevisionId: request.snapshotRevisionId,
    } satisfies CreativeBriefCoordinationParityFailure);
  }

  if (request.snapshotRevisionId !== revisionId) {
    return Promise.resolve({
      kind: 'parity-failure',
      reason: 'snapshotRevisionId-mismatch',
      expectedProjectId: document.id,
      actualProjectId: request.projectId,
      expectedSnapshotRevisionId: revisionId,
      actualSnapshotRevisionId: request.snapshotRevisionId,
    } satisfies CreativeBriefCoordinationParityFailure);
  }

  const ownerKey = options.ownerKey ?? 'local';

  // Synchronize the document first
  return syncProjectDocumentBinding(
    binding,
    document,
    revisionId,
    storage,
    syncProjectDocument,
    { ownerKey },
  ).then((syncResult: DocumentSyncResult) => {
    // Map sync conflict to typed stale result - do NOT call brief transport
    if (syncResult.kind === 'conflict') {
      return {
        kind: 'stale',
        syncConflict: syncResult,
      } satisfies CreativeBriefCoordinationStale;
    }

    // Map sync request-failure to typed sync-failure - do NOT call brief transport
    if (syncResult.kind === 'request-failure') {
      return {
        kind: 'sync-failure',
        syncResult,
      } satisfies CreativeBriefCoordinationSyncFailure;
    }

    // Only after successful sync, call the brief transport
    return creativeBriefTransport(binding.controlPlaneProjectId, request)
      .then((brief: CreativeBriefV1) => {
        return {
          kind: 'success',
          syncResult,
          brief,
        } satisfies CreativeBriefCoordinationSuccess;
      })
      .catch((error: unknown) => {
        return {
          kind: 'brief-failure',
          syncResult,
          error,
        } satisfies CreativeBriefCoordinationBriefFailure;
      });
  });
}
