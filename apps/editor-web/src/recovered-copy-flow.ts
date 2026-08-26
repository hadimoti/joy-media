import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import { EditorSession } from './editor-session.js';
import { createBlankProjectDocuments } from './project-factory.js';
import {
  saveActiveProjectId,
  upsertCatalogProject,
  type ProjectCatalogEntry,
} from './project-catalog.js';
import {
  bindControlPlaneProjectBinding,
  type ControlPlaneProjectBinding,
} from './project-control-plane.js';
import type { ProjectDocumentRecoveredCopy } from './project-document-sync-coordinator.js';
import { planProjectDocumentHydration } from './project-document-hydration.js';

export interface RecoveredCopyLocalProject {
  readonly entry: ProjectCatalogEntry;
  readonly binding: ControlPlaneProjectBinding;
}

/** Create and activate a local shell whose remote document is loaded by bootstrap. */
export function createAndActivateRecoveredCopyProject(
  storage: BrowserKeyValueStore,
  copy: Pick<ProjectDocumentRecoveredCopy, 'name' | 'projectId' | 'document'>,
  ownerKey: string,
  options: { readonly createEditorProjectId?: () => string; readonly now?: () => string } = {},
): RecoveredCopyLocalProject {
  if (ownerKey.trim().length === 0) throw new TypeError('recovered copy requires an owner key');
  const createEditorProjectId = options.createEditorProjectId ?? createOpaqueEditorProjectId;
  const id = createEditorProjectId();
  const now = options.now?.() ?? new Date().toISOString();
  const title = copy.name.trim() || 'Recovered project';
  const seeds = createBlankProjectDocuments(id, title, now);
  // Materialize the local shell first; the existing EditorWorkspace bootstrap
  // then hydrates the server-created document through its bound project id.
  const editorSession = new EditorSession(storage, seeds.timeline, seeds.visual);
  const hydration = planProjectDocumentHydration(copy.document, copy.projectId, {
    graphEnabled: editorSession.graphEnabled,
    sessionProjectId: id,
  });
  if (!hydration.ok)
    throw new Error(
      `recovered document could not be opened: ${hydration.warnings[0] ?? 'invalid document'}`,
    );
  // Hydrate before catalog activation. If the subsequent remote bootstrap is
  // unavailable, the first V2 journal snapshot still contains the returned
  // recovered document rather than a blank shell.
  editorSession.hydrateProjectDocument(hydration.plan, 'Recovered project opened');
  const entry: ProjectCatalogEntry = {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    timelineProjectId: id,
    visualProjectId: id,
  };
  upsertCatalogProject(storage, entry);
  const binding = bindControlPlaneProjectBinding(storage, { id, title }, copy.projectId, {
    ownerKey,
  });
  saveActiveProjectId(storage, id);
  return { entry, binding };
}

function createOpaqueEditorProjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  return `project-${Date.now()}`;
}
