/* global process */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CliConfig {
  activeProvider?: string;
  defaultModel?: string;
  customBaseUrl?: string;
  sqlitePath?: string;
}

export interface AiProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
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

export function loadAiProviders(): Record<string, AiProviderConfig> {
  const path = getAiProvidersPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as Record<string, AiProviderConfig>;
  } catch {
    return {};
  }
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
