/* global process */
import { spawnSync } from 'node:child_process';
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
import { join, win32 } from 'node:path';

export interface CliConfig {
  activeProvider?: string | undefined;
  defaultModel?: string | undefined;
  customBaseUrl?: string | undefined;
  sqlitePath?: string | undefined;
}

export interface AiProviderConfig {
  name?: string | undefined;
  provider?: string | undefined;
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
const securedWindowsPaths = new Set<string>();
let windowsUserSid: string | undefined;

export function resolveWindowsSystemExecutablePath(
  executableName: 'whoami.exe' | 'icacls.exe' | 'powershell.exe',
  systemRoot = process.env.SystemRoot ?? process.env.WINDIR,
): string {
  if (!systemRoot || !win32.isAbsolute(systemRoot)) {
    throw new Error(
      'Could not determine an absolute Windows system root to protect JOY Media secrets.',
    );
  }
  if (executableName === 'powershell.exe') {
    return win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', executableName);
  }
  return win32.join(systemRoot, 'System32', executableName);
}

function currentWindowsUserSid(): string {
  if (windowsUserSid) return windowsUserSid;
  const result = spawnSync(
    resolveWindowsSystemExecutablePath('whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    },
  );
  const sid = result.stdout?.match(/S-1-[0-9-]+/)?.[0];
  if (result.error || result.status !== 0 || !sid) {
    throw new Error(
      'Could not determine the current Windows user SID to protect JOY Media secrets.',
    );
  }
  windowsUserSid = sid;
  return sid;
}

function runWindowsAcl(path: string, args: string[]): void {
  const result = spawnSync(resolveWindowsSystemExecutablePath('icacls.exe'), [path, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not secure JOY Media configuration permissions for ${path}.`);
  }
}

const BROAD_WINDOWS_SIDS = ['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545'];

interface WindowsDirectoryAclRule {
  sid: string;
  type: 'Allow' | 'Deny';
  fullControl: boolean;
  inheritOnly: boolean;
}

interface WindowsDirectoryAcl {
  protected: boolean;
  rules: WindowsDirectoryAclRule[];
}

/** Read-only query of inheritance protection and every explicit or inherited SID access rule. */
function windowsDirectoryAcl(path: string): WindowsDirectoryAcl | undefined {
  const pathBase64 = Buffer.from(path, 'utf8').toString('base64');
  const script = [
    `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathBase64}'))`,
    '$acl = [IO.Directory]::GetAccessControl($path)',
    '$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); fullControl = (($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl); inheritOnly = (($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq [Security.AccessControl.PropagationFlags]::InheritOnly) } })',
    '[pscustomobject]@{ protected = [bool]$acl.AreAccessRulesProtected; rules = @($rules) } | ConvertTo-Json -Depth 4 -Compress',
  ].join('\n');
  const result = spawnSync(
    resolveWindowsSystemExecutablePath('powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
  );
  if (result.error || result.status !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.protected !== 'boolean' || !Array.isArray(candidate.rules)) {
      return undefined;
    }
    const rules: WindowsDirectoryAclRule[] = [];
    for (const rule of candidate.rules) {
      if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
        return undefined;
      }
      const entry = rule as Record<string, unknown>;
      if (
        typeof entry.sid !== 'string' ||
        (entry.type !== 'Allow' && entry.type !== 'Deny') ||
        typeof entry.fullControl !== 'boolean' ||
        typeof entry.inheritOnly !== 'boolean'
      ) {
        return undefined;
      }
      rules.push({
        sid: entry.sid,
        type: entry.type,
        fullControl: entry.fullControl,
        inheritOnly: entry.inheritOnly,
      });
    }
    return { protected: candidate.protected, rules };
  } catch {
    return undefined;
  }
}

/**
 * True only when inheritance is protected, no broad SID has an Allow rule,
 * SYSTEM, Administrators and the current user each have Allow full control,
 * and none of those required SIDs has a Deny rule. Unknown ACLs are not private.
 */
function windowsDirectoryIsPrivate(path: string, userSid: string): boolean {
  const acl = windowsDirectoryAcl(path);
  if (!acl || acl.protected !== true) return false;
  if (acl.rules.some((rule) => rule.type === 'Allow' && BROAD_WINDOWS_SIDS.includes(rule.sid))) {
    return false;
  }
  const requiredSids = ['S-1-5-18', 'S-1-5-32-544', userSid];
  if (
    requiredSids.some(
      (sid) =>
        !acl.rules.some(
          (rule) =>
            rule.sid === sid && rule.type === 'Allow' && rule.fullControl && !rule.inheritOnly,
        ),
    )
  ) {
    return false;
  }
  return !acl.rules.some((rule) => rule.type === 'Deny' && requiredSids.includes(rule.sid));
}

/** Where the CLI keeps its state. Pure: does not create the directory. */
export function joyMediaDirPath(): string {
  return join(homedir(), '.joy-media');
}

/**
 * Whether the path exists, or exists but this process cannot inspect it. A directory whose ACL
 * withholds read-attributes from the current user reports EPERM here, and existsSync would call
 * it missing and skip the repair that makes it private again.
 */
function pathExistsOrIsLocked(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EACCES';
  }
}

