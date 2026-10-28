import { describe, expect, it } from 'vitest';
import type { SecretStore } from '@joy-media/provider-sdk';
import { LocalDatabase } from '../store/local-database.js';
import { checkProfileCredentials } from './profile-credential-check.js';

interface FakeSecrets {
  readonly keys: Map<string, string>;
  readonly broken: Set<string>;
  readonly store: SecretStore;
}

/** A secret store whose records can be removed or made to throw, as a DPAPI record can be. */
function fakeSecrets(): FakeSecrets {
  const keys = new Map<string, string>();
  const broken = new Set<string>();
  const store = {
    get: async (handle: string) => {
      if (broken.has(handle)) throw new Error('decryption failed');
      return keys.get(handle) ?? null;
    },
  } as unknown as SecretStore;
  return { keys, broken, store };
}

function createDatabase(): LocalDatabase {
  return new LocalDatabase({ filePath: ':memory:', now: () => 'T0' });
}

function saveProfile(db: LocalDatabase, id: string, provider: string): void {
  db.saveProviderProfile({
    id,
    provider,
    baseUrl: provider === 'kilo' ? 'https://api.kilo.ai/v1' : 'https://openrouter.ai/api/v1',
    modelId: 'model-1',
    secretHandleId: `handle-${id}`,
    createdAt: 'T0',
    updatedAt: 'T0',
  });
}

function stateOf(db: LocalDatabase, id: string): string {
  return db.listProfileStates().find((record) => record.profileId === id)?.state ?? 'active';
}

describe('checkProfileCredentials', () => {
  it('marks an active profile whose key cannot be read, and keeps the profile', async () => {
    const db = createDatabase();
    saveProfile(db, 'p-active', 'openrouter');
    const secrets = fakeSecrets();

    await expect(checkProfileCredentials(db, secrets.store)).resolves.toEqual(['p-active']);
    expect(stateOf(db, 'p-active')).toBe('credential-unavailable');
    expect(db.getProviderProfile('p-active')).toBeDefined();
  });

  it('leaves a profile with a readable key active', async () => {
    const db = createDatabase();
    saveProfile(db, 'p-active', 'openrouter');
    const secrets = fakeSecrets();
    secrets.keys.set('handle-p-active', 'sk-test');

    await expect(checkProfileCredentials(db, secrets.store)).resolves.toEqual([]);
    expect(stateOf(db, 'p-active')).toBe('active');
  });

  it('keeps a legacy profile disabled whatever its key does', async () => {
    const db = createDatabase();
    saveProfile(db, 'p-legacy', 'kilo');
    db.markLegacyProfiles();
    const secrets = fakeSecrets();

    await expect(checkProfileCredentials(db, secrets.store)).resolves.toEqual([]);
    expect(stateOf(db, 'p-legacy')).toBe('disabled-legacy');
  });

  it('never overwrites a legacy profile with the credential mark', () => {
    const db = createDatabase();
    saveProfile(db, 'p-legacy', 'kilo');
    db.markLegacyProfiles();

    db.markProfileCredentialUnavailable('p-legacy');

    expect(stateOf(db, 'p-legacy')).toBe('disabled-legacy');
  });

  it('clears the mark once the key reads again', async () => {
    const db = createDatabase();
    saveProfile(db, 'p-active', 'openrouter');
    const secrets = fakeSecrets();
    await checkProfileCredentials(db, secrets.store);
    expect(stateOf(db, 'p-active')).toBe('credential-unavailable');

    secrets.keys.set('handle-p-active', 'sk-test');
    await expect(checkProfileCredentials(db, secrets.store)).resolves.toEqual([]);
    expect(stateOf(db, 'p-active')).toBe('active');
  });

  it('treats a throwing secret store as unreadable, and recovers on the next readable check', async () => {
    const db = createDatabase();
    saveProfile(db, 'p-active', 'openrouter');
    const secrets = fakeSecrets();
    secrets.keys.set('handle-p-active', 'sk-test');
    secrets.broken.add('handle-p-active');

    await expect(checkProfileCredentials(db, secrets.store)).resolves.toEqual(['p-active']);
    expect(stateOf(db, 'p-active')).toBe('credential-unavailable');

    secrets.broken.delete('handle-p-active');
    await expect(checkProfileCredentials(db, secrets.store)).resolves.toEqual([]);
    expect(stateOf(db, 'p-active')).toBe('active');
  });
});
