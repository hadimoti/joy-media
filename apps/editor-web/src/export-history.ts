import {
  isFinalExportVerificationReceipt,
  type FinalExportVerificationReceipt,
} from './export-final-verification.js';

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

export type ProjectExportProcessStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted-retryable'
  /** The final Blob was not certified; retain no downloadable/cache output. */
  | 'verification-required';

export const EXPORT_HISTORY_KEY = 'joy-media.export-history.v1';
export const PROJECT_EXPORT_HISTORY_KEY = 'joy-media.export-history.v2';
/**
 * Completed rows written before final-Blob verification existed are preserved
 * as retryable metadata, never as a downloadable completed artifact.
 */
export const LEGACY_FINAL_VERIFICATION_REQUIRED_ERROR =
  'Created before final MP4 verification; re-export or verify again.';
/** A verified historical receipt cannot make unavailable cache bytes downloadable. */
export const DURABLE_EXPORT_BYTES_UNAVAILABLE_ERROR = 'durable export bytes are unavailable';
const MAX_ENTRIES = 20;
const MAX_PROJECT_ENTRIES = 200;
const REQUIRED_FINAL_EXPORT_CHECK_KINDS = [
  'container',
  'video-streams',
  'audio-streams',
  'dimensions',
  'duration',
  'video-pts',
  'video-decode',
  'audio-decode',
] as const;

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
  /** Sanitized final-Blob verification result, never decoded media or URLs. */
  readonly verification?: FinalExportVerificationReceipt;
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
        readonly status: Exclude<ProjectExportProcessStatus, 'completed'>;
        readonly cacheState: 'none';
      }
  );

/**
 * Cache integrity is evaluated after a completed receipt was written. If the
 * durable bytes disappear or no longer match their digest, preserve a
 * retryable history row but replace the stale success receipt with the only
 * truthful current state: the final artifact is not readable here.
 */
export function markCompletedExportCacheUnavailable(
  entry: ProjectExportProcessEntry,
  checkedAt = new Date().toISOString(),
): ProjectExportProcessEntry {
  if (entry.status !== 'completed')
    throw new TypeError('Only a completed export can transition after cache loss.');
  if (!isIsoTimestamp(checkedAt)) throw new TypeError('checkedAt must be an ISO timestamp.');

  const {
    cacheState: _cacheState,
    sha256: _sha256,
    totalBytes: _totalBytes,
    verification: priorVerification,
    ...metadata
  } = entry;
  const verification =
    priorVerification?.status === 'verified'
      ? Object.freeze({
          verifierVersion: priorVerification.verifierVersion,
          decoderVersion: priorVerification.decoderVersion,
          checkedAt,
          status: 'blocked' as const,
          code: 'artifact-not-readable' as const,
        })
      : undefined;
  return Object.freeze({
    ...metadata,
    status: 'failed' as const,
    cacheState: 'none' as const,
    error: DURABLE_EXPORT_BYTES_UNAVAILABLE_ERROR,
    ...(verification === undefined ? {} : { verification }),
  });
}

/** Raw v2 rows from before final-Blob verification was introduced. */
type LegacyUnverifiedCompletedProjectExportEntry = ProjectExportProcessEntryBase & {
  readonly status: 'completed';
  readonly cacheState: 'ready';
  readonly sha256: string;
  readonly totalBytes: number;
  readonly verification?: undefined;
};

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
    .filter((entry) => entry.projectId === projectId)
    .flatMap((entry) => normalizeProjectEntryForPersistence(entry))
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
    hasExportEntryFields(entry) &&
    (entry.status === 'running' ||
      entry.status === 'completed' ||
      entry.status === 'failed' ||
      entry.status === 'interrupted-retryable')
  );
}

function isProjectEntry(value: unknown): value is ProjectExportProcessEntry {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<ProjectExportProcessEntry>;
  return (
    hasProjectEntryBaseFields(entry) &&
    isVerificationCompatibleWithStatus(
      entry.status!,
      entry.verification,
      entry.manifest!,
      entry.error,
    ) &&
    ((entry.status === 'completed' &&
      entry.cacheState === 'ready' &&
      typeof entry.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(entry.sha256) &&
      Number.isSafeInteger(entry.totalBytes) &&
      entry.totalBytes! >= 0) ||
      (entry.status !== 'completed' && entry.cacheState === 'none'))
  );
}

function isLegacyUnverifiedCompletedProjectEntry(
  value: unknown,
): value is LegacyUnverifiedCompletedProjectExportEntry {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<LegacyUnverifiedCompletedProjectExportEntry>;
  return (
    hasProjectEntryBaseFields(entry) &&
    entry.status === 'completed' &&
    entry.cacheState === 'ready' &&
    typeof entry.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(entry.sha256) &&
    Number.isSafeInteger(entry.totalBytes) &&
    entry.totalBytes! >= 0 &&
    entry.verification === undefined
  );
}

