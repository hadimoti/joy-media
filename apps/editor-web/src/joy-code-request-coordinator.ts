import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { JoyProjectV1, ProjectRevisionId } from '@joy-media/project-schema';
import type { JoyCodePlanProposalV1 } from '@joy-media/agent-tools';
import type { BrowserJoyCodePlanRequest } from './control-plane-client.js';
import type { ControlPlaneProjectBinding } from './project-control-plane.js';
import { syncProjectDocumentBinding, type DocumentSyncResult, type SyncProjectDocument } from './project-document-sync.js';

export type JoyCodePlanTransport = (controlPlaneProjectId: string, request: BrowserJoyCodePlanRequest, signal?: AbortSignal) => Promise<JoyCodePlanProposalV1>;
export type JoyCodeCoordinationResult =
  | { readonly kind: 'success'; readonly syncResult: DocumentSyncResult; readonly proposal: JoyCodePlanProposalV1 }
  | { readonly kind: 'parity-failure'; readonly reason: 'projectId-mismatch' | 'snapshotRevisionId-mismatch' }
  | { readonly kind: 'stale'; readonly syncConflict: DocumentSyncResult }
  | { readonly kind: 'sync-failure'; readonly syncResult: DocumentSyncResult }
  | { readonly kind: 'plan-failure'; readonly syncResult: DocumentSyncResult; readonly error: unknown };

export function coordinateJoyCodePlan(
  binding: ControlPlaneProjectBinding,
  document: JoyProjectV1,
  revisionId: ProjectRevisionId,
  request: BrowserJoyCodePlanRequest,
  storage: BrowserKeyValueStore,
  syncProjectDocument: SyncProjectDocument,
  joyCodeTransport: JoyCodePlanTransport,
  options: { readonly ownerKey?: string } = {},
  signal?: AbortSignal,
): Promise<JoyCodeCoordinationResult> {
  if (request.projectId !== document.id) return Promise.resolve({ kind: 'parity-failure', reason: 'projectId-mismatch' });
  if (request.snapshotRevisionId !== revisionId) return Promise.resolve({ kind: 'parity-failure', reason: 'snapshotRevisionId-mismatch' });
  return syncProjectDocumentBinding(binding, document, revisionId, storage, syncProjectDocument, options).then((syncResult) => {
    if (syncResult.kind === 'conflict') return { kind: 'stale', syncConflict: syncResult } satisfies JoyCodeCoordinationResult;
    if (syncResult.kind === 'request-failure') return { kind: 'sync-failure', syncResult } satisfies JoyCodeCoordinationResult;
    return joyCodeTransport(binding.controlPlaneProjectId, request, signal)
      .then((proposal) => ({ kind: 'success', syncResult, proposal }) satisfies JoyCodeCoordinationResult)
      .catch((error: unknown) => ({ kind: 'plan-failure', syncResult, error }) satisfies JoyCodeCoordinationResult);
  });
}
