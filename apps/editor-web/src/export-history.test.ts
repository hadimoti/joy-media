import { describe, expect, it } from 'vitest';
import {
  EXPORT_HISTORY_KEY,
  loadExportHistory,
  saveExportHistory,
  upsertEntry,
  type ExportProcessEntry,
} from './export-history.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const entry = (id: string, status: ExportProcessEntry['status']): ExportProcessEntry => ({
  id,
  filename: `${id}.mp4`,
  status,
  startedAt: '2026-07-23T00:00:00.000Z',
});

describe('export history', () => {
  it('round-trips entries and keeps newest first on upsert', () => {
    const storage = memoryStorage();
    let entries = upsertEntry([], entry('a', 'completed'));
    entries = upsertEntry(entries, entry('b', 'completed'));
    saveExportHistory(storage, entries);
    expect(loadExportHistory(storage).map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('replaces an entry by id instead of duplicating it', () => {
    let entries = upsertEntry([], entry('a', 'running'));
    entries = upsertEntry(entries, { ...entry('a', 'completed'), totalBytes: 9 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'a', status: 'completed', totalBytes: 9 });
  });

  it('marks stale running entries as retryable on load', () => {
    const storage = memoryStorage();
    saveExportHistory(storage, [entry('a', 'running')]);
    const loaded = loadExportHistory(storage);
    expect(loaded[0]).toMatchObject({
      status: 'interrupted-retryable',
      error: 'interrupted by page reload',
    });
  });

  it('ignores malformed persisted payloads', () => {
    const storage = memoryStorage();
    storage.setItem(EXPORT_HISTORY_KEY, '{broken');
    expect(loadExportHistory(storage)).toEqual([]);
    storage.setItem(EXPORT_HISTORY_KEY, JSON.stringify([{ nope: true }, entry('ok', 'completed')]));
    expect(loadExportHistory(storage).map((e) => e.id)).toEqual(['ok']);
  });

  it('caps the history at 20 entries', () => {
    let entries: readonly ExportProcessEntry[] = [];
    for (let i = 0; i < 25; i++) entries = upsertEntry(entries, entry(`e${i}`, 'completed'));
    expect(entries).toHaveLength(20);
    expect(entries[0]?.id).toBe('e24');
  });
});
