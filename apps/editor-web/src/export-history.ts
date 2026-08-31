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
export const PROJECT_EXPORT_HISTORY_KEY = 'joy-media.export-history.v2';
const MAX_ENTRIES = 20;
const MAX_PROJECT_ENTRIES = 200;

/**
 * Project-owned export metadata. Legacy v1 entries deliberately do not satisfy
 * this shape: they cannot be retried safely because their source project and
 * operation fingerprint were never persisted.
 */
interface ProjectExportProcessEntryBase extends Omit<ExportProcessEntry, 'status'> {
  readonly projectId: string;
  readonly fingerprint: string;
  readonly revision: number;
  readonly presetId: string;
  readonly manifest: ExportRetryManifest;
  readonly producer?: 'browser-staged-preview-export';
  readonly workerJobId?: string;
  readonly derivativeId?: string;
  readonly stagedAssetId?: string;
}

/** Immutable inputs required to retry the same logical browser encode. */
export interface ExportRetryManifest {
  readonly width: number;
  readonly height: number;
  readonly durationUs: number;
  readonly frameRate: number;
}

export type ProjectExportProcessEntry = ProjectExportProcessEntryBase &
  (
    | {
        readonly status: 'completed';
        readonly cacheState: 'ready';
        readonly sha256: string;
        readonly totalBytes: number;
      }
    | {
        readonly status: 'running' | 'failed' | 'interrupted-retryable';
        readonly cacheState: 'none';
      }
  );

interface ProjectExportHistoryV2 {
  readonly version: 2;
  readonly entries: readonly ProjectExportProcessEntry[];
  readonly legacy: readonly ExportProcessEntry[];
}

export interface LegacyExportMigrationResult {
  readonly migrated: boolean;
  readonly legacyCount: number;
}

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

/**
 * Creates the v2 envelope once and preserves v1 rows as read-only, unscoped
 * history. They are never assigned to whichever project happens to open first.
 */
export function migrateLegacyExportHistory(
  storage: ExportHistoryStorage,
): LegacyExportMigrationResult {
  const current = readProjectHistory(storage);
  if (current !== undefined) return { migrated: false, legacyCount: current.legacy.length };
  const legacy = loadExportHistory(storage);
  writeProjectHistory(storage, { version: 2, entries: [], legacy });
  return { migrated: true, legacyCount: legacy.length };
}

/** Read-only v1 rows retained during migration; never expose Retry for these. */
export function loadLegacyExportHistory(
  storage: ExportHistoryStorage,
): readonly ExportProcessEntry[] {
  migrateLegacyExportHistory(storage);
  return readProjectHistory(storage)?.legacy ?? [];
}

/** Loads only one project's entries and normalizes stale in-browser encodes. */
export function loadProjectExportHistory(
  storage: ExportHistoryStorage,
  projectId: string,
): readonly ProjectExportProcessEntry[] {
  assertProjectId(projectId);
  migrateLegacyExportHistory(storage);
  return (readProjectHistory(storage)?.entries ?? [])
    .filter((entry) => entry.projectId === projectId)
    .map(normalizeProjectInterrupted);
}

/**
 * Replaces only one project's rows while retaining every other project's
 * history. Entries are newest-first and bounded independently per project.
 */
export function saveProjectExportHistory(
  storage: ExportHistoryStorage,
  projectId: string,
  entries: readonly ProjectExportProcessEntry[],
): void {
  assertProjectId(projectId);
  migrateLegacyExportHistory(storage);
  const history = readProjectHistory(storage) ?? { version: 2 as const, entries: [], legacy: [] };
  const owned = entries
    .filter((entry) => entry.projectId === projectId && isProjectEntry(entry))
    .slice(0, MAX_ENTRIES);
  const otherProjects = history.entries.filter((entry) => entry.projectId !== projectId);
  writeProjectHistory(storage, {
    ...history,
    entries: [...owned, ...otherProjects].slice(0, MAX_PROJECT_ENTRIES),
  });
}

