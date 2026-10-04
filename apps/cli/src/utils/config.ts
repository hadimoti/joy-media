/* global process */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  chmodPrivate,
  deleteProtectedSecret,
  migrateLegacySecret,
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
  joySession?: {
    readonly token: ProtectedSecret;
    readonly email?: string;
    readonly expiresAt?: string;
    readonly apiOrigin?: string;
  };
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

const JOY_SESSION_ACCOUNT = 'joy-media-session';

export interface JoySessionConfig {
  readonly token: string;
  readonly email?: string;
  readonly expiresAt?: string;
  /** Origin of the API that issued this token. Missing legacy values mean joyst.ir. */
  readonly apiOrigin?: string;
}

export function saveJoySession(session: JoySessionConfig, insecureFileStore = false): void {
  const config = loadCliConfig();
  const protectedToken = protectSecret(session.token, JOY_SESSION_ACCOUNT, { insecureFileStore });
  config.joySession = {
    token: protectedToken,
    ...(session.email === undefined ? {} : { email: session.email }),
    ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
    ...(session.apiOrigin === undefined ? {} : { apiOrigin: new URL(session.apiOrigin).origin }),
  };
  saveCliConfig(config);
}

export function loadJoySession(): JoySessionConfig | undefined {
  const stored = loadCliConfig().joySession;
  if (!stored) return undefined;
  try {
    return {
      token: unprotectSecret(stored.token),
      ...(stored.email === undefined ? {} : { email: stored.email }),
      ...(stored.expiresAt === undefined ? {} : { expiresAt: stored.expiresAt }),
      apiOrigin: stored.apiOrigin ?? 'https://joyst.ir',
    };
  } catch {
    return undefined;
  }
}

export function clearJoySession(): boolean {
  const config = loadCliConfig();
  const stored = config.joySession;
  if (!stored) return false;
  if (
    (stored.token.scheme === 'keychain' || stored.token.scheme === 'libsecret') &&
    !deleteProtectedSecret(stored.token)
  ) {
    throw new Error('Unable to remove the JOY session token from the system keyring.');
  }
  delete config.joySession;
  saveCliConfig(config);
  return true;
}

export function loadAiProviders(): Record<string, AiProviderConfig> {
  const path = getAiProvidersPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    const providers = JSON.parse(raw) as Record<string, AiProviderConfig>;
    let migrated = false;
    for (const [name, provider] of Object.entries(providers)) {
      if (provider.apiKeyEnv && provider.apiKey) {
        delete provider.apiKey;
        migrated = true;
      } else if (provider.apiKey) {
        const protectedKey = migrateLegacySecret(provider.apiKey, name);
        if (!protectedKey) continue;
        provider.apiKeyProtected = protectedKey;
        delete provider.apiKey;
        migrated = true;
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
