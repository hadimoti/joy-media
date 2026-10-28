import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from './local-database.js';
import { bindUnboundProfiles, endpointBindingDigest } from './profile-binding.js';

const OPENROUTER = 'https://openrouter.ai/api/v1';

/** The two tables the binding reads, as a v1.0.x database holds them. */
function legacySchema(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE provider_profiles (
    id TEXT PRIMARY KEY, name TEXT, provider TEXT NOT NULL, base_url TEXT NOT NULL,
    model_id TEXT NOT NULL, cached_models TEXT, secret_handle_id TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.exec('CREATE TABLE profile_state (profile_id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  return db;
}

function insertLegacy(db: DatabaseSync, id: string, provider: string, baseUrl: string): void {
  db.prepare(
    "INSERT INTO provider_profiles (id, provider, base_url, model_id, secret_handle_id, created_at, updated_at) VALUES (?, ?, ?, 'm', ?, 'T0', 'T0')",
  ).run(id, provider, baseUrl, `h-${id}`);
}

describe('endpoint binding of legacy profiles', () => {
  it('binds the legacy rows the policy allows, and no legacy provider or public endpoint', () => {
    const db = legacySchema();
    insertLegacy(db, 'p-or', 'openrouter', OPENROUTER);
    insertLegacy(db, 'p-kilo', 'kilo', 'https://api.kilo.ai/api/gateway');
    insertLegacy(db, 'p-public', 'openai-compatible', 'https://api.example.com/v1');

    expect(bindUnboundProfiles(db, 'T0')).toBe(1);
    const row = db
      .prepare('SELECT binding_digest FROM profile_binding WHERE profile_id = ?')
      .get('p-or') as { binding_digest: string } | undefined;
    expect(row?.binding_digest).toBe(
      endpointBindingDigest('p-or', 'https://openrouter.ai', '/api/v1'),
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_binding').get()).toEqual({ n: 1 });
    expect(bindUnboundProfiles(db, 'T1')).toBe(0);
    db.close();
  });
});

describe('endpoint binding after the one-time migration', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'joy-binding-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not bind a profile saved without a binding after the migration has run', () => {
    const first = new LocalDatabase({ filePath: join(dir, 'app.sqlite'), now: () => 'T0' });
    first.saveProviderProfile({
      id: 'p-or',
      provider: 'openrouter',
      baseUrl: OPENROUTER,
      modelId: 'm',
      secretHandleId: 'h-or',
      createdAt: 'T0',
      updatedAt: 'T0',
    });
    first.close();

    const second = new LocalDatabase({ filePath: join(dir, 'app.sqlite'), now: () => 'T0' });
    expect(second.getProviderProfile('p-or')?.bindingDigest).toBeUndefined();
    second.close();
  });
});
