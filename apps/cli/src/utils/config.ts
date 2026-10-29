/* global process */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  /** The two agent slots (PLAN-v4 §6d-1). A slot that is not saved is empty. */
  agentSlots?: Partial<Record<'workhorse' | 'creative', SavedAgentSlot>> | undefined;
}

export interface AiProviderConfig {
  /** The public endpoint the owner consented to, as origin and base path (S8). A changed endpoint needs consent again. */
  endpointConsent?: string | undefined;
  name?: string | undefined;
  provider?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  defaultModel?: string | undefined;
  cachedModels?: string[] | undefined;
}

export function getJoyMediaDir(): string {
  const dir = join(homedir(), '.joy-media');
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
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

export function loadCliConfig(): CliConfig {
  const path = getCliConfigPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as CliConfig;
  } catch {
    return {};
  }
}

export function saveCliConfig(config: CliConfig): void {
  const path = getCliConfigPath();
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
}

/** The CLI credential store, opened with the protector for this platform (PLAN-v4 §6b). */
export function openCredentialStore(): CredentialStore {
  return createCredentialStore({
    path: join(getJoyMediaDir(), 'credentials.json'),
    protector:
      process.platform === 'win32' ? createDpapiProtector() : createRestrictedFileProtector(),
  });
}

/**
 * Moves any plaintext API key from ai-providers.json into the credential store (PLAN-v4 §6b, §9a). It does
 * nothing when the file is absent, so an ordinary start pays no cost.
 */
export function migrateLegacyProviders(): void {
  const path = getAiProvidersPath();
  if (!existsSync(path)) return;
  migrateProviderFile({ providersPath: path, store: openCredentialStore() });
}

/**
 * The providers, with each API key read from the credential store. ai-providers.json holds only the
 * non-secret fields. A key that cannot be read is left out, and nothing is written back.
 */
export function loadAiProviders(): Record<string, AiProviderConfig> {
  const path = getAiProvidersPath();
  if (!existsSync(path)) return {};
  let providers: Record<string, AiProviderConfig>;
  try {
    providers = JSON.parse(readFileSync(path, 'utf8')) as Record<string, AiProviderConfig>;
  } catch {
    return {};
  }
  let store: CredentialStore | undefined;
  for (const [name, entry] of Object.entries(providers)) {
    if (entry.apiKey !== undefined) continue;
    store ??= openCredentialStore();
    try {
      const credential = store.read(name);
      if (credential !== undefined) {
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

/** Writes the non-secret fields to ai-providers.json. Each API key goes to the credential store instead. */
export function saveAiProviders(providers: Record<string, AiProviderConfig>): void {
  const path = getAiProvidersPath();
  const store = openCredentialStore();
  const metadata: Record<string, AiProviderConfig> = {};
  for (const [name, entry] of Object.entries(providers)) {
    const { apiKey, ...rest } = entry;
    if (apiKey !== undefined && apiKey.length > 0) {
      store.save(name, {
        apiKey,
        ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
        ...(entry.defaultModel === undefined ? {} : { defaultModel: entry.defaultModel }),
      });
    }
    metadata[name] = rest;
  }
  writeFileSync(path, JSON.stringify(metadata, null, 2), 'utf8');
}

export function setAiProvider(name: string, config: AiProviderConfig): void {
  const providers = loadAiProviders();
  providers[name] = config;
  saveAiProviders(providers);
}

export function deleteAiProvider(name: string): boolean {
  const providers = loadAiProviders();
  if (name in providers) {
    delete providers[name];
    saveAiProviders(providers);
    // The key leaves the store too. The store file is not created just to forget a key.
    if (existsSync(join(getJoyMediaDir(), 'credentials.json'))) openCredentialStore().remove(name);
    return true;
  }
  return false;
}

export function getDefaultSqlitePath(): string {
  if (process.env.JOY_MEDIA_SQLITE_PATH) {
    return process.env.JOY_MEDIA_SQLITE_PATH;
  }
  const cliCfg = loadCliConfig();
  if (cliCfg.sqlitePath) {
    return cliCfg.sqlitePath;
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, '@joy-media', 'desktop', 'joy-media.sqlite3');
  }
  return join(getJoyMediaDir(), 'joy-media.sqlite3');
}