function normalizeProjectEntryForPersistence(
  entry: ProjectExportProcessEntry,
): readonly ProjectExportProcessEntry[] {
  if (isProjectEntry(entry)) return [entry];
  if (isLegacyUnverifiedCompletedProjectEntry(entry))
    return [downgradeLegacyUnverifiedCompletedEntry(entry)];
  return [];
}

function downgradeLegacyUnverifiedCompletedEntry(
  entry: LegacyUnverifiedCompletedProjectExportEntry,
): ProjectExportProcessEntry {
  const { cacheState: _cacheState, sha256: _sha256, totalBytes: _totalBytes, ...metadata } = entry;
  return {
    ...metadata,
    status: 'verification-required',
    cacheState: 'none',
    error: LEGACY_FINAL_VERIFICATION_REQUIRED_ERROR,
  };
}

/**
 * No row may claim completion without an internally consistent successful
 * receipt. This protects cache/download recovery from a stale, legacy, or
 * tampered localStorage status.
 */
function isVerificationCompatibleWithStatus(
  status: ProjectExportProcessStatus,
  verification: unknown,
  manifest: ExportRetryManifest,
  error: unknown,
): boolean {
  if (verification === undefined)
    return (
      status === 'running' ||
      status === 'interrupted-retryable' ||
      status === 'failed' ||
      (status === 'verification-required' && error === LEGACY_FINAL_VERIFICATION_REQUIRED_ERROR)
    );
  if (!isFinalExportVerificationReceipt(verification)) return false;
  if (status === 'completed')
    return (
      verification.status === 'verified' && isVerifiedReceiptConsistent(verification, manifest)
    );
  if (status === 'verification-required') return verification.status === 'unavailable';
  if (status === 'failed')
    return verification.status === 'failed' || verification.status === 'blocked';
  return false;
}

function hasProjectEntryBaseFields(value: Partial<ProjectExportProcessEntry>): boolean {
  return (
    hasExportEntryFields(value) &&
    isProjectExportProcessStatus(value.status) &&
    typeof value.projectId === 'string' &&
    value.projectId.length > 0 &&
    typeof value.fingerprint === 'string' &&
    value.fingerprint.length > 0 &&
    Number.isSafeInteger(value.revision) &&
    value.revision! >= 0 &&
    typeof value.presetId === 'string' &&
    value.presetId.length > 0 &&
    isRetryManifest(value.manifest) &&
    (value.producer === undefined || value.producer === 'browser-staged-preview-export') &&
    (value.workerJobId === undefined || typeof value.workerJobId === 'string') &&
    (value.derivativeId === undefined || typeof value.derivativeId === 'string') &&
    (value.stagedAssetId === undefined || typeof value.stagedAssetId === 'string')
  );
}

/** Recheck the safe receipt against the persisted immutable export manifest. */
function isVerifiedReceiptConsistent(
  verification: Extract<FinalExportVerificationReceipt, { readonly status: 'verified' }>,
  manifest: ExportRetryManifest,
): boolean {
  const expectedFrameCount = Math.max(
    1,
    Math.round((manifest.durationUs / 1_000_000) * manifest.frameRate),
  );
  const durationToleranceUs = Math.ceil(1_000_000 / manifest.frameRate);
  return (
    REQUIRED_FINAL_EXPORT_CHECK_KINDS.every((kind) => verification.checkKinds.includes(kind)) &&
    verification.facts.container === 'mp4' &&
    verification.facts.width === manifest.width &&
    verification.facts.height === manifest.height &&
    Math.abs(verification.facts.durationUs - manifest.durationUs) <= durationToleranceUs &&
    verification.facts.videoStreamCount === 1 &&
    verification.facts.audioStreamCount === 1 &&
    verification.facts.presentationFrameCount === expectedFrameCount
  );
}

function hasExportEntryFields(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as {
    readonly id?: unknown;
    readonly filename?: unknown;
    readonly startedAt?: unknown;
    readonly mimeType?: unknown;
  };
  return (
    typeof entry.id === 'string' &&
    typeof entry.filename === 'string' &&
    typeof entry.startedAt === 'string' &&
    (entry.mimeType === undefined || typeof entry.mimeType === 'string')
  );
}

function isProjectExportProcessStatus(value: unknown): value is ProjectExportProcessStatus {
  return (
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'interrupted-retryable' ||
    value === 'verification-required'
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
    const parsedEntries = parsed.entries.flatMap((entry) => {
      if (isProjectEntry(entry)) return [entry];
      if (isLegacyUnverifiedCompletedProjectEntry(entry))
        return [downgradeLegacyUnverifiedCompletedEntry(entry)];
      return [];
    });
    return {
      version: 2,
      entries: parsedEntries,
      legacy: parsed.legacy.filter(isEntry).map(normalizeInterrupted),
    };
  } catch {
    return undefined;
  }
}

function writeProjectHistory(storage: ExportHistoryStorage, history: ProjectExportHistoryV2): void {
  storage.setItem(PROJECT_EXPORT_HISTORY_KEY, JSON.stringify(history));
}

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function assertProjectId(projectId: string): void {
  if (projectId.trim().length === 0) throw new TypeError('projectId must not be empty');
}
