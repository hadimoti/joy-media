/**
 * Session export history for the header processes menu. Metadata persists in
 * localStorage; completed bytes are staged in the bounded OPFS export cache and
 * exposed through an object URL only while the workspace is open.
 */

export interface ExportProcessEntry {
  readonly id: string;
  readonly filename: string;
  readonly status: 'running' | 'completed' | 'failed' | 'interrupted-retryable';
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly mimeType?: string;
  readonly totalBytes?: number;
  readonly frameCount?: number;
  readonly error?: string;
}

export const EXPORT_HISTORY_KEY = 'joy-media.export-history.v1';
const MAX_ENTRIES = 20;

export interface ExportHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadExportHistory(storage: ExportHistoryStorage): readonly ExportProcessEntry[] {
  const raw = storage.getItem(EXPORT_HISTORY_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).map(normalizeInterrupted);
  } catch {
    return [];
  }
}

export function saveExportHistory(
  storage: ExportHistoryStorage,
  entries: readonly ExportProcessEntry[],
): void {
  storage.setItem(EXPORT_HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}

/** Newest first; replaces an existing entry with the same id. */
export function upsertEntry(
  entries: readonly ExportProcessEntry[],
  entry: ExportProcessEntry,
): readonly ExportProcessEntry[] {
  const rest = entries.filter((existing) => existing.id !== entry.id);
  return [entry, ...rest].slice(0, MAX_ENTRIES);
}

function isEntry(value: unknown): value is ExportProcessEntry {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<ExportProcessEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.filename === 'string' &&
    (entry.status === 'running' ||
      entry.status === 'completed' ||
      entry.status === 'failed' ||
      entry.status === 'interrupted-retryable') &&
    typeof entry.startedAt === 'string' &&
    (entry.mimeType === undefined || typeof entry.mimeType === 'string')
  );
}

/** An entry still 'running' from a previous page load can never finish. */
function normalizeInterrupted(entry: ExportProcessEntry): ExportProcessEntry {
  if (entry.status !== 'running') return entry;
  return { ...entry, status: 'interrupted-retryable', error: 'interrupted by page reload' };
}