export function getJoyMediaDir(): string {
  const dir = joyMediaDirPath();
  if (!pathExistsOrIsLocked(dir)) {
    try {
      mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    } catch {
      // Ignore if cannot create
    }
  }
  if (pathExistsOrIsLocked(dir)) makePrivate(dir, PRIVATE_DIR_MODE, true);
  return dir;
}

export function getCliConfigPath(): string {
  return join(getJoyMediaDir(), 'cli-config.json');
}

export function getAiProvidersPath(): string {
  return join(getJoyMediaDir(), 'ai-providers.json');
}

/** Keep the secret-bearing config directory and files private on POSIX and Windows. */
function makePrivate(path: string, mode: number, directory = false): void {
  if (IS_POSIX) {
    try {
      if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, mode);
    } catch {
      // Best effort, as chmod may fail for a read-only or foreign-owned file.
    }
    return;
  }

  const normalizedPath = path.toLowerCase();
  if (securedWindowsPaths.has(normalizedPath)) return;

  const userSid = currentWindowsUserSid();
  // A directory's ACL change propagates into every existing descendant, so rewriting
  // an already-private directory disturbs unrelated files and, on a large profile,
  // can outrun the icacls timeout. Skip only when the existing ACL is private.
  if (directory && windowsDirectoryIsPrivate(path, userSid)) {
    securedWindowsPaths.add(normalizedPath);
    return;
  }
  const permission = directory ? '(OI)(CI)F' : 'F';
  // Add a private allow-list before removing inherited or explicit broad grants, so
  // tightening an old profile cannot lock out the current process halfway through.
  runWindowsAcl(path, [
    '/grant:r',
    `*${userSid}:${permission}`,
    `*S-1-5-18:${permission}`,
    `*S-1-5-32-544:${permission}`,
  ]);
  runWindowsAcl(path, ['/inheritance:r']);
  runWindowsAcl(path, ['/remove:g', '*S-1-1-0', '*S-1-5-11', '*S-1-5-32-545']);
  securedWindowsPaths.add(normalizedPath);
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
function withConfigLock<T>(fn: () => T): T {
  const lock = join(getJoyMediaDir(), '.config.lock');
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

/** @throws ConfigFileError when the file exists but is corrupt. */
export function loadCliConfig(): CliConfig {
  const path = getCliConfigPath();
  if (existsSync(path)) makePrivate(path, PRIVATE_FILE_MODE);
  return (readJsonObject(path) ?? {}) as CliConfig;
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

/**
 * Stored providers (with API keys), keyed by name, as a null-prototype map.
 * @throws ConfigFileError when the file exists but is corrupt.
 */
export function loadAiProviders(): Record<string, AiProviderConfig> {
  const path = getAiProvidersPath();
  if (existsSync(path)) makePrivate(path, PRIVATE_FILE_MODE);
  const providers = readJsonObject(path);
  if (providers === undefined) return Object.create(null) as Record<string, AiProviderConfig>;
  return providers as Record<string, AiProviderConfig>;
}

export function saveAiProviders(providers: Record<string, AiProviderConfig>): void {
  makePrivate(getJoyMediaDir(), PRIVATE_DIR_MODE, true);
  writeFileAtomic(
    getAiProvidersPath(),
    `${JSON.stringify({ ...providers }, null, 2)}\n`,
    PRIVATE_FILE_MODE,
  );
}

/** Locked read-modify-write of `ai-providers.json`. */
export function updateAiProviders<T>(
  mutate: (providers: Record<string, AiProviderConfig>) => T,
): T {
  return withConfigLock(() => {
    const providers = loadAiProviders();
    const result = mutate(providers);
    saveAiProviders(providers);
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

export function deleteAiProvider(name: string): boolean {
  return withConfigLock(() => {
    const providers = loadAiProviders();
    if (!hasAiProvider(providers, name)) return false;
    delete providers[name];
    saveAiProviders(providers);
    return true;
  });
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
