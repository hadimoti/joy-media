import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  decodeKimiTokenRecord,
  decodeTokenRecord,
  decodeXaiTokenRecord,
  isRecord,
  type ChatGptTokenRecord,
  type KimiTokenRecord,
  type XaiTokenRecord,
} from '@joy-media/provider-oauth';
import type { SecretProtector } from './dpapi-protector.js';

/** The store format this build reads and writes. A newer format is refused and never rewritten. */
export const CREDENTIAL_STORE_VERSION = 2;

/** Legacy profiles the migration never moves. They stay listed as disabled (PLAN-v4 §9a). */
export const LEGACY_DISABLED_PROVIDERS: ReadonlySet<string> = new Set(['kilo', 'joy-hosted']);

/** The secret for one provider. The base URL and the model are not secret, but they travel with it. */
export interface ProviderCredential {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
}

/** OAuth records are provider-tagged and checked by the shared flow decoders. */
export type OAuthCredential =
  | { readonly provider: 'chatgpt'; readonly tokenRecord: ChatGptTokenRecord }
  | { readonly provider: 'kimi'; readonly tokenRecord: KimiTokenRecord }
  | { readonly provider: 'xai'; readonly tokenRecord: XaiTokenRecord };

export type StoredCredential = ProviderCredential | OAuthCredential;

interface StoreEntry {
  readonly ciphertext: string;
}

interface StoreFileV1 {
  readonly version: 1;
  readonly protector: string;
  readonly entries: Record<string, StoreEntry>;
}

interface StoreFileV2 {
  readonly version: 2;
  readonly protector: string;
  readonly entries: Record<string, StoreEntry>;
}

type StoreFile = StoreFileV1 | StoreFileV2;

export class CredentialStoreVersionError extends Error {
  constructor(readonly version: unknown) {
    super(`The credential store uses format ${String(version)}, which this build does not read.`);
    this.name = 'CredentialStoreVersionError';
  }
}

/** The protector could not read an entry, or the store could not confirm a write. No value is shown. */
export class CredentialUnavailableError extends Error {
  constructor(name: string, reason: string) {
    super(`Credential "${name}" is unavailable: ${reason}`);
    this.name = 'CredentialUnavailableError';
  }
}

export interface CredentialStore {
  list(): readonly string[];
  read(name: string): StoredCredential | undefined;
  /** Encrypts and verifies the credential before atomically replacing the store. */
  save(name: string, credential: StoredCredential): void;
  remove(name: string): void;
}

function emptyFile(protector: SecretProtector): StoreFile {
  return { version: CREDENTIAL_STORE_VERSION, protector: protector.name, entries: {} };
}

function sameCredential(left: StoredCredential, right: StoredCredential): boolean {
  if ('apiKey' in left && 'apiKey' in right) {
    return (
      left.apiKey === right.apiKey &&
      left.baseUrl === right.baseUrl &&
      left.defaultModel === right.defaultModel
    );
  }
  if ('provider' in left && 'provider' in right) {
    return (
      left.provider === right.provider &&
      JSON.stringify(left.tokenRecord) === JSON.stringify(right.tokenRecord)
    );
  }
  return false;
}

/** Reads a value as a credential, or returns undefined when it carries no API key (metadata only). */
export function parseCredential(value: unknown): ProviderCredential | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.apiKey !== 'string' || record.apiKey.length === 0) return undefined;
  return {
    apiKey: record.apiKey,
    ...(typeof record.baseUrl === 'string' ? { baseUrl: record.baseUrl } : {}),
    ...(typeof record.defaultModel === 'string' ? { defaultModel: record.defaultModel } : {}),
  };
}

/** A provider tag is accepted only when its provider-specific decoder accepts the record (D22 step 3 design, §5). */
function parseOAuthCredential(value: Record<string, unknown>): OAuthCredential | undefined {
  if (!('tokenRecord' in value)) return undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value.tokenRecord);
  } catch {
    return undefined;
  }
  if (serialized === undefined) return undefined;

  switch (value.provider) {
    case 'chatgpt': {
      const tokenRecord = decodeTokenRecord(serialized);
      return tokenRecord === undefined ? undefined : { provider: 'chatgpt', tokenRecord };
    }
    case 'kimi': {
      const tokenRecord = decodeKimiTokenRecord(serialized);
      return tokenRecord === undefined ? undefined : { provider: 'kimi', tokenRecord };
    }
    case 'xai': {
      const tokenRecord = decodeXaiTokenRecord(serialized);
      return tokenRecord === undefined ? undefined : { provider: 'xai', tokenRecord };
    }
    default:
      return undefined;
  }
}

function parseStoredCredential(value: unknown): StoredCredential | undefined {
  if (isRecord(value) && typeof value.provider === 'string' && 'tokenRecord' in value) {
    return parseOAuthCredential(value);
  }
  return parseCredential(value);
}

/** A MiniMax-tagged token record belongs to the OAuth route removed by D23. */
function isRemovedMiniMaxOAuthCredential(value: unknown): boolean {
  return isRecord(value) && value.provider === 'minimax' && 'tokenRecord' in value;
}

/**
 * The CLI credential store (PLAN-v4 §6b): one encrypted entry per provider name, in a JSON file that holds
 * no plaintext key. The file is written atomically, and it is refused when its format is newer, or when a
 * different protector wrote it.
 */
