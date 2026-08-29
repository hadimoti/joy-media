import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { JoyProjectV1, ProjectRevisionId } from '@joy-media/project-schema';
import {
  type ControlPlaneProjectBinding,
  getControlPlaneProjectBinding,
  upsertControlPlaneProjectBinding,
} from './project-control-plane.js';

/**
 * Result type for a successful document sync operation.
 */
export interface DocumentSyncSuccess {
  readonly kind: 'success';
  readonly projectId: string;
  readonly revisionId: ProjectRevisionId;
}

/**
 * Result type indicating a CAS revision conflict (HTTP 409 DOCUMENT_REVISION_CONFLICT).
 * Local binding state is NOT advanced.
 */
export interface DocumentSyncConflict {
  readonly kind: 'conflict';
  readonly message: string;
}

/**
 * Result type for any other request failure. The underlying error is propagated unchanged.
 */
export interface DocumentSyncRequestFailure {
  readonly kind: 'request-failure';
  readonly error: unknown;
}

/** Union of all possible sync outcomes. */
export type DocumentSyncResult =
  DocumentSyncSuccess | DocumentSyncConflict | DocumentSyncRequestFailure;

/**
 * Injected sync transport. Matches the control-plane client method signature.
 */
export type SyncProjectDocument = (
  projectId: string,
  params: {
    readonly baseRevisionId: ProjectRevisionId;
    readonly revisionId: ProjectRevisionId;
    readonly document: JoyProjectV1;
  },
) => Promise<{ readonly projectId: string; readonly revisionId: ProjectRevisionId }>;

/**
 * Options for the document sync coordinator.
 */
export interface DocumentSyncOptions {
  /** Owner key for the binding (default: 'local'). */
  readonly ownerKey?: string;
}

const DOCUMENT_REVISION_CONFLICT = 'DOCUMENT_REVISION_CONFLICT';
const inFlightDocumentSyncs = new Map<string, Promise<DocumentSyncResult>>();

function isDocumentRevisionConflictError(error: unknown): error is {
  readonly status: 409;
  readonly code: typeof DOCUMENT_REVISION_CONFLICT;
  readonly message: string;
} {
  return (
    error !== null &&
    typeof error === 'object' &&
    'status' in error &&
    error.status === 409 &&
    'code' in error &&
    error.code === DOCUMENT_REVISION_CONFLICT &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

/**
 * Coordinates canonical document sync between the browser-local JoyProjectV1
 * and the server's CAS storage, using the control-plane binding and an
 * injected sync transport.
 *
 * This is a narrow coordinator: it does NOT mount in the UI, auto-sync,
 * modify API contracts, or change server code.
 */
export function syncProjectDocumentBinding(
  binding: ControlPlaneProjectBinding,
  document: JoyProjectV1,
  revisionId: ProjectRevisionId,
  storage: BrowserKeyValueStore,
  syncProjectDocument: SyncProjectDocument,
  options: DocumentSyncOptions = {},
): Promise<DocumentSyncResult> {
  const ownerKey = options.ownerKey ?? 'local';
  const queueKey = `${ownerKey}:${binding.editorProjectId}`;

  const previous = inFlightDocumentSyncs.get(queueKey);
  const run = () =>
    performProjectDocumentSync(
      binding,
      document,
      revisionId,
      storage,
      syncProjectDocument,
      ownerKey,
    );
  // Start the first request synchronously so callers can observe immediate
  // transport invocation; only later requests wait behind the current CAS
  // write. This preserves ordering without adding a microtask delay to the
  // common path.
  const queued = previous === undefined ? run() : previous.catch(() => undefined).then(run);
  inFlightDocumentSyncs.set(queueKey, queued);
  return queued.finally(() => {
    if (inFlightDocumentSyncs.get(queueKey) === queued) inFlightDocumentSyncs.delete(queueKey);
  });
}

function performProjectDocumentSync(
  binding: ControlPlaneProjectBinding,
  document: JoyProjectV1,
  revisionId: ProjectRevisionId,
  storage: BrowserKeyValueStore,
  syncProjectDocument: SyncProjectDocument,
  ownerKey: string,
): Promise<DocumentSyncResult> {
  const latestBinding =
    getControlPlaneProjectBinding(storage, binding.editorProjectId, ownerKey) ?? binding;

  // Fail closed: if document and binding IDs don't match, do NOT make a network call.
  if (document.id !== latestBinding.editorProjectId) {
    return Promise.resolve({
      kind: 'request-failure',
      error: new Error(
        `Document id (${document.id}) does not match binding editorProjectId (${latestBinding.editorProjectId})`,
      ),
    });
  }

  // Repeating a request for the same immutable revision is a safe no-op.
  // This matters after a client disconnects after the server committed the
  // document but before the Creative Brief response was received.
  if (latestBinding.documentRevisionId === revisionId) {
    return Promise.resolve({
      kind: 'success',
      projectId: latestBinding.controlPlaneProjectId,
      revisionId,
    });
  }

  const baseRevisionId: ProjectRevisionId = latestBinding.documentRevisionId ?? '';

  return syncProjectDocument(latestBinding.controlPlaneProjectId, {
    baseRevisionId,
    revisionId,
    document,
  })
    .then((response) => {
      // Only persist if the response matches both the binding's control-plane
      // project ID and the requested revision.
      if (
        response.projectId !== latestBinding.controlPlaneProjectId ||
        response.revisionId !== revisionId
      ) {
        return {
          kind: 'request-failure' as const,
          error: new Error(
            `Sync response mismatch: expected projectId=${latestBinding.controlPlaneProjectId}, revisionId=${revisionId}; got projectId=${response.projectId}, revisionId=${response.revisionId}`,
          ),
        } satisfies DocumentSyncRequestFailure;
      }

      // Persist the updated binding with the new document revision ID.
      const updatedBinding: ControlPlaneProjectBinding = {
        ...latestBinding,
        documentRevisionId: revisionId,
      };
      upsertControlPlaneProjectBinding(storage, updatedBinding, ownerKey);

      return {
        kind: 'success' as const,
        projectId: response.projectId,
        revisionId: response.revisionId,
      } satisfies DocumentSyncSuccess;
    })
    .catch((error: unknown) => {
      // Convert only 409 DOCUMENT_REVISION_CONFLICT into a typed conflict.
      if (isDocumentRevisionConflictError(error)) {
        return {
          kind: 'conflict' as const,
          message: error.message,
        } satisfies DocumentSyncConflict;
      }

      // Propagate all other request failures unchanged.
      return {
        kind: 'request-failure' as const,
        error,
      } satisfies DocumentSyncRequestFailure;
    });
}
