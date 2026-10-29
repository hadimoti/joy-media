import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDpapiProtector, type SecretProtector } from './dpapi-protector.js';
import {
  createCredentialStore,
  CredentialStoreVersionError,
  CredentialUnavailableError,
  migrateProviderFile,
  type ProviderCredential,
} from './credential-store.js';

/** A reversible stand-in for DPAPI. The value is hidden in the file, so a test can prove it is not stored in clear. */
const testProtector: SecretProtector = {
  name: 'test-protector',
  protect: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
  unprotect: (cipher) => {
    if (!cipher.startsWith('enc:')) throw new Error('not protected');
    return Buffer.from(cipher.slice(4), 'base64').toString('utf8');
  },
};

const OPENROUTER: ProviderCredential = {
  apiKey: 'sk-or-test-0001',
  baseUrl: 'https://openrouter.ai/api/v1',
  defaultModel: 'openrouter/auto',
};
const CUSTOM: ProviderCredential = {
  apiKey: 'local-key-0002',
  baseUrl: 'http://127.0.0.1:1234/v1',
  defaultModel: 'local-model',
};

let dir = '';
let storePath = '';
let providersPath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'joy-credentials-'));
  storePath = join(dir, 'credentials.json');
  providersPath = join(dir, 'ai-providers.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeProviders(providers: Record<string, unknown>): void {
  writeFileSync(providersPath, JSON.stringify(providers, null, 2));
}

function readProviders(): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(providersPath, 'utf8')) as Record<string, Record<string, unknown>>;
}

describe('credential store', () => {
  it('stores a credential encrypted and reads it back exactly', () => {
    const store = createCredentialStore({ path: storePath, protector: testProtector });
    store.save('openrouter', OPENROUTER);

    expect(store.read('openrouter')).toEqual(OPENROUTER);
    expect(store.list()).toEqual(['openrouter']);
    expect(readFileSync(storePath, 'utf8')).not.toContain(OPENROUTER.apiKey);
  });

  it('refuses a save whose value does not read back as the same credential', () => {
    const lying: SecretProtector = {
      ...testProtector,
      unprotect: () => JSON.stringify({ ...OPENROUTER, apiKey: 'a-different-key' }),
    };
    const store = createCredentialStore({ path: storePath, protector: lying });

    expect(() => store.save('openrouter', OPENROUTER)).toThrow(CredentialUnavailableError);
  });

  it('refuses a newer store format and leaves the file exactly as it was', () => {
    writeFileSync(
      storePath,
      JSON.stringify({ version: 2, protector: 'test-protector', entries: {} }),
    );
    const before = readFileSync(storePath, 'utf8');
    const store = createCredentialStore({ path: storePath, protector: testProtector });

    expect(() => store.list()).toThrow(CredentialStoreVersionError);
    expect(readFileSync(storePath, 'utf8')).toBe(before);
  });

  it('refuses a store that another protector wrote', () => {
    const other = createCredentialStore({ path: storePath, protector: testProtector });
    other.save('openrouter', OPENROUTER);
    const restricted = createCredentialStore({
      path: storePath,
      protector: { ...testProtector, name: 'restricted-file' },
    });

    expect(() => restricted.read('openrouter')).toThrow(CredentialUnavailableError);
  });
});

describe('provider migration', () => {
  it('moves each plaintext key, keeps its metadata, and keeps legacy profiles disabled', () => {
    writeProviders({
      openrouter: { ...OPENROUTER },
      custom: { ...CUSTOM },
      kilo: { apiKey: 'kilo-legacy' },
    });
    const store = createCredentialStore({ path: storePath, protector: testProtector });

    const outcome = migrateProviderFile({ providersPath, store });

    expect([...outcome.moved].sort()).toEqual(['custom', 'openrouter']);
    expect(outcome.disabled).toEqual(['kilo']);
    expect(outcome.unavailable).toEqual([]);
    expect(store.read('openrouter')).toEqual(OPENROUTER);
    expect(store.read('custom')).toEqual(CUSTOM);
    const remaining = readProviders();
    expect(remaining.openrouter).toEqual({
      baseUrl: OPENROUTER.baseUrl,
      defaultModel: OPENROUTER.defaultModel,
    });
    expect(remaining.custom).not.toHaveProperty('apiKey');
    expect(remaining.kilo).toEqual({ apiKey: 'kilo-legacy' });
    expect(readFileSync(storePath, 'utf8')).not.toContain(OPENROUTER.apiKey);
  });

  it('an interrupted migration keeps the plaintext key, and the next run completes it', () => {
    writeProviders({ openrouter: { ...OPENROUTER } });
    const store = createCredentialStore({ path: storePath, protector: testProtector });

    const interrupted = migrateProviderFile({
      providersPath,
      store,
      beforeRemove: () => {
        throw new Error('simulated crash after the store write');
      },
    });
    expect(interrupted.unavailable).toEqual(['openrouter']);
    expect(store.read('openrouter')).toEqual(OPENROUTER);
    expect(readProviders().openrouter).toHaveProperty('apiKey', OPENROUTER.apiKey);

    const completed = migrateProviderFile({ providersPath, store });
    expect(completed.moved).toEqual(['openrouter']);
    expect(readProviders().openrouter).not.toHaveProperty('apiKey');
    expect(store.read('openrouter')).toEqual(OPENROUTER);
  });

  it('running the migration twice changes nothing the second time', () => {
    writeProviders({ openrouter: { ...OPENROUTER } });
    const store = createCredentialStore({ path: storePath, protector: testProtector });
    migrateProviderFile({ providersPath, store });
    const storeAfterFirst = readFileSync(storePath, 'utf8');
    const providersAfterFirst = readFileSync(providersPath, 'utf8');

    const second = migrateProviderFile({ providersPath, store });

    expect(second).toEqual({ moved: [], disabled: [], unavailable: [] });
    expect(readFileSync(storePath, 'utf8')).toBe(storeAfterFirst);
    expect(readFileSync(providersPath, 'utf8')).toBe(providersAfterFirst);
    expect(store.list()).toEqual(['openrouter']);
  });

  it('a protector failure keeps the plaintext key and reports it unavailable', () => {
    writeProviders({ openrouter: { ...OPENROUTER } });
    const failing: SecretProtector = {
      ...testProtector,
      protect: () => {
        throw new Error('DPAPI is unavailable');
      },
    };
    const store = createCredentialStore({ path: storePath, protector: failing });

    const outcome = migrateProviderFile({ providersPath, store });

    expect(outcome.unavailable).toEqual(['openrouter']);
    expect(outcome.moved).toEqual([]);
    expect(readProviders()).toEqual({ openrouter: { ...OPENROUTER } });
    expect(existsSync(storePath)).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'the Windows DPAPI protector round-trips a secret and never writes it in clear',
    () => {
      const protector = createDpapiProtector();
      const cipher = protector.protect(OPENROUTER.apiKey);

      expect(cipher).not.toContain(OPENROUTER.apiKey);
      expect(protector.unprotect(cipher)).toBe(OPENROUTER.apiKey);
    },
    60_000,
  );
});