export function createCredentialStore(options: {
  readonly path: string;
  readonly protector: SecretProtector;
}): CredentialStore {
  const { path, protector } = options;

  function load(): StoreFile {
    if (!existsSync(path)) return emptyFile(protector);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoreFile>;
    if (parsed.version !== 1 && parsed.version !== CREDENTIAL_STORE_VERSION) {
      throw new CredentialStoreVersionError(parsed.version);
    }
    if (parsed.protector !== protector.name) {
      throw new CredentialUnavailableError(
        '(store)',
        `it was written with the ${String(parsed.protector)} protector, not ${protector.name}`,
      );
    }
    return { version: parsed.version, protector: parsed.protector, entries: parsed.entries ?? {} };
  }

  function write(file: StoreFile): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  function decrypt(name: string, ciphertext: string, version: 1 | 2): StoredCredential {
    let plain: string;
    try {
      plain = protector.unprotect(ciphertext);
    } catch {
      throw new CredentialUnavailableError(name, 'the protector could not decrypt it');
    }
    let value: unknown;
    try {
      value = JSON.parse(plain);
    } catch {
      throw new CredentialUnavailableError(name, 'the stored value is malformed');
    }
    if (version === 2 && isRemovedMiniMaxOAuthCredential(value)) {
      throw new CredentialUnavailableError(
        name,
        'this profile used MiniMax OAuth, which was removed by D23; add a MiniMax API key',
      );
    }
    let credential: StoredCredential | undefined;
    try {
      credential = version === 1 ? parseCredential(value) : parseStoredCredential(value);
    } catch {
      throw new CredentialUnavailableError(name, 'the stored value is malformed');
    }
    if (credential === undefined)
      throw new CredentialUnavailableError(name, 'the stored value is malformed');
    return credential;
  }

  function encryptAndVerify(name: string, credential: StoredCredential): StoreEntry {
    const normalized = parseStoredCredential(credential);
    if (normalized === undefined) {
      throw new CredentialUnavailableError(name, 'the credential is malformed');
    }
    let ciphertext: string;
    try {
      ciphertext = protector.protect(JSON.stringify(normalized));
    } catch {
      throw new CredentialUnavailableError(name, 'the protector could not encrypt it');
    }
    const back = decrypt(name, ciphertext, 2);
    if (!sameCredential(back, normalized)) {
      throw new CredentialUnavailableError(
        name,
        'the value read back did not match the value saved',
      );
    }
    return { ciphertext };
  }

  function convertVersionOneEntries(file: StoreFileV1): Record<string, StoreEntry> {
    const entries = Object.create(null) as Record<string, StoreEntry>;
    for (const [name, entry] of Object.entries(file.entries)) {
      entries[name] = encryptAndVerify(name, decrypt(name, entry.ciphertext, 1));
    }
    return entries;
  }

  return {
    list: () => Object.keys(load().entries),
    read(name) {
      const file = load();
      const entry = file.entries[name];
      return entry === undefined ? undefined : decrypt(name, entry.ciphertext, file.version);
    },
    save(name, credential) {
      const file = load();
      if (file.version === 1) {
        const entries = convertVersionOneEntries(file);
        entries[name] = encryptAndVerify(name, credential);
        write({ version: 2, protector: file.protector, entries });
        return;
      }
      const entries = { ...file.entries, [name]: encryptAndVerify(name, credential) };
      write({ ...file, entries });
    },
    remove(name) {
      const file = load();
      if (file.version === 1) {
        const entries = convertVersionOneEntries(file);
        delete entries[name];
        write({ version: 2, protector: file.protector, entries });
        return;
      }
      const { [name]: _removed, ...rest } = file.entries;
      write({ ...file, entries: rest });
    },
  };
}

export interface MigrationOutcome {
  /** Keys now held encrypted, and removed from the plaintext file after the read-back. */
  readonly moved: readonly string[];
  /** Legacy profiles that remain listed as disabled. */
  readonly disabled: readonly string[];
  /** Keys that stay in the plaintext file, because the store could not confirm them. */
  readonly unavailable: readonly string[];
}

function readPlaintextProviders(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function writePlaintextProviders(path: string, providers: Record<string, unknown>): void {
  if (Object.keys(providers).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(providers, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporary, path);
}

/**
 * Moves each plaintext API key into the store (PLAN-v4 §6b, §9a). The key leaves the plaintext file only
 * after the store has read it back. The non-secret fields stay in the file. Running the migration again is
 * safe, and a failure on one entry leaves that entry in place and does not stop the rest.
 */
export function migrateProviderFile(options: {
  readonly providersPath: string;
  readonly store: CredentialStore;
  /** Test seam: called after a key is saved and before its plaintext copy is removed. */
  readonly beforeRemove?: (name: string) => void;
}): MigrationOutcome {
  const moved: string[] = [];
  const disabled: string[] = [];
  const unavailable: string[] = [];
  const providers = readPlaintextProviders(options.providersPath);
  const remaining: Record<string, unknown> = { ...providers };

  for (const [name, value] of Object.entries(providers)) {
    if (LEGACY_DISABLED_PROVIDERS.has(name)) {
      disabled.push(name);
      continue;
    }
    const credential = parseCredential(value);
    if (credential === undefined) continue; // metadata only: nothing secret to move
    try {
      options.store.save(name, credential);
      options.beforeRemove?.(name);
      const { apiKey: _apiKey, ...metadata } = value as Record<string, unknown>;
      if (Object.keys(metadata).length === 0) delete remaining[name];
      else remaining[name] = metadata;
      writePlaintextProviders(options.providersPath, remaining);
      moved.push(name);
    } catch {
      unavailable.push(name);
    }
  }
  return { moved, disabled, unavailable };
}
