import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Deliberately non-secret settings persisted by the companion. */
export interface DesktopConfig {
  readonly apiUrl: string;
  readonly workerStatePath?: string;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly localAssetsJson?: string;
}

export const DEFAULT_CONFIG: DesktopConfig = { apiUrl: '' };

const ALLOWED_KEYS = new Set<keyof DesktopConfig>([
  'apiUrl',
  'workerStatePath',
  'ffmpegPath',
  'ffprobePath',
  'localAssetsJson',
]);

export function configPath(userDataPath: string): string {
  return join(userDataPath, 'config.json');
}

export function loadConfig(path: string): DesktopConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return DEFAULT_CONFIG;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_CONFIG;
  const raw = parsed as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !ALLOWED_KEYS.has(key as keyof DesktopConfig)))
    return DEFAULT_CONFIG;
  const apiUrl = raw.apiUrl;
  if (typeof apiUrl !== 'string' || !isSafeApiUrl(apiUrl)) return DEFAULT_CONFIG;
  const result: DesktopConfig = { apiUrl };
  for (const key of ['workerStatePath', 'ffmpegPath', 'ffprobePath', 'localAssetsJson'] as const) {
    const value = raw[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length > 4_000) return DEFAULT_CONFIG;
      (result as unknown as Record<string, string>)[key] = value;
    }
  }
  return result;
}

export function saveConfig(path: string, config: DesktopConfig): void {
  if (!isSafeApiUrl(config.apiUrl))
    throw new Error('apiUrl must be an HTTP(S) URL without credentials');
  const sanitized = {
    apiUrl: config.apiUrl,
    ...(config.workerStatePath === undefined ? {} : { workerStatePath: config.workerStatePath }),
    ...(config.ffmpegPath === undefined ? {} : { ffmpegPath: config.ffmpegPath }),
    ...(config.ffprobePath === undefined ? {} : { ffprobePath: config.ffprobePath }),
    ...(config.localAssetsJson === undefined ? {} : { localAssetsJson: config.localAssetsJson }),
  };
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, JSON.stringify(sanitized, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

export function isSafeApiUrl(value: string): boolean {
  if (value.trim() === '') return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}
