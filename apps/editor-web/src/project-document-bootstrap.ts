import type { ProjectDocumentV2 } from '@joy-media/project-schema';
import {
  type BrowserProjectDocumentSnapshot,
  type BrowserProjectRevision,
} from './control-plane-client.js';
import {
  classifyProjectDocumentSyncFailure,
  type ProjectDocumentSyncFailure,
} from './project-document-sync-diagnostics.js';
import { BrowserControlPlaneError } from './control-plane-errors.js';

export {
  classifyProjectDocumentSyncFailure,
  type ProjectDocumentSyncFailure,
} from './project-document-sync-diagnostics.js';

export interface ProjectDocumentBootstrapRemote {
  ensureProject(id: string, title: string): Promise<unknown>;
  projectDocument(id: string): Promise<BrowserProjectDocumentSnapshot>;
  appendProjectRevision(
    id: string,
    input: {
      readonly baseRevision: number;
      readonly idempotencyKey: string;
      readonly document: ProjectDocumentV2;
      readonly label?: string;
    },
  ): Promise<BrowserProjectRevision>;
}

/** Safe, coarse categories used for user-facing bootstrap diagnostics. */
export type ProjectDocumentBootstrapFailureReason = ProjectDocumentSyncFailure['reason'];

export type ProjectDocumentBootstrapFailure = ProjectDocumentSyncFailure;

export type ProjectDocumentBootstrapResult =
  | { readonly kind: 'ready'; readonly snapshot: BrowserProjectDocumentSnapshot }
  | ({ readonly kind: 'unavailable'; readonly error: unknown } & ProjectDocumentBootstrapFailure);

/**
 * Load the authenticated V2 document, bootstrapping only a genuinely fresh
 * project. The local document must come from ProjectDocumentSpine.projectDocument.
 */
export async function bootstrapProjectDocument(options: {
  readonly projectId: string;
  readonly title: string;
  readonly remote: ProjectDocumentBootstrapRemote;
  readonly projectDocument: () => ProjectDocumentV2;
  readonly idempotencyKey?: string;
  readonly label?: string;
}): Promise<ProjectDocumentBootstrapResult> {
  try {
    await options.remote.ensureProject(options.projectId, options.title);
    try {
      return {
        kind: 'ready',
        snapshot: await options.remote.projectDocument(options.projectId),
      };
    } catch (error) {
      if (!isCode(error, 'DOCUMENT_NOT_FOUND')) return unavailable(error);
      // The control-plane record id is distinct from the browser's creative
      // project id. The transport envelope must use the route id, while the
      // nested editor domains remain free to retain their local identity.
      const document = { ...options.projectDocument(), projectId: options.projectId };
      try {
        const revision = await options.remote.appendProjectRevision(options.projectId, {
          baseRevision: 0,
          idempotencyKey:
            options.idempotencyKey ?? `project-document-v2-bootstrap:${options.projectId}`,
          document,
          label: options.label ?? 'Initial project document',
        });
        return { kind: 'ready', snapshot: snapshotFromRevision(revision) };
      } catch (seedError) {
        if (isCode(seedError, 'REVISION_CONFLICT')) {
          try {
            return {
              kind: 'ready',
              snapshot: await options.remote.projectDocument(options.projectId),
            };
          } catch (refetchError) {
            return unavailable(refetchError);
          }
        }
        return unavailable(seedError);
      }
    }
  } catch (error) {
    return unavailable(error);
  }
}

function unavailable(error: unknown): ProjectDocumentBootstrapResult {
  return { kind: 'unavailable', error, ...classifyBootstrapFailure(error) };
}

export function classifyBootstrapFailure(error: unknown): ProjectDocumentBootstrapFailure {
  return classifyProjectDocumentSyncFailure(error);
}

function snapshotFromRevision(revision: BrowserProjectRevision): BrowserProjectDocumentSnapshot {
  return {
    projectId: revision.projectId,
    revision: revision.revision,
    document: revision.document,
    documentHash: revision.documentHash,
    updatedAt: revision.createdAt,
  };
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof BrowserControlPlaneError
    ? error.code === code
    : typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code === code
      : false;
}