/** Newest first; replaces an existing project entry with the same logical id. */
export function upsertProjectEntry(
  entries: readonly ProjectExportProcessEntry[],
  entry: ProjectExportProcessEntry,
): readonly ProjectExportProcessEntry[] {
  const rest = entries.filter(
    (existing) => existing.projectId !== entry.projectId || existing.id !== entry.id,
  );
  return [entry, ...rest].slice(0, MAX_ENTRIES);
}

/**
 * Persists reload recovery immediately so other tabs do not continue to see a
 * permanently-running browser encode.
 */
export function recoverInterruptedProjectExports(
  storage: ExportHistoryStorage,
  projectId: string,
): readonly ProjectExportProcessEntry[] {
  const loaded = loadProjectExportHistory(storage, projectId);
  const recovered = loaded.map(normalizeProjectInterrupted);
  saveProjectExportHistory(storage, projectId, recovered);
  return recovered;
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

function isProjectEntry(value: unknown): value is ProjectExportProcessEntry {
  if (!isEntry(value)) return false;
  const entry = value as Partial<ProjectExportProcessEntry>;
  return (
    typeof entry.projectId === 'string' &&
    entry.projectId.length > 0 &&
    typeof entry.fingerprint === 'string' &&
    entry.fingerprint.length > 0 &&
    Number.isSafeInteger(entry.revision) &&
    entry.revision! >= 0 &&
    typeof entry.presetId === 'string' &&
    entry.presetId.length > 0 &&
    isRetryManifest(entry.manifest) &&
    (entry.producer === undefined || entry.producer === 'browser-staged-preview-export') &&
    (entry.workerJobId === undefined || typeof entry.workerJobId === 'string') &&
    (entry.derivativeId === undefined || typeof entry.derivativeId === 'string') &&
    (entry.stagedAssetId === undefined || typeof entry.stagedAssetId === 'string') &&
    ((entry.status === 'completed' &&
      entry.cacheState === 'ready' &&
      typeof entry.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(entry.sha256) &&
      Number.isSafeInteger(entry.totalBytes) &&
      entry.totalBytes! >= 0) ||
      (entry.status !== 'completed' && entry.cacheState === 'none'))
  );
}

function isRetryManifest(value: unknown): value is ExportRetryManifest {
  if (value === null || typeof value !== 'object') return false;
  const manifest = value as Partial<ExportRetryManifest>;
  return (
    Number.isSafeInteger(manifest.width) &&
    manifest.width! > 0 &&
    Number.isSafeInteger(manifest.height) &&
    manifest.height! > 0 &&
    Number.isSafeInteger(manifest.durationUs) &&
    manifest.durationUs! > 0 &&
    Number.isFinite(manifest.frameRate) &&
    manifest.frameRate! > 0 &&
    manifest.frameRate! <= 120
  );
}

/** An entry still 'running' from a previous page load can never finish. */
function normalizeInterrupted(entry: ExportProcessEntry): ExportProcessEntry {
  if (entry.status !== 'running') return entry;
  return { ...entry, status: 'interrupted-retryable', error: 'interrupted by page reload' };
}

function normalizeProjectInterrupted(entry: ProjectExportProcessEntry): ProjectExportProcessEntry {
  if (entry.status !== 'running') return entry;
  return {
    ...entry,
    status: 'interrupted-retryable',
    cacheState: 'none',
    error: 'interrupted by page reload',
  };
}

function readProjectHistory(storage: ExportHistoryStorage): ProjectExportHistoryV2 | undefined {
  const raw = storage.getItem(PROJECT_EXPORT_HISTORY_KEY);
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectExportHistoryV2>;
    if (parsed.version !== 2 || !Array.isArray(parsed.entries) || !Array.isArray(parsed.legacy))
      return undefined;
    return {
      version: 2,
      entries: parsed.entries.filter(isProjectEntry),
      legacy: parsed.legacy.filter(isEntry).map(normalizeInterrupted),
    };
  } catch {
    return undefined;
  }
}

function writeProjectHistory(storage: ExportHistoryStorage, history: ProjectExportHistoryV2): void {
  storage.setItem(PROJECT_EXPORT_HISTORY_KEY, JSON.stringify(history));
}

function assertProjectId(projectId: string): void {
  if (projectId.trim().length === 0) throw new TypeError('projectId must not be empty');
}
