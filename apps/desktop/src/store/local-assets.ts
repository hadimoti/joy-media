import type { DatabaseSync } from 'node:sqlite';

/**
 * Assets the editor registers for a local render (PLAN-v4 §6i). The asset ID is the reference the
 * editor and the Worker share, so it stays valid across restarts. The stored path never leaves
 * the main process: the renderer only ever sees the ID.
 */

export interface LocalAssetRegistration {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor?: Readonly<Record<string, unknown>>;
}

export interface LocalAsset extends LocalAssetRegistration {
  /** Set once the original bytes are stored. */
  readonly storedPath?: string;
}

export type LocalAssetRegistrationResult =
  { readonly kind: 'registered' } | { readonly kind: 'conflict' };

interface LocalAssetRow {
  readonly asset_id: string;
  readonly kind: string;
  readonly display_name: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly stored_path: string | null;
  readonly descriptor_json: string | null;
}

export function ensureLocalAssetSchema(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS local_assets (
       asset_id TEXT PRIMARY KEY,
       kind TEXT NOT NULL,
       display_name TEXT NOT NULL,
       sha256 TEXT NOT NULL,
       bytes INTEGER NOT NULL,
       stored_path TEXT,
       created_at TEXT NOT NULL
     )`,
  );
  const columns = db.prepare('PRAGMA table_info(local_assets)').all() as {
    readonly name: string;
  }[];
  if (!columns.some((column) => column.name === 'descriptor_json')) {
    db.exec('ALTER TABLE local_assets ADD COLUMN descriptor_json TEXT');
  }
}

export class SqliteLocalAssetStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => string,
  ) {}

  /** Registering the same content twice is harmless. Reusing an ID for other content is not. */
  register(asset: LocalAssetRegistration): LocalAssetRegistrationResult {
    const existing = this.get(asset.id);
    if (existing !== undefined) {
      const same = existing.sha256 === asset.sha256 && existing.bytes === asset.bytes;
      return same ? { kind: 'registered' } : { kind: 'conflict' };
    }
    this.db
      .prepare(
        `INSERT INTO local_assets (asset_id, kind, display_name, sha256, bytes, stored_path, created_at, descriptor_json)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        asset.id,
        asset.kind,
        asset.displayName,
        asset.sha256,
        asset.bytes,
        this.now(),
        asset.descriptor === undefined ? null : JSON.stringify(asset.descriptor),
      );
    return { kind: 'registered' };
  }

  get(assetId: string): LocalAsset | undefined {
    const row = this.db
      .prepare(
        `SELECT asset_id, kind, display_name, sha256, bytes, stored_path, descriptor_json
           FROM local_assets WHERE asset_id = ?`,
      )
      .get(assetId) as LocalAssetRow | undefined;
    if (row === undefined) return undefined;
    return {
      id: row.asset_id,
      kind: row.kind,
      displayName: row.display_name,
      sha256: row.sha256,
      bytes: row.bytes,
      ...(row.descriptor_json === null
        ? {}
        : { descriptor: JSON.parse(row.descriptor_json) as Readonly<Record<string, unknown>> }),
      ...(row.stored_path === null ? {} : { storedPath: row.stored_path }),
    };
  }

  /** The path of the stored original, for the Worker's source reads. */
  storedPath(assetId: string): string | undefined {
    return this.get(assetId)?.storedPath;
  }

  markStored(assetId: string, storedPath: string): boolean {
    const result = this.db
      .prepare('UPDATE local_assets SET stored_path = ? WHERE asset_id = ?')
      .run(storedPath, assetId);
    return Number(result.changes) === 1;
  }
}
