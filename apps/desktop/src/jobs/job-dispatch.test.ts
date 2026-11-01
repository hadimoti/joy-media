import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteJobDispatchStore } from './job-dispatch.js';

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('job_dispatch payload column', () => {
  it('adds the payload column to a table an earlier build wrote, and keeps its rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-dispatch-migrate-'));
    scratch.push(dir);
    const db = new DatabaseSync(join(dir, 'old.sqlite'));
    try {
      // The table as the previous build created it: no payload_json column.
      db.exec(
        `CREATE TABLE job_dispatch (
           job_id TEXT PRIMARY KEY,
           job_type TEXT NOT NULL,
           progress INTEGER NOT NULL DEFAULT 0,
           attempts INTEGER NOT NULL DEFAULT 0,
           worker_id TEXT,
           lease_token TEXT,
           lease_expires_at TEXT,
           cancel_requested INTEGER NOT NULL DEFAULT 0,
           derivative_sha256 TEXT,
           derivative_bytes INTEGER,
           derivative_mime TEXT,
           derivative_path TEXT,
           result_json TEXT
         )`,
      );
      db.prepare('INSERT INTO job_dispatch (job_id, job_type) VALUES (?, ?)').run(
        'job-1',
        'asset.thumbnail',
      );

      new SqliteJobDispatchStore(db);

      const columns = db.prepare('PRAGMA table_info(job_dispatch)').all() as unknown as readonly {
        readonly name: string;
      }[];
      expect(columns.map((column) => column.name)).toContain('payload_json');
      const kept = db
        .prepare('SELECT job_type, payload_json FROM job_dispatch WHERE job_id = ?')
        .get('job-1');
      expect(kept).toEqual({ job_type: 'asset.thumbnail', payload_json: null });
    } finally {
      db.close();
    }
  });

  it('is idempotent: opening a store twice does not add the column twice', () => {
    const db = new DatabaseSync(':memory:');
    try {
      new SqliteJobDispatchStore(db);
      expect(() => new SqliteJobDispatchStore(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
