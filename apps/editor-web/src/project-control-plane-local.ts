import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { JoyProjectV1 } from '@joy-media/project-schema';

const STORAGE_KEY = 'joy-media.control-plane-project-bindings.v1';

export interface ControlPlaneProjectBinding {
  readonly editorProjectId: string;
  readonly controlPlaneProjectId: string;
  readonly title: string;
}

export interface ControlPlaneBindingOptions {
  readonly createId?: () => string;
  readonly ownerKey?: string;
}

interface BindingDatabase {
  readonly version: 2;
  readonly bindingsByOwner: Readonly<
    Record<string, Readonly<Record<string, ControlPlaneProjectBinding>>>
  >;
}

/** Read the browser-local binding without loading remote control-plane code. */
export function getOrCreateControlPlaneProjectBinding(
  storage: BrowserKeyValueStore,
  project: Pick<JoyProjectV1, 'id' | 'title'>,
  createIdOrOptions: (() => string) | ControlPlaneBindingOptions = {},
  ownerKeyArg?: string,
): ControlPlaneProjectBinding {
  if (!isNonBlank(project.id) || !isNonBlank(project.title))
    throw new TypeError('editor project requires a non-empty id and title');
  const options =
    typeof createIdOrOptions === 'function'
      ? { createId: createIdOrOptions, ownerKey: ownerKeyArg }
      : {
          createId: createIdOrOptions.createId ?? createOpaqueProjectId,
          ownerKey: createIdOrOptions.ownerKey ?? ownerKeyArg,
        };
  const ownerKey = isNonBlank(options.ownerKey) ? options.ownerKey.trim() : 'local';
  const database = readDatabase(storage);
  const ownerBindings = database.bindingsByOwner[ownerKey] ?? {};
  const existing = ownerBindings[project.id];
  if (existing !== undefined) return existing;
  const binding: ControlPlaneProjectBinding = {
    editorProjectId: project.id,
    controlPlaneProjectId: `project-${options.createId()}`,
    title: project.title,
  };
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 2,
      bindingsByOwner: {
        ...database.bindingsByOwner,
        [ownerKey]: { ...ownerBindings, [project.id]: binding },
      },
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
  if (serialized === null) return { version: 2, bindingsByOwner: {} };
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (isDatabase(parsed)) return parsed;
    if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.bindings))
      return {
        version: 2,
        bindingsByOwner: { legacy: parsed.bindings as Record<string, ControlPlaneProjectBinding> },
      };
  } catch {
    // Treat malformed browser state as an empty local binding database.
  }
  return { version: 2, bindingsByOwner: {} };
}

function isDatabase(value: unknown): value is BindingDatabase {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.bindingsByOwner)) return false;
  return Object.values(value.bindingsByOwner).every(
    (ownerBindings) =>
      isRecord(ownerBindings) &&
      Object.entries(ownerBindings).every(
        ([id, binding]) =>
          isRecord(binding) &&
          binding.editorProjectId === id &&
          isNonBlank(binding.controlPlaneProjectId) &&
          isNonBlank(binding.title),
      ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
