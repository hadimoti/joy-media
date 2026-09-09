import {
  validateJoyProjectV1,
  validateLookInstancesDocument,
  type JoyProjectV1,
  type LookInstancesDocument,
  type ProjectRevisionId,
} from '@joy-media/project-schema';
import type { BrowserProjectDocument } from './control-plane-client.js';
import type { ControlPlaneProjectBinding } from './project-control-plane.js';

export interface ProjectHydrationSession {
  readonly visualProject: JoyProjectV1;
  readonly projectRevisionId: ProjectRevisionId;
  /** The local canonical Look Instances document (R2 / GAP 1a). */
  readonly lookInstances: LookInstancesDocument;
  synchronizeVisualProject(next: JoyProjectV1): JoyProjectV1;
  /**
   * Apply a server Look Instances document (snapshot-only, no history entry).
   * Called only when the local session is still at the observed revision AND
   * the server actually carried a Look document — never to clear a populated
   * local document from an absent remote value.
   */
  synchronizeLookInstances(next: LookInstancesDocument): void;
}

export type LoadProjectDocument = () => Promise<BrowserProjectDocument | undefined>;

export type ProjectHydrationResult =
  | { readonly kind: 'hydrated'; readonly revisionId: ProjectRevisionId }
  | { readonly kind: 'unchanged'; readonly revisionId: ProjectRevisionId }
  | { readonly kind: 'local-changed'; readonly revisionId: ProjectRevisionId }
  | { readonly kind: 'missing' };

/**
 * Applies a server document only when the local session is still at the exact
 * revision observed before the read. A slow read can therefore never erase a
 * user edit made while the request was in flight.
 */
export async function hydrateProjectDocument(
  session: ProjectHydrationSession,
  binding: Pick<ControlPlaneProjectBinding, 'editorProjectId' | 'controlPlaneProjectId'>,
  load: LoadProjectDocument,
): Promise<ProjectHydrationResult> {
  const localRevision = session.projectRevisionId;
  const remote = await load();
  if (remote === undefined) return { kind: 'missing' };
  if (remote.projectId !== binding.controlPlaneProjectId) {
    throw new Error(
      `Project document response mismatch: expected projectId=${binding.controlPlaneProjectId}, got ${remote.projectId}`,
    );
  }
  if (remote.document.id !== binding.editorProjectId) {
    throw new Error(
      `Project document response mismatch: expected editorProjectId=${binding.editorProjectId}, got ${remote.document.id}`,
    );
  }
  const diagnostics = validateJoyProjectV1(remote.document);
  if (diagnostics.length > 0) {
    throw new Error(`Project document response is invalid: ${diagnostics[0]!.message}`);
  }
  if (remote.lookInstances !== undefined) {
    const lookDiagnostics = validateLookInstancesDocument(remote.lookInstances);
    if (lookDiagnostics.length > 0) {
      throw new Error(
        `Project document Look Instances response is invalid: ${lookDiagnostics[0]!.message}`,
      );
    }
  }
  // A local edit while the read was in flight is authoritative: never overwrite
  // the visual doc OR detach Looks under it (R4).
  if (session.projectRevisionId !== localRevision) {
    return { kind: 'local-changed', revisionId: remote.revisionId };
  }
  const visualSame = JSON.stringify(session.visualProject) === JSON.stringify(remote.document);
  // Apply the remote Look document only when the server carried one AND it
  // differs — an absent remote value never clears a populated local document.
  const looksNeedApply =
    remote.lookInstances !== undefined &&
    JSON.stringify(session.lookInstances) !== JSON.stringify(remote.lookInstances);
  if (visualSame && !looksNeedApply) {
    return { kind: 'unchanged', revisionId: remote.revisionId };
  }
  if (!visualSame) session.synchronizeVisualProject(remote.document);
  if (looksNeedApply) session.synchronizeLookInstances(remote.lookInstances!);
  return { kind: 'hydrated', revisionId: remote.revisionId };
}
