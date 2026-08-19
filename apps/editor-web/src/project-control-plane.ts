import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { JoyProjectV1 } from '@joy-media/project-schema';

const STORAGE_KEY = 'joy-media.control-plane-project-bindings.v1';

export interface ControlPlaneProjectBinding {
  /** Stable local creative-document identity; never sent as a Worker path. */
  readonly editorProjectId: string;
  /** Opaque owner-scoped record identifier used by the control-plane API. */
  readonly controlPlaneProjectId: string;
  readonly title: string;
  /** Last server lifecycle revision observed for this owner-scoped binding. */
  readonly revision?: number;
  /**
   * Server-side CAS head for the persisted JoyProjectV1 document.
   * Distinct from the lifecycle metadata `revision`; this tracks the
   * document's content version in the server's CAS storage.
   */
  readonly documentRevisionId?: string;
  /** Server trash timestamp, when the bound project is in Trash. */
  readonly trashedAt?: number;
}

interface BindingDatabaseV2 {
  readonly version: 2;
  readonly bindingsByOwner: Readonly<
    Record<string, Readonly<Record<string, ControlPlaneProjectBinding>>>
  >;
}

/** Legacy v1 shape — migrated into bindingsByOwner['legacy'] on read. */
interface BindingDatabaseV1 {
  readonly version: 1;
  readonly bindings: Readonly<Record<string, ControlPlaneProjectBinding>>;
}

export interface ControlPlaneBindingOptions {
  readonly createId?: () => string;
  /**
   * Session identity (Telegram id / Gmail). Bindings are per-owner so one
   * browser profile can sign in as different accounts without reusing another
   * account's control-plane project id (which surfaces as Jobs 409).
   */
  readonly ownerKey?: string;
}

export function getControlPlaneProjectBinding(
  storage: BrowserKeyValueStore,
  editorProjectId: string,
  ownerKey = 'local',
): ControlPlaneProjectBinding | undefined {
  return readDatabase(storage).bindingsByOwner[ownerKey]?.[editorProjectId];
}

export function upsertControlPlaneProjectBinding(
  storage: BrowserKeyValueStore,
  binding: ControlPlaneProjectBinding,
  ownerKey = 'local',
): void {
  const database = readDatabase(storage);
  const ownerBindings = database.bindingsByOwner[ownerKey] ?? {};
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 2,
      bindingsByOwner: {
        ...database.bindingsByOwner,
        [ownerKey]: { ...ownerBindings, [binding.editorProjectId]: binding },
      },
    } satisfies BindingDatabaseV2),
  );
}

export function removeControlPlaneProjectBinding(
  storage: BrowserKeyValueStore,
  editorProjectId: string,
  ownerKey = 'local',
): void {
  const database = readDatabase(storage);
  const ownerBindings = database.bindingsByOwner[ownerKey];
  if (ownerBindings?.[editorProjectId] === undefined) return;
  const nextOwnerBindings = { ...ownerBindings };
  delete nextOwnerBindings[editorProjectId];
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 2,
      bindingsByOwner: { ...database.bindingsByOwner, [ownerKey]: nextOwnerBindings },
    } satisfies BindingDatabaseV2),
  );
}

/**
 * Binds a persisted local editor project to one opaque control-plane record.
 * The creative document remains browser-local; only this ID/title pair is
 * submitted when the user initializes a Worker job.
 */
export function getOrCreateControlPlaneProjectBinding(
  storage: BrowserKeyValueStore,
  project: Pick<JoyProjectV1, 'id' | 'title'>,
  createIdOrOptions: (() => string) | ControlPlaneBindingOptions = {},
  ownerKeyArg?: string,
): ControlPlaneProjectBinding {
  if (!isNonBlank(project.id) || !isNonBlank(project.title))
    throw new TypeError('editor project requires a non-empty id and title');

  const options = normalizeOptions(createIdOrOptions, ownerKeyArg);
  const ownerKey = options.ownerKey;
  const createId = options.createId;
  const database = readDatabase(storage);
  const ownerBindings = database.bindingsByOwner[ownerKey] ?? {};
  const existing = ownerBindings[project.id];
  if (existing !== undefined) return existing;

  const binding: ControlPlaneProjectBinding = {
    editorProjectId: project.id,
    controlPlaneProjectId: `project-${createId()}`,
    title: project.title,
  };
  upsertControlPlaneProjectBinding(storage, binding, ownerKey);
  return binding;
}

function normalizeOptions(
  createIdOrOptions: (() => string) | ControlPlaneBindingOptions,
  ownerKeyArg?: string,
): { readonly createId: () => string; readonly ownerKey: string } {
  if (typeof createIdOrOptions === 'function') {
    return {
      createId: createIdOrOptions,
      ownerKey: isNonBlank(ownerKeyArg) ? ownerKeyArg.trim() : 'local',
    };
  }
  return {
    createId: createIdOrOptions.createId ?? createOpaqueProjectId,
    ownerKey: isNonBlank(createIdOrOptions.ownerKey)
      ? createIdOrOptions.ownerKey.trim()
      : isNonBlank(ownerKeyArg)
        ? ownerKeyArg.trim()
        : 'local',
  };
}

function createOpaqueProjectId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function')
    throw new Error('secure browser project identity is unavailable');
  return crypto.randomUUID();
}

function readDatabase(storage: BrowserKeyValueStore): BindingDatabaseV2 {
  const serialized = storage.getItem(STORAGE_KEY);
  if (serialized === null) return { version: 2, bindingsByOwner: {} };
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (isDatabaseV2(parsed)) return parsed;
    if (isDatabaseV1(parsed)) {
      return {
        version: 2,
        bindingsByOwner: { legacy: parsed.bindings },
      };
    }
    return { version: 2, bindingsByOwner: {} };
  } catch {
    return { version: 2, bindingsByOwner: {} };
  }
}

function isDatabaseV2(value: unknown): value is BindingDatabaseV2 {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.bindingsByOwner)) return false;
  return Object.values(value.bindingsByOwner).every(
    (ownerBindings) =>
      isRecord(ownerBindings) &&
      Object.entries(ownerBindings).every(
        ([editorProjectId, binding]) =>
          isRecord(binding) &&
          binding.editorProjectId === editorProjectId &&
          isNonBlank(binding.controlPlaneProjectId) &&
          isNonBlank(binding.title) &&
          (binding.revision === undefined || isNonNegativeInteger(binding.revision)) &&
          (binding.documentRevisionId === undefined || isNonBlank(binding.documentRevisionId)) &&
          (binding.trashedAt === undefined || isNonNegativeInteger(binding.trashedAt)),
      ),
  );
}

function isDatabaseV1(value: unknown): value is BindingDatabaseV1 {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.bindings)) return false;
  return Object.entries(value.bindings).every(
    ([editorProjectId, binding]) =>
      isRecord(binding) &&
      binding.editorProjectId === editorProjectId &&
      isNonBlank(binding.controlPlaneProjectId) &&
      isNonBlank(binding.title) &&
      (binding.documentRevisionId === undefined || isNonBlank(binding.documentRevisionId)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
