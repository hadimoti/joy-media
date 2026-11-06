/* global process */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getJoyMediaHome } from '@joy-media/project-persistence/joy-media-home';
import {
  createCredentialStore,
  migrateProviderFile,
  type CredentialStore,
} from './credential-store.js';
import { createDpapiProtector, createRestrictedFileProtector } from './dpapi-protector.js';

/** One agent slot as the config file keeps it. Nothing here is secret: the key stays in the credential store. */
export interface SavedAgentSlot {
  profileId?: string | undefined;
  model?: string | undefined;
  instructions?: string | undefined;
  settings?: { temperature?: number | undefined; maxOutputTokens?: number | undefined } | undefined;
}

export interface CliConfig {
  activeProvider?: string | undefined;
  defaultModel?: string | undefined;
  customBaseUrl?: string | undefined;
  sqlitePath?: string | undefined;
  /** ChatGPT's accepted host identity, generated once for this CLI installation. */
  chatgptExtAgentHostId?: string | undefined;
  /** Issued clients awaiting a successful sign-in; client IDs are public, never tokens. */
  chatgptPendingRegistrations?: Array<{ profileId: string; clientId: string }> | undefined;
  /** The two agent slots (PLAN-v4 §6d-1). A slot that is not saved is empty. */
  agentSlots?: Partial<Record<'workhorse' | 'creative', SavedAgentSlot>> | undefined;
}

export interface AiProviderConfig {
  /** The public endpoint the owner consented to, as origin and base path (S8). A changed endpoint needs consent again. */
  endpointConsent?: string | undefined;
  name?: string | undefined;
  provider?: string | undefined;
  /** Older profile metadata without this field remains on the API-key route (D22 step 3 design, §11). */
  authKind?: 'api-key' | 'oauth' | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  defaultModel?: string | undefined;
  cachedModels?: string[] | undefined;
}

/**
 * A config file exists but cannot be used (not JSON, wrong shape). Callers
 * must NOT fall back to an empty config and save over it: that silently
 * destroys every other provider and API key the user stored.
 *
 * The message deliberately never includes the file's contents (V8's
 * JSON.parse errors quote the source text, which may contain API keys).
 */
export class ConfigFileError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(
      `${path} is ${reason}. It was left untouched so no stored provider or API key is lost; ` +
        'fix or move the file and retry.',
    );
    this.name = 'ConfigFileError';
  }
}

const IS_POSIX = process.platform !== 'win32';
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function getJoyMediaDir(): string {
  const dir = getJoyMediaHome();
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    } catch {
      // Ignore if cannot create
    }
  }
  return dir;
}

export function getCliConfigPath(): string {
  return join(getJoyMediaDir(), 'cli-config.json');
}

export function getAiProvidersPath(): string {
  return join(getJoyMediaDir(), 'ai-providers.json');
}

/** Tighten group/other permission bits on POSIX (best effort, never throws). */
function makePrivate(path: string, mode: number): void {
  if (!IS_POSIX) return;
  try {
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, mode);
  } catch {
    // Best effort: a read-only or foreign-owned file is reported elsewhere.
  }
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConfigFileError(path, 'not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigFileError(path, 'not a JSON object');
  }
  // Null prototype: names like "constructor" or "toString" must never resolve
  // to Object.prototype members.
  return Object.assign(Object.create(null) as Record<string, unknown>, parsed);
}

/** Atomic replace: readers never observe a half-written file. */
function writeFileAtomic(path: string, content: string, mode: number): void {
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp may not exist
    }
    throw error;
  }
  makePrivate(path, mode);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

/**
 * Serialise read-modify-write cycles on the config files across processes
 * (AI agents happily run several `joy-media agent provider add` at once).
 */
