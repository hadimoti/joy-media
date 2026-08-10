import type { ArtifactStore } from '@joy-media/commands';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import { BrowserProjectStore } from '@joy-media/project-persistence';
import type { JoyProjectV1, SpikeProject, WorkflowGraphV2 } from '@joy-media/project-schema';
import {
  CREATIVE_ARTIFACT_LOG_KEY,
  EditorSession,
  WORKFLOW_GRAPH_LOG_KEY,
} from './editor-session.js';
import { loadAudioStateFrom, removeAudioState, saveAudioStateTo } from './audio-session.js';
import { removeAgentIdempotencyRecords } from './agent-idempotency-store.js';
import { ProjectOperationLedger } from './project-operation-ledger.js';
import {
  purgeCatalogProject,
  restoreCatalogProject,
  trashCatalogProject,
  TIMELINE_LOG_KEY,
  type ProjectCatalogEntry,
  upsertCatalogProject,
  VISUAL_LOG_KEY,
} from './project-catalog.js';
import { seedsForCatalogEntry } from './project-factory.js';
import { removeJoyCodeThreads } from './joy-code-history.js';
import { BrowserControlPlaneClient } from './control-plane-client.js';
import { getStoredMediaToken } from './media-session.js';
import type { MediaSessionStorage } from './media-session.js';
import { probeJoySession } from './identity.js';
import {
  getControlPlaneProjectBinding,
  removeControlPlaneProjectBinding,
  upsertControlPlaneProjectBinding,
} from './project-control-plane.js';

export interface ProjectDocumentBundle {
  readonly timeline: SpikeProject;
  readonly visual: JoyProjectV1;
  readonly graph?: WorkflowGraphV2;
  readonly artifacts?: ArtifactStore;
}

export interface DuplicateLocalProjectOptions {
  readonly assetIdMap?: Readonly<Record<string, string>>;
  readonly derivativeIdMap?: Readonly<Record<string, string>>;
  readonly createId?: () => string;
  readonly now?: () => string;
}

export async function renameProject(
  storage: BrowserKeyValueStore,
  entry: ProjectCatalogEntry,
  title: string,
): Promise<ProjectCatalogEntry> {
  const cleanTitle = requireTitle(title);
  const remote = await openRemoteProject(storage, entry);
  if (remote === undefined) return renameLocalProject(storage, entry, cleanTitle);
  const updated = await remote.client.renameProject(
    remote.binding.controlPlaneProjectId,
    cleanTitle,
    remote.project.revision,
  );
  try {
    const local = renameLocalProject(storage, entry, cleanTitle);
    upsertControlPlaneProjectBinding(
      storage,
      bindingFromMetadata(remote.binding, updated),
      remote.ownerKey,
    );
    return local;
  } catch (error) {
    await remote.client
      .renameProject(remote.binding.controlPlaneProjectId, remote.project.title, updated.revision)
      .catch(() => undefined);
    throw error;
  }
}

export async function duplicateProject(
  storage: BrowserKeyValueStore,
  entry: ProjectCatalogEntry,
  title: string,
): Promise<ProjectCatalogEntry> {
  const cleanTitle = requireTitle(title);
  const remote = await openRemoteProject(storage, entry);
  if (remote === undefined) return duplicateLocalProject(storage, entry, cleanTitle);
  const remoteId = createProjectId('project');
  const duplicated = await remote.client.duplicateProject(
    remote.binding.controlPlaneProjectId,
    remoteId,
    cleanTitle,
    remote.project.revision,
  );
  try {
    const local = duplicateLocalProject(storage, entry, cleanTitle, {
      assetIdMap: duplicated.assetIdMap,
      derivativeIdMap: duplicated.derivativeIdMap,
    });
    upsertControlPlaneProjectBinding(
      storage,
      {
        editorProjectId: local.id,
        controlPlaneProjectId: duplicated.project.id,
        title: cleanTitle,
        revision: duplicated.project.revision,
      },
      remote.ownerKey,
    );
    return local;
  } catch (error) {
    await remote.client
      .trashProject(duplicated.project.id, duplicated.project.revision)
      .then((trashed) => remote.client.deleteProject(duplicated.project.id).catch(() => trashed))
      .catch(() => undefined);
    throw error;
  }
}

