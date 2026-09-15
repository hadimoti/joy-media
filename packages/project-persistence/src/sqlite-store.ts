/**
 * SQLite-backed `ProjectStore<P,T>` for the desktop host (wave 2 of the final migration).
 *
 * Uses `node:sqlite` (built in to Node 22+, matching this repo's `engines.node`) rather than a
 * native module such as `better-sqlite3`: a native addon would need a prebuilt binary per
 * Electron ABI and complicate packaging/signing (see
 * docs/joy-media-final-migration-design.md §3). `node:sqlite` is still an experimental Node API
 * as of this writing; every call in here goes through this one file so a future swap stays
 * contained.
 *
 * Desktop-only: this file is reachable through the `@joy-media/project-persistence/desktop`
 * subpath export, never the browser-safe `.` barrel that `apps/editor-web` bundles with Vite —
 * same convention `desktop-store.ts` already established.
 */
import { DatabaseSync } from 'node:sqlite';
import { retainNewestSnapshots } from './persistence.js';
import type { ProjectStore, StoredSnapshot, StoredTransaction } from './persistence.js';

interface SnapshotRow {
  readonly revision: number;
  readonly schema_version: number;
  readonly payload: string;
  readonly checksum: string;
}

interface TransactionRow {
  readonly revision: number;
  readonly payload: string;
  readonly checksum: string;
}

/** Atomic desktop SQLite adapter for snapshot/log persistence. Safe to open on `:memory:` for tests. */
export class SqliteProjectStore<P, T> implements ProjectStore<P, T> {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    // WAL: a mid-write crash cannot leave the main database file half-written, and readers
    // never block on a concurrent writer (the Worker process may read the same file).
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS snapshots (
         project_id TEXT NOT NULL,
         revision INTEGER NOT NULL,
         schema_version INTEGER NOT NULL,
         payload TEXT NOT NULL,
         checksum TEXT NOT NULL,
         PRIMARY KEY (project_id, revision)
       )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS transactions (
         project_id TEXT NOT NULL,
         revision INTEGER NOT NULL,
         payload TEXT NOT NULL,
         checksum TEXT NOT NULL,
         PRIMARY KEY (project_id, revision)
       )`,
    );
  }

  writeSnapshot(projectId: string, snapshot: StoredSnapshot<P>, retainSnapshots?: number): void {
    const kept = retainNewestSnapshots(this.snapshots(projectId), snapshot, retainSnapshots);
    this.transaction(() => {
      this.db.prepare('DELETE FROM snapshots WHERE project_id = ?').run(projectId);
      const insert = this.db.prepare(
        'INSERT INTO snapshots (project_id, revision, schema_version, payload, checksum) VALUES (?, ?, ?, ?, ?)',
      );
      for (const entry of kept) {
        insert.run(
          projectId,
          entry.revision,
          entry.schemaVersion,
          JSON.stringify(entry.payload),
          entry.checksum,
        );
      }
    });
  }

  writeTransaction(projectId: string, transaction: StoredTransaction<T>): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO transactions (project_id, revision, payload, checksum) VALUES (?, ?, ?, ?)',
      )
      .run(
        projectId,
        transaction.revision,
        JSON.stringify(transaction.payload),
        transaction.checksum,
      );
  }

  snapshots(projectId: string): readonly StoredSnapshot<P>[] {
    const rows = this.db
      .prepare(
        'SELECT revision, schema_version, payload, checksum FROM snapshots WHERE project_id = ? ORDER BY revision ASC',
      )
      .all(projectId) as unknown as SnapshotRow[];
    return rows.map((row) => ({
      revision: row.revision,
      schemaVersion: row.schema_version,
      payload: JSON.parse(row.payload) as P,
      checksum: row.checksum,
    }));
  }

  transactions(projectId: string): readonly StoredTransaction<T>[] {
    const rows = this.db
      .prepare(
        'SELECT revision, payload, checksum FROM transactions WHERE project_id = ? ORDER BY revision ASC',
      )
      .all(projectId) as unknown as TransactionRow[];
    return rows.map((row) => ({
      revision: row.revision,
      payload: JSON.parse(row.payload) as T,
      checksum: row.checksum,
    }));
  }

  listProjectIds(): readonly string[] {
    const rows = this.db
      .prepare(
        'SELECT project_id FROM snapshots UNION SELECT project_id FROM transactions ORDER BY project_id ASC',
      )
      .all() as unknown as { readonly project_id: string }[];
    return rows.map((row) => row.project_id);
  }

  deleteProject(projectId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM snapshots WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM transactions WHERE project_id = ?').run(projectId);
    });
  }

  /** Releases the SQLite file handle. Call during crash-safe shutdown, not before. */
  close(): void {
    this.db.close();
  }

  private transaction(run: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      run();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
