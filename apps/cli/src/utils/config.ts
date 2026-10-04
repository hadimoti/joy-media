/* global process */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  chmodPrivate,
  deleteProtectedSecret,
  protectSecret,
  unprotectSecret,
  type ProtectedSecret,
} from './secret-store.js';

export interface CliConfig {
  activeProvider?: string | undefined;
  defaultModels?: Record<string, string> | undefined;
  /** Legacy single-provider value, migrated by loadCliConfig. */
  defaultModel?: string | undefined;
  customBaseUrl?: string | undefined;
  sqlitePath?: string | undefined;
}

export interface AiProviderConfig {
  name?: string | undefined;
  provider?: string | undefined;
  apiKey?: string | undefined;
  apiKeyEnv?: string | undefined;
  apiKeyProtected?: ProtectedSecret | undefined;
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
    const config = JSON.parse(raw) as CliConfig;
    if (!config.defaultModel) return config;
    const provider = config.activeProvider ?? 'openai';
    const migrated: CliConfig = {
      ...config,
      defaultModels: {
        ...(config.defaultModels ?? {}),
        [provider]: config.defaultModels?.[provider] ?? config.defaultModel,
      },
    };
    delete migrated.defaultModel;
    saveCliConfig(migrated);
    return migrated;
  } catch {
    return {};
  }
}

export function saveCliConfig(config: CliConfig): void {
  const path = getCliConfigPath();
  writeFileSync(path, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  chmodPrivate(path);
}

export function loadAiProviders(): Record<string, AiProviderConfig> {
  const path = getAiProvidersPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    const providers = JSON.parse(raw) as Record<string, AiProviderConfig>;
    let migrated = false;
    for (const [name, provider] of Object.entries(providers)) {
      if (
        provider.apiKeyEnv &&
        (provider.apiKey || provider.apiKeyProtected?.scheme === 'file-0600')
      ) {
        delete provider.apiKey;
        if (provider.apiKeyProtected?.scheme === 'file-0600') delete provider.apiKeyProtected;
        migrated = true;
      } else if (provider.apiKey || provider.apiKeyProtected?.scheme === 'file-0600') {
        const oldSecret = provider.apiKey ?? provider.apiKeyProtected?.data;
        if (!oldSecret) continue;
        try {
          const protectedKey = protectSecret(oldSecret, name);
          if (protectedKey.scheme === 'file-0600' || unprotectSecret(protectedKey) !== oldSecret)
            continue;
          provider.apiKeyProtected = protectedKey;
          delete provider.apiKey;
          migrated = true;
        } catch {
          // Keep the legacy value intact until a keyring can verify a safe migration.
        }
      }
    }
    if (migrated) {
      console.info('Migrated saved provider credentials to protected storage.');
      saveAiProviders(providers);
    }
    return providers;
  } catch {
    return {};
  }
}

export function saveAiProviders(providers: Record<string, AiProviderConfig>): void {
  const path = getAiProvidersPath();
  writeFileSync(path, JSON.stringify(providers, null, 2), { encoding: 'utf8', mode: 0o600 });
  chmodPrivate(path);
}

export function setAiProvider(name: string, config: AiProviderConfig): void {
  const providers = loadAiProviders();
  providers[name] = config;
  saveAiProviders(providers);
}

export function deleteAiProvider(name: string): boolean {
  const providers = loadAiProviders();
  if (name in providers) {
    const savedSecret = providers[name]?.apiKeyProtected;
    if (
      savedSecret &&
      (savedSecret.scheme === 'keychain' || savedSecret.scheme === 'libsecret') &&
      !deleteProtectedSecret(savedSecret)
    ) {
      throw new Error(
        'Unable to remove the API key from the system keyring; provider was not deleted.',
      );
    }
    delete providers[name];
    saveAiProviders(providers);
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