export async function trashProject(
  storage: BrowserKeyValueStore,
  entry: ProjectCatalogEntry,
): Promise<void> {
  const remote = await openRemoteProject(storage, entry);
  if (remote === undefined) return trashLocalProject(storage, entry);
  const trashed = await remote.client.trashProject(
    remote.binding.controlPlaneProjectId,
    remote.project.revision,
  );
  try {
    trashLocalProject(storage, entry);
    upsertControlPlaneProjectBinding(
      storage,
      bindingFromMetadata(remote.binding, trashed),
      remote.ownerKey,
    );
  } catch (error) {
    await remote.client
      .restoreProject(remote.binding.controlPlaneProjectId, trashed.revision)
      .catch(() => undefined);
    throw error;
  }
}

export async function restoreProject(
  storage: BrowserKeyValueStore,
  entry: ProjectCatalogEntry,
): Promise<void> {
  const remote = await openRemoteProject(storage, entry);
  if (remote === undefined) return restoreLocalProject(storage, entry);
  const restored = await remote.client.restoreProject(
    remote.binding.controlPlaneProjectId,
    remote.project.revision,
  );
  restoreLocalProject(storage, entry);
  upsertControlPlaneProjectBinding(
    storage,
    bindingFromMetadata(remote.binding, restored),
    remote.ownerKey,
  );
}

export async function purgeProject(
  storage: BrowserKeyValueStore,
  entry: ProjectCatalogEntry,
): Promise<void> {
  const remote = await openRemoteProject(storage, entry);
  if (remote !== undefined) {
    const remoteProject =
      remote.project.trashedAt === undefined
        ? await remote.client.trashProject(
            remote.binding.controlPlaneProjectId,
            remote.project.revision,
          )
        : remote.project;
    await remote.client.deleteProject(remoteProject.id);
  }
  purgeLocalProject(storage, entry);
  if (remote !== undefined) removeControlPlaneProjectBinding(storage, entry.id, remote.ownerKey);
}

export function renameLocalProject(
  storage: BrowserKeyValueStore,
  entry: ProjectCatalogEntry,
  title: string,
): ProjectCatalogEntry {
  const cleanTitle = requireTitle(title);
  const session = openSession(storage, entry);
  session.renameProjectTitle(cleanTitle);
  const next = { ...entry, title: cleanTitle, updatedAt: new Date().toISOString() };
  upsertCatalogProject(storage, next);
  return next;
}

export function duplicateLocalProject(
  storage: BrowserKeyValueStore,
  entry: ProjectCatalogEntry,
  title: string,
  options: DuplicateLocalProjectOptions = {},
): ProjectCatalogEntry {
  const cleanTitle = requireTitle(title);
  const source = readProjectBundle(storage, entry);
  const id = options.createId?.() ?? createProjectId();
  const now = options.now?.() ?? new Date().toISOString();
  const assetIdMap = options.assetIdMap ?? {};
  const derivativeIdMap = options.derivativeIdMap ?? {};
  const timeline = remapProject({ ...source.timeline, id }, assetIdMap, derivativeIdMap);
  const visual = remapProject(
    {
      ...source.visual,
      id,
      title: cleanTitle,
      createdAt: now,
      updatedAt: now,
    },
    assetIdMap,
    derivativeIdMap,
  );
  const graph =
    source.graph === undefined
      ? undefined
      : remapProject(source.graph, assetIdMap, derivativeIdMap);
  const artifacts =
    source.artifacts === undefined
      ? undefined
      : remapProject(source.artifacts, assetIdMap, derivativeIdMap);

  // Materialize one clean baseline snapshot for each enabled persistence family.
  new EditorSession(
    storage,
    timeline,
    visual,
    graph === undefined && artifacts === undefined
      ? {}
      : {
          ...(graph === undefined ? {} : { graph }),
          ...(artifacts === undefined ? {} : { artifacts }),
        },
  );
  saveAudioStateTo(storage, id, loadAudioStateFrom(storage, entry.id));

  const next: ProjectCatalogEntry = {
    id,
    title: cleanTitle,
    createdAt: now,
    updatedAt: now,
    timelineProjectId: id,
    visualProjectId: id,
  };
  upsertCatalogProject(storage, next);
  return next;
}

export function readProjectBundle(
  storage: BrowserKeyValueStore,
  entry: ProjectCatalogEntry,
): ProjectDocumentBundle {
  const session = openSession(storage, entry);
  const bundle: ProjectDocumentBundle = {
    timeline: session.timelineProject,
    visual: session.visualProject,
  };
  if (session.graphEnabled) {
    return { ...bundle, graph: session.workflowGraph, artifacts: session.artifacts };
  }
  return bundle;
}

