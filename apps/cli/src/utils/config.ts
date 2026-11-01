/* global process */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
  const dir = join(homedir(), '.joy-media');
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
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock);
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
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // Already gone.
    }
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
  const update = withConfigLock(() => {
    const providers = loadAiProviderMetadata();
    const result = mutate(providers);
    saveAiProviderMetadata(providers);
    return { result, after: { ...providers } };
  });
  for (const [name, entry] of Object.entries(update.after)) saveProviderCredential(name, entry);
  return update.result;
}

export function hasAiProvider(providers: Record<string, AiProviderConfig>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(providers, name);
}

export function setAiProvider(name: string, config: AiProviderConfig): void {
  updateAiProviders((providers) => {
    providers[name] = config;
  });
}

export function deleteAiProvider(name: string): boolean {
  const removed = withConfigLock(() => {
    const providers = loadAiProviderMetadata();
    if (!hasAiProvider(providers, name)) return false;
    delete providers[name];
    saveAiProviderMetadata(providers);
    return true;
  });
  // The key leaves the store too. The store file is not created just to forget a key.
  if (removed && existsSync(join(getJoyMediaDir(), 'credentials.json'))) {
    openCredentialStore().remove(name);
  }
  return removed;
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
