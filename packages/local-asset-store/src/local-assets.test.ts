import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ensureLocalAssetSchema, SqliteLocalAssetStore } from './local-assets.js';

function createStore(): SqliteLocalAssetStore {
  const db = new DatabaseSync(':memory:');
  ensureLocalAssetSchema(db);
  return new SqliteLocalAssetStore(db, () => 'T0');
}

const REGISTRATION = {
  id: 'asset-1',
  kind: 'video',
  displayName: 'clip.webm.stage',
  sha256: 'a'.repeat(64),
  bytes: 14,
};

describe('SqliteLocalAssetStore', () => {
  it('registers an ID once, accepts the same content again, and refuses other content', () => {
    const assets = createStore();
    expect(assets.register(REGISTRATION)).toEqual({ kind: 'registered' });
    expect(assets.register(REGISTRATION)).toEqual({ kind: 'registered' });
    expect(assets.register({ ...REGISTRATION, bytes: 15 })).toEqual({ kind: 'conflict' });
    expect(assets.get('asset-1')).toEqual(REGISTRATION);
  });

  it('exposes a stored path only after the original is marked stored', () => {
    const assets = createStore();
    assets.register(REGISTRATION);
    expect(assets.storedPath('asset-1')).toBeUndefined();
    expect(assets.markStored('asset-1', '/media/originals/abc.bin')).toBe(true);
    expect(assets.storedPath('asset-1')).toBe('/media/originals/abc.bin');
    expect(assets.markStored('missing', '/media/originals/none.bin')).toBe(false);
  });

  it('migrates a legacy table and round-trips the descriptor', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE local_assets (
      asset_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      stored_path TEXT,
      created_at TEXT NOT NULL
    )`);

    ensureLocalAssetSchema(db);
    const assets = new SqliteLocalAssetStore(db, () => 'T0');
    const registration = {
      ...REGISTRATION,
      descriptor: { mimeType: 'image/png', width: 32, height: 24 },
    };
    expect(assets.register(registration)).toEqual({ kind: 'registered' });
    expect(assets.get('asset-1')).toEqual(registration);
    db.close();
  });
});
