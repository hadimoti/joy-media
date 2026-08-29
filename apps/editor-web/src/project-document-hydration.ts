import {
  validateJoyProjectV1,
  type JoyProjectV1,
  type ProjectRevisionId,
} from '@joy-media/project-schema';
import type { BrowserProjectDocument } from './control-plane-client.js';
import type { ControlPlaneProjectBinding } from './project-control-plane.js';

export interface ProjectHydrationSession {
  readonly visualProject: JoyProjectV1;
  readonly projectRevisionId: ProjectRevisionId;
  synchronizeVisualProject(next: JoyProjectV1): JoyProjectV1;
}

export type LoadProjectDocument = () => Promise<BrowserProjectDocument>;

export type ProjectHydrationResult =
  | { readonly kind: 'hydrated'; readonly revisionId: ProjectRevisionId }
  | { readonly kind: 'unchanged'; readonly revisionId: ProjectRevisionId }
  | { readonly kind: 'local-changed'; readonly revisionId: ProjectRevisionId };

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
  if (session.projectRevisionId !== localRevision) {
    return { kind: 'local-changed', revisionId: remote.revisionId };
  }
  if (JSON.stringify(session.visualProject) === JSON.stringify(remote.document)) {
    return { kind: 'unchanged', revisionId: remote.revisionId };
  }
  session.synchronizeVisualProject(remote.document);
  return { kind: 'hydrated', revisionId: remote.revisionId };
}
