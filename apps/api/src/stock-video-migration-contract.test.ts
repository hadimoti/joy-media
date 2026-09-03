import { describe, expect, it } from 'vitest';
import { POSTGRES_MIGRATIONS } from './postgres-migrations.js';

describe('stock-video migration contract', () => {
  it('appends migration 005 without changing the frozen baseline', () => {
    expect(POSTGRES_MIGRATIONS.map((migration) => migration.id)).toContain('005-stock-video');
    expect(POSTGRES_MIGRATIONS[0]).toMatchObject({
      id: '001-baseline',
      checksum: 'sha256:6044f0fbe21a3fb9ec46fc0a95f022842f1a0463fba94cdd53d4da844c4a23a1',
    });
  });

  it('keeps migration identifiers and checksums unique', () => {
    const ids = POSTGRES_MIGRATIONS.map((migration) => migration.id);
    const checksums = POSTGRES_MIGRATIONS.map((migration) => migration.checksum);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(checksums).size).toBe(checksums.length);
  });

  it('requires additive stock tables and no baseline rewrite', async () => {
    const migration = POSTGRES_MIGRATIONS.find((entry) => entry.id === '005-stock-video');
    expect(migration).toBeDefined();
    const queries: string[] = [];
    await migration!.up({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    });
    const sql = queries.join('\n').toLowerCase();
    for (const table of [
      'stock_video_catalog',
      'stock_video_search_cache',
      'stock_video_imports',
      'media_asset_sources',
    ])
      expect(sql).toContain(table);
    expect(sql).not.toMatch(/drop\s+table|drop\s+column|truncate/);
  });
});