function withNamedLock<T>(name: string, fn: () => T): T {
  const lock = join(getJoyMediaDir(), name);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (lockOwnerIsGone(lock)) rmSync(lock, { recursive: true, force: true });
      } catch {
        // Lock released between our checks: retry.
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for the config lock ${lock}. Remove it if stale.`);
      }
      sleepSync(15);
    }
  }
  try {
    // The owner is recorded after the lock is taken. A lock whose owner is alive is never reclaimed, however old.
    try {
      writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: process.pid }), {
        mode: PRIVATE_FILE_MODE,
      });
    } catch {
      // Without a record the lock is judged by its age alone.
    }
    return fn();
  } finally {
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      // Already gone.
    }
  }
}

/**
 * Whether a lock directory's owner has gone. A live owner is never reclaimed, however long it holds the lock. A lock
 * with no readable owner record goes by age alone, which covers a crash between taking the lock and recording it.
 */
function lockOwnerIsGone(lock: string): boolean {
  let pid: unknown;
  try {
    pid = (JSON.parse(readFileSync(join(lock, 'owner'), 'utf8')) as { pid?: unknown }).pid;
  } catch {
    pid = undefined;
  }
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function withConfigLock<T>(fn: () => T): T {
  return withNamedLock('.config.lock', fn);
}

function withCredentialLock<T>(fn: () => T): T {
  return withNamedLock('.credentials.lock', fn);
}

/** @throws ConfigFileError when the file exists but is corrupt. */
export function loadCliConfig(): CliConfig {
  return (readJsonObject(getCliConfigPath()) ?? {}) as CliConfig;
}

export function saveCliConfig(config: CliConfig): void {
  writeFileAtomic(getCliConfigPath(), `${JSON.stringify(config, null, 2)}\n`, PRIVATE_FILE_MODE);
}

/** Locked read-modify-write of `cli-config.json`. */
export function updateCliConfig(mutate: (current: CliConfig) => CliConfig): CliConfig {
  return withConfigLock(() => {
    const next = mutate(loadCliConfig());
    saveCliConfig(next);
    return next;
  });
}

/** Read pending public registrations without accepting malformed or ambiguous configuration. */
function pendingChatGptRegistrations(
  config: CliConfig,
): Array<{ profileId: string; clientId: string }> {
  const value: unknown = config.chatgptPendingRegistrations;
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new ConfigFileError(getCliConfigPath(), 'invalid ChatGPT registrations');
  const entries: Array<{ profileId: string; clientId: string }> = [];
  for (const item of value as unknown[]) {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      throw new ConfigFileError(getCliConfigPath(), 'invalid ChatGPT registrations');
    const { profileId, clientId } = item as Record<string, unknown>;
    if (
      typeof profileId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileId) ||
      typeof clientId !== 'string' ||
      !/^[A-Za-z0-9._-]{1,256}$/.test(clientId) ||
      clientId === 'dynamic_agent_client' ||
      entries.some((entry) => entry.profileId === profileId)
    )
      throw new ConfigFileError(getCliConfigPath(), 'invalid ChatGPT registrations');
    entries.push({ profileId, clientId });
  }
  return entries;
}

export function pendingChatGptClientId(profileId: string): string | undefined {
  return pendingChatGptRegistrations(loadCliConfig()).find((entry) => entry.profileId === profileId)
    ?.clientId;
}

/** Fail closed if another attempt already retained a different registration for this profile. */
export function savePendingChatGptClientId(profileId: string, clientId: string): void {
  updateCliConfig((config) => {
    const entries = pendingChatGptRegistrations(config);
    const existing = entries.find((entry) => entry.profileId === profileId);
    if (existing !== undefined && existing.clientId !== clientId)
      throw new Error('Another ChatGPT registration is pending for this profile.');
    const next = existing === undefined ? [...entries, { profileId, clientId }] : entries;
    pendingChatGptRegistrations({ chatgptPendingRegistrations: next });
    return { ...config, chatgptPendingRegistrations: next };
  });
}

/**
 * Drop every pending registration for this profile. Used after its sign-in has been stored, and when the
 * profile is removed. It never touches another profile's registration.
 */
export function clearPendingChatGptRegistrations(profileId: string): void {
  // Nothing to clear means nothing to write, so an unrelated write failure cannot block this step.
  if (
    !pendingChatGptRegistrations(loadCliConfig()).some((entry) => entry.profileId === profileId)
  ) {
    return;
  }
  updateCliConfig((config) => {
    const entries = pendingChatGptRegistrations(config);
    if (!entries.some((entry) => entry.profileId === profileId)) return config;
    return {
      ...config,
      chatgptPendingRegistrations: entries.filter((entry) => entry.profileId !== profileId),
    };
  });
}

/**
 * Returns the saved host ID, creating it only when it is absent. An existing config is never rewritten, so a
 * config write failure cannot block a sign-in that needs no new value.
 */
export function ensureChatGptExtAgentHostId(create: () => string): string {
  return withConfigLock(() => {
    const current = loadCliConfig();
    if (current.chatgptExtAgentHostId !== undefined) return current.chatgptExtAgentHostId;
    const created = create();
    saveCliConfig({ ...current, chatgptExtAgentHostId: created });
    return created;
  });
}

/** The CLI credential store, opened with the protector for this platform (PLAN-v4 §6b). */
export function openCredentialStore(): CredentialStore {
  const store = createCredentialStore({
    path: join(getJoyMediaDir(), 'credentials.json'),
    protector:
      process.platform === 'win32' ? createDpapiProtector() : createRestrictedFileProtector(),
  });
  return {
    list: () => store.list(),
    read: (name) => store.read(name),
    save: (name, credential) => withCredentialLock(() => store.save(name, credential)),
    remove: (name) => withCredentialLock(() => store.remove(name)),
  };
}

/**
 * Moves any plaintext API key from ai-providers.json into the credential store (PLAN-v4 §6b, §9a). It does
 * nothing when the file is absent, so an ordinary start pays no cost.
 */
export function migrateLegacyProviders(): void {
  withConfigLock(() => {
    const path = getAiProvidersPath();
    const providers = readJsonObject(path);
    if (providers === undefined) return;
    assertProviderEntries(path, providers);
    migrateProviderFile({ providersPath: path, store: openCredentialStore() });
  });
}

/**
 * The providers, with each API key read from the credential store. ai-providers.json holds only the
 * non-secret fields. A key that cannot be read is left out, and nothing is written back.
 */
export function loadAiProviders(): Record<string, AiProviderConfig> {
  const path = getAiProvidersPath();
  const rawProviders = readJsonObject(path);
  if (rawProviders === undefined) return Object.create(null) as Record<string, AiProviderConfig>;
  // Self-heal installs that stored keys world-readable before this fix.
  makePrivate(getJoyMediaDir(), PRIVATE_DIR_MODE);
  makePrivate(path, PRIVATE_FILE_MODE);
  assertProviderEntries(path, rawProviders);
  const providers = rawProviders as Record<string, AiProviderConfig>;
  let store: CredentialStore | undefined;
  for (const [name, entry] of Object.entries(providers)) {
    if (entry.apiKey !== undefined || entry.authKind === 'oauth') continue;
    store ??= openCredentialStore();
    try {
      const credential = store.read(name);
      if (credential !== undefined && 'apiKey' in credential) {
        providers[name] = {
          ...entry,
          apiKey: credential.apiKey,
          baseUrl: entry.baseUrl ?? credential.baseUrl,
          defaultModel: entry.defaultModel ?? credential.defaultModel,
        };
      }
    } catch {
      // The key is unavailable: the provider is listed without it. Nothing is written back.
    }
  }
  return providers;
}

/**
 * Every provider entry must be a JSON object. A malformed entry throws instead of being skipped or
 * rewritten, so a save can never replace a corrupt file with new content.
 * @throws ConfigFileError when an entry is not an object.
 */
function assertProviderEntries(path: string, providers: Record<string, unknown>): void {
  // The name is left out of the message: it can be any string, so it could carry a key.
  for (const entry of Object.values(providers)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ConfigFileError(path, 'not a JSON object (a provider entry is not one)');
    }
  }
}

function loadAiProviderMetadata(): Record<string, AiProviderConfig> {
  const path = getAiProvidersPath();
  const rawProviders = readJsonObject(path);
  if (rawProviders === undefined) return Object.create(null) as Record<string, AiProviderConfig>;
  assertProviderEntries(path, rawProviders);
  return rawProviders as Record<string, AiProviderConfig>;
}

/** Writes only non-secret provider metadata with an atomic replacement. */
function saveAiProviderMetadata(providers: Record<string, AiProviderConfig>): void {
  const path = getAiProvidersPath();
  // A corrupt file that is already on disk is never replaced by a save.
  const existing = readJsonObject(path);
  if (existing !== undefined) assertProviderEntries(path, existing);
  const metadata = Object.create(null) as Record<string, AiProviderConfig>;
  for (const [name, entry] of Object.entries(providers)) {
    metadata[name] = {
      endpointConsent: entry.endpointConsent,
      name: entry.name,
      provider: entry.provider,
      authKind: entry.authKind,
      baseUrl: entry.baseUrl,
      defaultModel: entry.defaultModel,
      cachedModels: entry.cachedModels,
    };
  }
  makePrivate(getJoyMediaDir(), PRIVATE_DIR_MODE);
  writeFileAtomic(path, `${JSON.stringify(metadata, null, 2)}\n`, PRIVATE_FILE_MODE);
}

function saveProviderCredential(name: string, entry: AiProviderConfig): void {
  if (entry.apiKey === undefined || entry.apiKey.length === 0) return;
  openCredentialStore().save(name, {
    apiKey: entry.apiKey,
    ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
    ...(entry.defaultModel === undefined ? {} : { defaultModel: entry.defaultModel }),
  });
}

/** Writes provider metadata atomically and keeps each API key in the credential store. */
export function saveAiProviders(providers: Record<string, AiProviderConfig>): void {
  saveAiProviderMetadata(providers);
  for (const [name, entry] of Object.entries(providers)) saveProviderCredential(name, entry);
}

/** Locked read-modify-write of `ai-providers.json`. */
export function updateAiProviders<T>(
  mutate: (providers: Record<string, AiProviderConfig>) => T,
): T {
  // The keys are saved inside the same lock. Otherwise a key captured here could be saved after a removal of its
  // profile had completed, and would then reattach to a later profile of the same name.
  return withConfigLock(() => {
    const providers = loadAiProviderMetadata();
    const result = mutate(providers);
    saveAiProviderMetadata(providers);
    for (const [name, entry] of Object.entries(providers)) saveProviderCredential(name, entry);
    return result;
  });
}

export function hasAiProvider(providers: Record<string, AiProviderConfig>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(providers, name);
}

export function setAiProvider(name: string, config: AiProviderConfig): void {
  updateAiProviders((providers) => {
    providers[name] = config;
  });
}

/** Puts back the profile metadata from before a failed sign-in commit. `undefined` means it did not exist. */
export function restoreAiProvider(name: string, previous: AiProviderConfig | undefined): void {
  updateAiProviders((providers) => {
    if (previous === undefined) delete providers[name];
    else providers[name] = previous;
  });
}

/**
 * Removes a profile and its stored key. The key goes first, and if it cannot be deleted this throws and the profile
 * stays. A profile left without its key would let a stale key reattach to a later profile of the same name, since
 * loadAiProviders matches stored keys by name. Callers hold the profile lock.
 */
export function deleteAiProvider(name: string): boolean {
  // The key and the profile go under one config lock. Legacy key migration takes the same lock, so it cannot
  // save this name's key between the two steps and leave an orphan behind.
  return withConfigLock(() => {
    const providers = loadAiProviderMetadata();
    if (!hasAiProvider(providers, name)) return false;
    // The store file is not created just to forget a key.
    if (existsSync(join(getJoyMediaDir(), 'credentials.json'))) {
      try {
        openCredentialStore().remove(name);
      } catch (error) {
        throw new StoredKeyRemovalError(name, error);
      }
    }
    delete providers[name];
    saveAiProviderMetadata(providers);
    return true;
  });
}

/** The stored key could not be deleted, so the profile was kept. */
export class StoredKeyRemovalError extends Error {
  constructor(
    readonly profileId: string,
    cause: unknown,
  ) {
    super(`The stored key for "${profileId}" could not be deleted.`, { cause });
    this.name = 'StoredKeyRemovalError';
  }
}

export function getDefaultSqlitePath(): string {
  if (process.env.JOY_MEDIA_SQLITE_PATH) {
    return process.env.JOY_MEDIA_SQLITE_PATH;
  }
  let cliCfg: CliConfig = {};
  try {
    cliCfg = loadCliConfig();
  } catch {
    // A corrupt cli-config.json must not break project commands; the agent
    // commands that write it report the problem instead.
  }
  if (cliCfg.sqlitePath) {
    return cliCfg.sqlitePath;
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    const parent = join(process.env.APPDATA, '@joy-media', 'desktop');
    try {
      mkdirSync(parent, { recursive: true, mode: PRIVATE_DIR_MODE });
    } catch {
      // Keep the path stable; opening the database reports a structured error
      // if this Windows profile cannot create or access its default directory.
    }
    return join(parent, 'joy-media.sqlite3');
  }
  return join(getJoyMediaDir(), 'joy-media.sqlite3');
}
