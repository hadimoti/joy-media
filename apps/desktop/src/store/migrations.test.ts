import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemorySecretStore } from '@joy-media/provider-sdk';
import type { SecretStore } from '@joy-media/provider-sdk';
import { checkProfileCredentials } from '../main/profile-credential-check.js';
import { LocalDatabase } from './local-database.js';
import { listProfileStates, runMigrations } from './migrations.js';

const NOW = () => '2026-10-28T00:00:00.000Z';

/** The v1.0.x schema, exactly as v1.0.x created it. */
function createV10Schema(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE media_manifest (
       ref_id TEXT PRIMARY KEY, checksum TEXT NOT NULL, kind TEXT NOT NULL,
       byte_size INTEGER NOT NULL, last_verified_at TEXT NOT NULL)`,
  );
  db.exec(
    `CREATE TABLE jobs (
       id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT NOT NULL, status TEXT NOT NULL,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT)`,
  );
  db.exec(`CREATE TABLE secrets (handle_id TEXT PRIMARY KEY, ciphertext_base64 TEXT NOT NULL)`);
  db.exec(
    `CREATE TABLE provider_profiles (
       id TEXT PRIMARY KEY, name TEXT, provider TEXT NOT NULL, base_url TEXT NOT NULL,
       model_id TEXT NOT NULL, cached_models TEXT, secret_handle_id TEXT NOT NULL,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  );
  db.exec(
    `CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  );
}

function insertProfile(db: DatabaseSync, id: string, provider: string): void {
  db.prepare(
    `INSERT INTO provider_profiles (id, name, provider, base_url, model_id, cached_models,
       secret_handle_id, created_at, updated_at)
     VALUES (?, ?, ?, 'https://api.example.com/v1', 'model-a', NULL, ?, '2026-09-01', '2026-09-01')`,
  ).run(id, id, provider, `secret-${id}`);
}

function tempDatabasePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joy-migrations-'));
  return path.join(dir, 'local.sqlite');
}

describe('v1.1.0 migrations', () => {
  it('marks legacy kilo and joy-hosted profiles disabled and leaves the others active', () => {
    const db = new DatabaseSync(':memory:');
    createV10Schema(db);
    insertProfile(db, 'p-kilo', 'kilo');
    insertProfile(db, 'p-joy', 'joy-hosted');
    insertProfile(db, 'p-openrouter', 'openrouter');
    insertProfile(db, 'p-custom', 'openai-compatible');

    runMigrations(db, { now: NOW });

    expect(listProfileStates(db)).toEqual([
      { profileId: 'p-joy', state: 'disabled-legacy', updatedAt: NOW() },
      { profileId: 'p-kilo', state: 'disabled-legacy', updatedAt: NOW() },
    ]);
  });

  it('runs once: a second start finds the markers and writes nothing new', () => {
    const db = new DatabaseSync(':memory:');
    createV10Schema(db);
    insertProfile(db, 'p-kilo', 'kilo');

    expect(runMigrations(db, { now: NOW })).toEqual([
      'v110.bind-legacy-profiles',
      'v110.update-settings-ignored',
      'v110.legacy-profiles',
    ]);
    const before = listProfileStates(db);
    expect(runMigrations(db, { now: () => '2030-01-01T00:00:00.000Z' })).toEqual([]);
    expect(listProfileStates(db)).toEqual(before);
  });

  it('a legacy profile created after the upgrade, for example by a v1.0.x rollback, is marked on the next start', () => {
    const db = new DatabaseSync(':memory:');
    createV10Schema(db);
    runMigrations(db, { now: NOW });

    insertProfile(db, 'p-late-kilo', 'kilo');
    expect(runMigrations(db, { now: NOW })).toEqual(['v110.legacy-profiles']);
    expect(listProfileStates(db).map((r) => r.profileId)).toEqual(['p-late-kilo']);
  });

  it('a crash part-way through a step rolls the step back, and the next start completes it', () => {
    const db = new DatabaseSync(':memory:');
    createV10Schema(db);
    insertProfile(db, 'p-a', 'kilo');
    insertProfile(db, 'p-b', 'joy-hosted');
    insertProfile(db, 'p-c', 'kilo');

    let rows = 0;
    expect(() =>
      runMigrations(db, {
        now: NOW,
        afterStepRow: () => {
          rows += 1;
          if (rows === 2) throw new Error('simulated crash');
        },
      }),
    ).toThrow('simulated crash');

    // Nothing from the failed pass is left behind: no state rows. The one-time step that
    // finished before it stays recorded, and it is not run again.
    expect(listProfileStates(db)).toEqual([]);
    expect(db.prepare('SELECT step FROM migration_state').all()).toEqual([
      { step: 'v110.bind-legacy-profiles' },
      { step: 'v110.update-settings-ignored' },
    ]);

    // The next start runs the whole step again and finishes it.
    runMigrations(db, { now: NOW });
    expect(listProfileStates(db).map((r) => r.profileId)).toEqual(['p-a', 'p-b', 'p-c']);
  });

  it('a downgrade fixture keeps every v1.0.x table and row unchanged, so v1.0.x still reads it', () => {
    const file = tempDatabasePath();
    const v10 = new DatabaseSync(file);
    createV10Schema(v10);
    insertProfile(v10, 'p-kilo', 'kilo');
    insertProfile(v10, 'p-custom', 'openai-compatible');
    v10.close();

    const before = new DatabaseSync(file);
    const v10Rows = before.prepare('SELECT * FROM provider_profiles ORDER BY id').all();
    before.close();

    // Opening with v1.1.0 runs the additive migrations.
    const local = new LocalDatabase({ filePath: file, now: NOW });
    expect(local.listProfileStates().map((r) => r.profileId)).toEqual(['p-kilo']);

    // A v1.0.x reader sees the same v1.0.x rows, unchanged, and nothing else was altered.
    const after = new DatabaseSync(file);
    expect(after.prepare('SELECT * FROM provider_profiles ORDER BY id').all()).toEqual(v10Rows);
    const tables = after
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'app_settings',
        'jobs',
        'media_manifest',
        'migration_state',
        'profile_state',
        'provider_profiles',
        'secrets',
      ]),
    );
    after.close();
  });

  it('"Later" keeps a legacy profile disabled and survives a restart', () => {
    const file = tempDatabasePath();
    const first = new LocalDatabase({ filePath: file, now: NOW });
    first.saveProviderProfile({
      id: 'p-kilo',
      provider: 'kilo',
      baseUrl: 'https://kilo.example.com/v1',
      modelId: 'm',
      secretHandleId: 'secret-p-kilo',
      createdAt: '2026-09-01',
      updatedAt: '2026-09-01',
    });
    first.recordProfileLater('p-kilo');

    const second = new LocalDatabase({ filePath: file, now: () => '2031-01-01T00:00:00.000Z' });
    expect(second.listProfileStates()).toEqual([
      {
        profileId: 'p-kilo',
        state: 'disabled-legacy',
        decision: 'later',
        updatedAt: NOW(),
      },
    ]);
  });

  it('an unreadable credential marks the profile and never deletes it', async () => {
    const file = tempDatabasePath();
    const local = new LocalDatabase({ filePath: file, now: NOW });
    local.saveProviderProfile({
      id: 'p-kilo',
      provider: 'kilo',
      baseUrl: 'https://kilo.example.com/v1',
      modelId: 'm',
      secretHandleId: 'secret-p-kilo',
      createdAt: '2026-09-01',
      updatedAt: '2026-09-01',
    });
    const throwingStore: SecretStore = {
      set: async () => undefined,
      get: async () => {
        throw new Error('DPAPI record unreadable');
      },
      delete: async () => undefined,
      redact: (line: string) => line,
    };

    const unavailable = await checkProfileCredentials(local, throwingStore);

    expect(unavailable).toEqual(['p-kilo']);
    expect(local.getProviderProfile('p-kilo')?.id).toBe('p-kilo');
    expect(local.listProfileStates()).toEqual([
      { profileId: 'p-kilo', state: 'credential-unavailable', updatedAt: NOW() },
    ]);
  });

  it('a readable credential leaves the profile alone', async () => {
    const local = new LocalDatabase({ filePath: ':memory:', now: NOW });
    local.saveProviderProfile({
      id: 'p-custom',
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'm',
      secretHandleId: 'secret-p-custom',
      createdAt: '2026-09-01',
      updatedAt: '2026-09-01',
    });
    const store = createMemorySecretStore();
    await store.set('secret-p-custom', 'sk-test-value');

    expect(await checkProfileCredentials(local, store)).toEqual([]);
    expect(local.listProfileStates()).toEqual([]);
  });
});
