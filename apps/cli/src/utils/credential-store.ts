import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { SecretProtector } from './dpapi-protector.js';

/** The store format this build reads and writes. A newer format is refused and never rewritten. */
export const CREDENTIAL_STORE_VERSION = 1;

/** Legacy profiles the migration never moves. They stay listed as disabled (PLAN-v4 §9a). */
export const LEGACY_DISABLED_PROVIDERS: ReadonlySet<string> = new Set(['kilo', 'joy-hosted']);

/** The secret for one provider. The base URL and the model are not secret, but they travel with it. */
export interface ProviderCredential {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
}

interface StoreFile {
  readonly version: number;
  readonly protector: string;
  readonly entries: Record<string, { readonly ciphertext: string }>;
}

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
  read(name: string): ProviderCredential | undefined;
  /** Encrypts the credential, writes the store, then reads it back and checks it before returning. */
  save(name: string, credential: ProviderCredential): void;
  remove(name: string): void;
}

function emptyFile(protector: SecretProtector): StoreFile {
  return { version: CREDENTIAL_STORE_VERSION, protector: protector.name, entries: {} };
}

function sameCredential(left: ProviderCredential, right: ProviderCredential): boolean {
  return (
    left.apiKey === right.apiKey &&
    left.baseUrl === right.baseUrl &&
    left.defaultModel === right.defaultModel
  );
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
    if (parsed.version !== CREDENTIAL_STORE_VERSION) {
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
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporary, path);
  }

  function decrypt(name: string, ciphertext: string): ProviderCredential {
    let plain: string;
    try {
      plain = protector.unprotect(ciphertext);
    } catch {
      throw new CredentialUnavailableError(name, 'the protector could not decrypt it');
    }
    const credential = parseCredential(JSON.parse(plain));
    if (credential === undefined)
      throw new CredentialUnavailableError(name, 'the stored value is malformed');
    return credential;
  }

  return {
    list: () => Object.keys(load().entries),
    read(name) {
      const entry = load().entries[name];
      return entry === undefined ? undefined : decrypt(name, entry.ciphertext);
    },
    save(name, credential) {
      const file = load();
      let ciphertext: string;
      try {
        ciphertext = protector.protect(JSON.stringify(credential));
      } catch {
        throw new CredentialUnavailableError(name, 'the protector could not encrypt it');
      }
      write({ ...file, entries: { ...file.entries, [name]: { ciphertext } } });
      // A save counts only when the stored value reads back as the same credential.
      const back = decrypt(name, ciphertext);
      if (!sameCredential(back, credential)) {
        throw new CredentialUnavailableError(
          name,
          'the value read back did not match the value saved',
        );
      }
    },
    remove(name) {
      const file = load();
      const { [name]: _removed, ...rest } = file.entries;
      write({ ...file, entries: rest });
    },
  };
}

export interface MigrationOutcome {
  /** Keys now held encrypted, and removed from the plaintext file after the read-back. */
  readonly moved: readonly string[];
  /** Legacy profiles that stay where they are, shown as disabled. */
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
