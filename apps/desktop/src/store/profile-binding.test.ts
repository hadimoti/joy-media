import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase, type ProviderProfile } from './local-database.js';
import { endpointBindingDigest, secretVersionDigest } from './profile-binding.js';

const OPENROUTER = 'https://openrouter.ai/api/v1';
const OPENROUTER_BINDING = endpointBindingDigest('p-or', 'https://openrouter.ai', '/api/v1');

function profileFor(
  id: string,
  secretHandleId: string,
  extra: Partial<ProviderProfile> = {},
): ProviderProfile {
  return {
    id,
    provider: 'openrouter',
    baseUrl: OPENROUTER,
    modelId: 'm',
    secretHandleId,
    createdAt: 'T0',
    updatedAt: 'T0',
    ...extra,
  };
}

/** A v1.0.x database: the profile tables as the earlier build created them, with saved rows. */
function writeLegacyDatabase(filePath: string): void {
  const db = new DatabaseSync(filePath);
  db.exec(`CREATE TABLE provider_profiles (
    id TEXT PRIMARY KEY, name TEXT, provider TEXT NOT NULL, base_url TEXT NOT NULL,
    model_id TEXT NOT NULL, cached_models TEXT, secret_handle_id TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const insert = db.prepare(
    "INSERT INTO provider_profiles (id, provider, base_url, model_id, secret_handle_id, created_at, updated_at) VALUES (?, ?, ?, 'm', ?, 'T0', 'T0')",
  );
  insert.run('p-or', 'openrouter', OPENROUTER, 'h-or');
  insert.run('p-kilo', 'kilo', 'https://api.kilo.ai/api/gateway', 'h-kilo');
  insert.run('p-public', 'openai-compatible', 'https://api.example.com/v1', 'h-public');
  db.close();
}

describe('endpoint binding', () => {
  let dir: string;
  let file: string;
  let opened: LocalDatabase[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'joy-binding-'));
    file = join(dir, 'app.sqlite');
  });

  afterEach(() => {
    // A failed assertion must not leave a database open, or the directory cannot be removed.
    for (const db of opened) {
      try {
        db.close();
      } catch {
        // Already closed by the test.
      }
    }
    opened = [];
    rmSync(dir, { recursive: true, force: true });
  });

  function open(): LocalDatabase {
    const db = new LocalDatabase({ filePath: file, now: () => 'T0' });
    opened.push(db);
    return db;
  }

  it('does not bind a v1.0.x profile on upgrade, so its key is confirmed again', () => {
    writeLegacyDatabase(file);

    const upgraded = open();
    expect(upgraded.listProviderProfiles().map((p) => p.bindingDigest)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    upgraded.close();
  });

  it('keeps a binding saved with its key version across restarts', () => {
    const first = open();
    first.setSecretCiphertext('h-or', 'ciphertext-1');
    first.saveProviderProfile(
      profileFor('p-or', 'h-or', {
        bindingDigest: OPENROUTER_BINDING,
        bindingSecretDigest: first.secretVersion('h-or'),
      }),
    );
    first.close();

    const second = open();
    expect(second.getProviderProfile('p-or')).toMatchObject({
      bindingDigest: OPENROUTER_BINDING,
      bindingSecretDigest: secretVersionDigest('ciphertext-1'),
    });
    second.close();
  });

  it('gives a different key a different version, so the binding no longer matches it', () => {
    const db = open();
    db.setSecretCiphertext('h-or', 'ciphertext-1');
    const before = db.secretVersion('h-or');
    db.setSecretCiphertext('h-or', 'ciphertext-2');
    expect(db.secretVersion('h-or')).not.toBe(before);
    db.close();
  });

  it('drops the bindings made before the key version was recorded, once', () => {
    const first = open();
    first.setSecretCiphertext('h-or', 'ciphertext-1');
    first.saveProviderProfile(
      profileFor('p-or', 'h-or', {
        bindingDigest: OPENROUTER_BINDING,
        bindingSecretDigest: first.secretVersion('h-or'),
      }),
    );
    first.close();

    // Forget that the reset ran, as a database from an earlier build would not have it.
    const raw = new DatabaseSync(file);
    raw.exec("DELETE FROM migration_state WHERE step = 'v110.reset-profile-bindings'");
    raw.close();

    const reopened = open();
    expect(reopened.getProviderProfile('p-or')?.bindingDigest).toBeUndefined();
    reopened.close();
  });

  it('removes a key that no profile references when the database opens', () => {
    const first = open();
    first.setSecretCiphertext('h-or', 'ciphertext-1');
    first.setSecretCiphertext('h-orphan', 'ciphertext-2');
    first.saveProviderProfile(profileFor('p-or', 'h-or'));
    first.close();

    const second = open();
    expect(second.getSecretCiphertext('h-orphan')).toBeUndefined();
    expect(second.getSecretCiphertext('h-or')).toBe('ciphertext-1');
    second.close();
  });
});
