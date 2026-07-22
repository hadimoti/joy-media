import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { JoyProjectV1 } from '@joy-media/project-schema';

const STORAGE_KEY = 'joy-media.control-plane-project-bindings.v1';

export interface ControlPlaneProjectBinding {
  /** Stable local creative-document identity; never sent as a Worker path. */
  readonly editorProjectId: string;
  /** Opaque owner-scoped record identifier used by the control-plane API. */
  readonly controlPlaneProjectId: string;
  readonly title: string;
}

interface BindingDatabase {
  readonly version: 1;
  readonly bindings: Readonly<Record<string, ControlPlaneProjectBinding>>;
}

/**
 * Binds a persisted local editor project to one opaque control-plane record.
 * The creative document remains browser-local; only this ID/title pair is
 * submitted when the user initializes a Worker job.
 */
export function getOrCreateControlPlaneProjectBinding(
  storage: BrowserKeyValueStore,
  project: Pick<JoyProjectV1, 'id' | 'title'>,
  createId: () => string = createOpaqueProjectId,
): ControlPlaneProjectBinding {
  if (!isNonBlank(project.id) || !isNonBlank(project.title))
    throw new TypeError('editor project requires a non-empty id and title');

  const database = readDatabase(storage);
  const existing = database.bindings[project.id];
  if (existing !== undefined) return existing;

  const binding: ControlPlaneProjectBinding = {
    editorProjectId: project.id,
    controlPlaneProjectId: `project-${createId()}`,
    title: project.title,
  };
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      bindings: { ...database.bindings, [project.id]: binding },
    } satisfies BindingDatabase),
  );
  return binding;
}

function createOpaqueProjectId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function')
    throw new Error('secure browser project identity is unavailable');
  return crypto.randomUUID();
}

function readDatabase(storage: BrowserKeyValueStore): BindingDatabase {
  const serialized = storage.getItem(STORAGE_KEY);
  if (serialized === null) return { version: 1, bindings: {} };
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isDatabase(parsed)) return { version: 1, bindings: {} };
    return parsed;
  } catch {
    return { version: 1, bindings: {} };
  }
}

function isDatabase(value: unknown): value is BindingDatabase {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.bindings)) return false;
  return Object.entries(value.bindings).every(
    ([editorProjectId, binding]) =>
      isRecord(binding) &&
      binding.editorProjectId === editorProjectId &&
      isNonBlank(binding.controlPlaneProjectId) &&
      isNonBlank(binding.title),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