export function trashLocalProject(storage: BrowserKeyValueStore, entry: ProjectCatalogEntry): void {
  trashCatalogProject(storage, entry.id);
}

export function restoreLocalProject(
  storage: BrowserKeyValueStore,
  entry: ProjectCatalogEntry,
): void {
  restoreCatalogProject(storage, entry.id);
}

export function purgeLocalProject(storage: BrowserKeyValueStore, entry: ProjectCatalogEntry): void {
  new BrowserProjectStore(storage, TIMELINE_LOG_KEY).deleteProject(entry.timelineProjectId);
  new BrowserProjectStore(storage, VISUAL_LOG_KEY).deleteProject(entry.visualProjectId);
  new BrowserProjectStore(storage, WORKFLOW_GRAPH_LOG_KEY).deleteProject(entry.id);
  new BrowserProjectStore(storage, CREATIVE_ARTIFACT_LOG_KEY).deleteProject(entry.id);
  removeAudioState(storage, entry.id);
  removeAgentIdempotencyRecords(storage, entry.id);
  new ProjectOperationLedger(storage, entry.id).removeAll();
  removeJoyCodeThreads(storage, entry.id);
  purgeCatalogProject(storage, entry.id);
}

function openSession(storage: BrowserKeyValueStore, entry: ProjectCatalogEntry): EditorSession {
  const seeds = seedsForCatalogEntry(entry);
  return new EditorSession(storage, seeds.timeline, seeds.visual);
}

function requireTitle(title: string): string {
  const clean = title.trim();
  if (clean.length === 0) throw new Error('Project name cannot be empty.');
  return clean;
}

function createProjectId(prefix = 'project'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function remapProject<T>(
  value: T,
  assetIdMap: Readonly<Record<string, string>>,
  derivativeIdMap: Readonly<Record<string, string>>,
): T {
  return remapJson(value, { ...assetIdMap, ...derivativeIdMap });
}

function remapJson<T>(value: T, replacements: Readonly<Record<string, string>>): T {
  if (typeof value === 'string') return (replacements[value] ?? value) as T;
  if (Array.isArray(value)) return value.map((item) => remapJson(item, replacements)) as T;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) {
      const nextKey = replacements[key] ?? key;
      result[nextKey] = remapJson(item, replacements);
    }
    return result as T;
  }
  return value;
}

interface RemoteProjectContext {
  readonly client: BrowserControlPlaneClient;
  readonly binding: NonNullable<ReturnType<typeof getControlPlaneProjectBinding>>;
  readonly project: Awaited<ReturnType<BrowserControlPlaneClient['project']>>;
  readonly ownerKey: string;
}

async function openRemoteProject(
  storage: BrowserKeyValueStore,
  entry: ProjectCatalogEntry,
): Promise<RemoteProjectContext | undefined> {
  const sessionStorage = storage as BrowserKeyValueStore & MediaSessionStorage;
  if (getStoredMediaToken(sessionStorage) === undefined) return undefined;
  const session = await probeJoySession(sessionStorage);
  const ownerKey = session.kind === 'ready' ? (session.subject ?? 'signed-in') : 'signed-in';
  const client = new BrowserControlPlaneClient();
  const binding = getControlPlaneProjectBinding(storage, entry.id, ownerKey);
  if (binding === undefined) return undefined;
  await client.ensureProject(binding.controlPlaneProjectId, entry.title);
  const project = await client.project(binding.controlPlaneProjectId);
  upsertControlPlaneProjectBinding(storage, bindingFromMetadata(binding, project), ownerKey);
  return {
    client,
    binding,
    project,
    ownerKey,
  };
}

function bindingFromMetadata(
  binding: NonNullable<ReturnType<typeof getControlPlaneProjectBinding>>,
  project: { readonly title: string; readonly revision: number; readonly trashedAt?: number },
): NonNullable<ReturnType<typeof getControlPlaneProjectBinding>> {
  const { trashedAt, ...rest } = binding;
  void trashedAt;
  return project.trashedAt === undefined
    ? { ...rest, title: project.title, revision: project.revision }
    : { ...rest, title: project.title, revision: project.revision, trashedAt: project.trashedAt };
}
