import {
  validateProjectDocumentV2,
  type JsonValue,
  type ProjectDocumentV2,
} from '@joy-media/project-schema';

const STORAGE_PREFIX = 'joy-media.project-document-browser-journal.v1';
const STORAGE_VERSION = 1;
const DEFAULT_MAX_SNAPSHOTS = 5;
const DEFAULT_MAX_OPERATIONS = 100;
const DEFAULT_MAX_CHECKPOINTS = 25;
const DEFAULT_MAX_BYTES = 512_000;
const MAX_METADATA_NODES = 2_000;
const MAX_METADATA_STRING_LENGTH = 8_192;

/** A storage boundary that can be backed by localStorage, IndexedDB, or OPFS. */
export interface ProjectDocumentBrowserJournalStorage {
  readonly getItem: (key: string) => string | null | Promise<string | null>;
  readonly setItem: (key: string, value: string) => void | Promise<void>;
}

/** JSON-only backup retained alongside the V2 journal for local recovery. */
export interface ProjectDocumentLegacyBackup {
  readonly filename: string;
  readonly mimeType: 'application/json';
  readonly content: string;
}

export interface ProjectDocumentJournalOperation {
  readonly operationId: string;
  readonly revision: number;
  readonly kind: string;
  readonly createdAt: string;
  readonly metadata?: JsonValue;
}

export interface ProjectDocumentJournalCheckpoint {
  readonly checkpointId: string;
  readonly revision: number;
  readonly snapshotChecksum: string;
  readonly createdAt: string;
  readonly operationCount: number;
  readonly metadata?: JsonValue;
}

export interface ProjectDocumentJournalSnapshot {
  readonly document: ProjectDocumentV2;
  readonly checksum: string;
  readonly revision: number;
  readonly createdAt: string;
}

export interface ProjectDocumentBrowserJournalOptions {
  /** Optional key override, useful when a host scopes storage itself. */
  readonly storageKey?: string;
  readonly maxSnapshots?: number;
  readonly maxOperations?: number;
  readonly maxCheckpoints?: number;
  /** Maximum UTF-8 bytes for the complete serialized record. */
  readonly maxBytes?: number;
  readonly now?: () => Date;
}

export interface AppendProjectDocumentOptions {
  readonly operationId?: string;
  readonly operationKind?: string;
  readonly operationMetadata?: JsonValue;
  readonly checkpointId?: string;
  readonly checkpointMetadata?: JsonValue;
  readonly createdAt?: string;
}

export interface ProjectDocumentJournalRecovery {
  readonly document: ProjectDocumentV2;
  readonly revision: number;
  readonly recoveredWithWarnings: boolean;
  readonly warnings: readonly string[];
}

export interface ProjectDocumentJournalState {
  readonly snapshots: readonly ProjectDocumentJournalSnapshot[];
  readonly operations: readonly ProjectDocumentJournalOperation[];
  readonly checkpoints: readonly ProjectDocumentJournalCheckpoint[];
}

export type ProjectDocumentJournalErrorCode =
  | 'JOURNAL_INVALID_PROJECT'
  | 'JOURNAL_INVALID_DOCUMENT'
  | 'JOURNAL_INVALID_METADATA'
  | 'JOURNAL_STORAGE_UNAVAILABLE'
  | 'JOURNAL_STORAGE_READ_FAILED'
  | 'JOURNAL_STORAGE_WRITE_FAILED'
  | 'JOURNAL_STORAGE_CORRUPT'
  | 'JOURNAL_SNAPSHOT_CORRUPT'
  | 'JOURNAL_NOT_FOUND'
  | 'JOURNAL_QUOTA_EXCEEDED';

export class ProjectDocumentJournalError extends Error {
  readonly code: ProjectDocumentJournalErrorCode;

  constructor(code: ProjectDocumentJournalErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectDocumentJournalError';
    this.code = code;
  }
}

interface StoredDatabase {
  readonly version: typeof STORAGE_VERSION;
  readonly projectId: string;
  readonly snapshots: readonly ProjectDocumentJournalSnapshot[];
  readonly operations: readonly ProjectDocumentJournalOperation[];
  readonly checkpoints: readonly ProjectDocumentJournalCheckpoint[];
}

interface ReadDatabaseResult {
  readonly database: StoredDatabase;
  readonly warnings: readonly string[];
}

/**
 * Durable, project-scoped V2 document journal for browser hosts.
 *
 * Each append atomically persists a full V2 snapshot and one operation and
 * checkpoint record. The storage implementation is deliberately injected so
 * an IndexedDB/OPFS adapter can provide atomic setItem semantics without this
 * module depending on DOM APIs. No media payloads or filesystem paths are
 * accepted by either documents or metadata.
 */
export class ProjectDocumentBrowserJournal {
  readonly #storage: ProjectDocumentBrowserJournalStorage;
  readonly #projectId: string;
  readonly #storageKey: string;
  readonly #maxSnapshots: number;
  readonly #maxOperations: number;
  readonly #maxCheckpoints: number;
  readonly #maxBytes: number;
  readonly #now: () => Date;

  constructor(
    storage: ProjectDocumentBrowserJournalStorage,
    projectId: string,
    options: ProjectDocumentBrowserJournalOptions = {},
  ) {
    if (!isProjectId(projectId)) {
      throw new ProjectDocumentJournalError(
        'JOURNAL_INVALID_PROJECT',
        'projectId must be an opaque project identifier',
      );
    }
    this.#storage = storage;
    this.#projectId = projectId;
    this.#storageKey = options.storageKey ?? `${STORAGE_PREFIX}:${encodeURIComponent(projectId)}`;
    this.#maxSnapshots = positiveLimit(options.maxSnapshots, DEFAULT_MAX_SNAPSHOTS);
    this.#maxOperations = positiveLimit(options.maxOperations, DEFAULT_MAX_OPERATIONS);
    this.#maxCheckpoints = positiveLimit(options.maxCheckpoints, DEFAULT_MAX_CHECKPOINTS);
    this.#maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES);
    this.#now = options.now ?? (() => new Date());
  }

  get storageKey(): string {
    return this.#storageKey;
  }

  get backupStorageKey(): string {
    return `${this.#storageKey}:legacy-backup`;
  }

  get backupMetadataStorageKey(): string {
    return `${this.backupStorageKey}:metadata`;
  }

  /** Persist a bounded legacy backup in the same local-only storage backend. */
  async saveLegacyBackup(backup: ProjectDocumentLegacyBackup): Promise<void> {
    if (
      backup.mimeType !== 'application/json' ||
      backup.filename.trim().length === 0 ||
      typeof backup.content !== 'string'
    ) {
      throw new ProjectDocumentJournalError(
        'JOURNAL_INVALID_METADATA',
        'legacy backup must be JSON with a filename and serialized content',
      );
    }
    const serialized = JSON.stringify(backup);
    if (utf8Length(serialized) > this.#maxBytes)
      throw new ProjectDocumentJournalError(
        'JOURNAL_QUOTA_EXCEEDED',
        `legacy backup exceeds its ${String(this.#maxBytes)} byte bound`,
      );
    await this.#writeRaw(this.backupStorageKey, serialized);
    await this.#writeRaw(
      this.backupMetadataStorageKey,
      JSON.stringify({ filename: backup.filename, mimeType: backup.mimeType }),
    );
  }

  /** Check backup availability without reading project content into UI state. */
  async hasLegacyBackup(): Promise<boolean> {
    const serialized = await this.#readRaw(this.backupMetadataStorageKey);
    if (serialized !== null) {
      try {
        const value = JSON.parse(serialized) as Partial<ProjectDocumentLegacyBackup>;
        if (
          value.mimeType === 'application/json' &&
          typeof value.filename === 'string' &&
          value.filename.trim().length > 0
        )
          return true;
      } catch {
        // The content envelope below is authoritative when metadata is stale.
      }
    }
    const backup = await this.#readRaw(this.backupStorageKey);
    if (backup === null) return false;
    try {
      parseLegacyBackup(backup);
      return true;
    } catch (error) {
      throw new ProjectDocumentJournalError(
        'JOURNAL_STORAGE_CORRUPT',
        'legacy backup storage is invalid',
        { cause: error },
      );
    }
  }

  /** Load a previously retained backup without exposing its raw content to UI state. */
  async loadLegacyBackup(): Promise<ProjectDocumentLegacyBackup | null> {
    const serialized = await this.#readRaw(this.backupStorageKey);
    if (serialized === null) return null;
    try {
      return parseLegacyBackup(serialized);
    } catch (error) {
      throw new ProjectDocumentJournalError(
        'JOURNAL_STORAGE_CORRUPT',
        'legacy backup storage is invalid',
        { cause: error },
      );
    }
  }

  /** Atomically append a snapshot, operation metadata, and checkpoint metadata. */
  async append(
    document: ProjectDocumentV2,
    options: AppendProjectDocumentOptions = {},
  ): Promise<{ readonly revision: number; readonly snapshot: ProjectDocumentJournalSnapshot }> {
    const safeDocument = this.#validatedDocument(document);
    const metadata = validateMetadata(options.operationMetadata, 'operationMetadata');
    const checkpointMetadata = validateMetadata(options.checkpointMetadata, 'checkpointMetadata');
    const current = await this.#readDatabase();
    const revision = latestRevision(current.database) + 1;
    const createdAt = options.createdAt ?? this.#now().toISOString();
    if (!isIsoDate(createdAt)) {
      throw new ProjectDocumentJournalError(
        'JOURNAL_INVALID_METADATA',
        'createdAt must be an ISO date string',
      );
    }
    const snapshot: ProjectDocumentJournalSnapshot = {
      document: safeDocument,
      checksum: checksum(safeDocument),
      revision,
      createdAt,
    };
    const operation: ProjectDocumentJournalOperation = {
      operationId: options.operationId ?? `operation-${String(revision)}`,
      revision,
      kind: options.operationKind ?? 'document.replace',
      createdAt,
      ...(metadata === undefined ? {} : { metadata }),
    };
    const checkpoint: ProjectDocumentJournalCheckpoint = {
      checkpointId: options.checkpointId ?? `checkpoint-${String(revision)}`,
      revision,
      snapshotChecksum: snapshot.checksum,
      createdAt,
      operationCount: current.database.operations.length + 1,
      ...(checkpointMetadata === undefined ? {} : { metadata: checkpointMetadata }),
    };
    const bounded = boundDatabase(
      {
        version: STORAGE_VERSION,
        projectId: this.#projectId,
        snapshots: [...current.database.snapshots, snapshot],
        operations: [...current.database.operations, operation],
        checkpoints: [...current.database.checkpoints, checkpoint],
      },
      this.#maxSnapshots,
      this.#maxOperations,
      this.#maxCheckpoints,
      this.#maxBytes,
    );
    await this.#writeDatabase(bounded);
    return { revision, snapshot: cloneJson(snapshot) };
  }

  /** Explicit alias for callers that describe a whole-document replacement. */
  async saveSnapshot(
    document: ProjectDocumentV2,
    options: AppendProjectDocumentOptions = {},
  ): Promise<{ readonly revision: number; readonly snapshot: ProjectDocumentJournalSnapshot }> {
    return this.append(document, options);
  }

  /** Recover the newest checksum-verified and schema-validated snapshot. */
  async recover(): Promise<ProjectDocumentJournalRecovery> {
    const { database, warnings: readWarnings } = await this.#readDatabase();
    const warnings = [...readWarnings];
    const snapshots = [...database.snapshots].sort((left, right) => right.revision - left.revision);
    for (const snapshot of snapshots) {
      if (snapshot.revision < 0 || !Number.isSafeInteger(snapshot.revision)) {
        warnings.push('ignored snapshot with invalid revision');
        continue;
      }
      if (checksum(snapshot.document) !== snapshot.checksum) {
        warnings.push(`ignored snapshot revision ${snapshot.revision}: checksum failed`);
        continue;
      }
      const diagnostics = validateProjectDocumentV2(snapshot.document);
      if (diagnostics.length > 0) {
        warnings.push(
          `ignored snapshot revision ${snapshot.revision}: ${diagnostics[0]?.message ?? 'invalid document'}`,
        );
        continue;
      }
      if (snapshot.document.projectId !== this.#projectId) {
        warnings.push(`ignored snapshot revision ${snapshot.revision}: project id mismatch`);
        continue;
      }
      return {
        document: cloneJson(snapshot.document),
        revision: snapshot.revision,
        recoveredWithWarnings: warnings.length > 0,
        warnings,
      };
    }
    throw new ProjectDocumentJournalError(
      database.snapshots.length === 0 ? 'JOURNAL_NOT_FOUND' : 'JOURNAL_SNAPSHOT_CORRUPT',
      database.snapshots.length === 0
        ? `project "${this.#projectId}" has no journal snapshots`
        : 'no valid V2 snapshot is available',
    );
  }

  /** Load is a convenience alias for recovery during application startup. */
  async load(): Promise<ProjectDocumentJournalRecovery> {
    return this.recover();
  }

  /** Read bounded metadata for diagnostics or sync integration. */
  async state(): Promise<ProjectDocumentJournalState> {
    const { database } = await this.#readDatabase();
    return cloneJson({
      snapshots: database.snapshots,
      operations: database.operations,
      checkpoints: database.checkpoints,
    });
  }

  async #readDatabase(): Promise<ReadDatabaseResult> {
    const serialized = await this.#readRaw(this.#storageKey);
    if (serialized === null) {
      return { database: emptyDatabase(this.#projectId), warnings: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw new ProjectDocumentJournalError(
        'JOURNAL_STORAGE_CORRUPT',
        'journal storage contains malformed JSON',
        { cause: error },
      );
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== STORAGE_VERSION ||
      parsed.projectId !== this.#projectId
    ) {
      throw new ProjectDocumentJournalError(
        'JOURNAL_STORAGE_CORRUPT',
        'journal storage envelope is invalid',
      );
    }
    if (
      !Array.isArray(parsed.snapshots) ||
      !Array.isArray(parsed.operations) ||
      !Array.isArray(parsed.checkpoints)
    ) {
      throw new ProjectDocumentJournalError(
        'JOURNAL_STORAGE_CORRUPT',
        'journal storage collections are invalid',
      );
    }
    const warnings: string[] = [];
    const snapshots = parsed.snapshots.filter((value): value is ProjectDocumentJournalSnapshot => {
      if (!isSnapshot(value)) {
        warnings.push('ignored malformed journal snapshot entry');
        return false;
      }
      return true;
    });
    const operations = parsed.operations.filter(
      (value): value is ProjectDocumentJournalOperation => {
        if (!isOperation(value)) {
          warnings.push('ignored malformed journal operation entry');
          return false;
        }
        return true;
      },
    );
    const checkpoints = parsed.checkpoints.filter(
      (value): value is ProjectDocumentJournalCheckpoint => {
        if (!isCheckpoint(value)) {
          warnings.push('ignored malformed journal checkpoint entry');
          return false;
        }
        return true;
      },
    );
    return {
      database: {
        version: STORAGE_VERSION,
        projectId: this.#projectId,
        snapshots,
        operations,
        checkpoints,
      },
      warnings,
    };
  }

  async #writeDatabase(database: StoredDatabase): Promise<void> {
    const serialized = JSON.stringify(database);
    if (utf8Length(serialized) > this.#maxBytes) {
      throw new ProjectDocumentJournalError(
        'JOURNAL_QUOTA_EXCEEDED',
        `journal record exceeds its ${String(this.#maxBytes)} byte bound`,
      );
    }
    await this.#writeRaw(this.#storageKey, serialized);
  }

  async #readRaw(key: string): Promise<string | null> {
    try {
      return await this.#storage.getItem(key);
    } catch (error) {
      throw new ProjectDocumentJournalError(
        'JOURNAL_STORAGE_READ_FAILED',
        'journal storage read failed',
        { cause: error },
      );
    }
  }

  async #writeRaw(key: string, serialized: string): Promise<void> {
    try {
      await this.#storage.setItem(key, serialized);
    } catch (error) {
      throw new ProjectDocumentJournalError(
        isQuotaError(error) ? 'JOURNAL_QUOTA_EXCEEDED' : 'JOURNAL_STORAGE_WRITE_FAILED',
        isQuotaError(error) ? 'journal storage quota was exceeded' : 'journal storage write failed',
        { cause: error },
      );
    }
  }

  #validatedDocument(document: ProjectDocumentV2): ProjectDocumentV2 {
    const diagnostics = validateProjectDocumentV2(document);
    if (diagnostics.length > 0) {
      throw new ProjectDocumentJournalError(
        'JOURNAL_INVALID_DOCUMENT',
        diagnostics[0]?.message ?? 'document is invalid',
      );
    }
    if (document.projectId !== this.#projectId) {
      throw new ProjectDocumentJournalError(
        'JOURNAL_INVALID_DOCUMENT',
        'document projectId does not match the journal projectId',
      );
    }
    try {
      return cloneJson(document);
    } catch (error) {
      throw new ProjectDocumentJournalError(
        'JOURNAL_INVALID_DOCUMENT',
        'document must be JSON serializable',
        { cause: error },
      );
    }
  }
}

function emptyDatabase(projectId: string): StoredDatabase {
  return { version: STORAGE_VERSION, projectId, snapshots: [], operations: [], checkpoints: [] };
}

function boundDatabase(
  database: StoredDatabase,
  maxSnapshots: number,
  maxOperations: number,
  maxCheckpoints: number,
  maxBytes: number,
): StoredDatabase {
  let snapshots = [...database.snapshots].slice(-maxSnapshots);
  let operations = [...database.operations].slice(-maxOperations);
  let checkpoints = [...database.checkpoints].slice(-maxCheckpoints);
  const serialized = (): string =>
    JSON.stringify({
      version: STORAGE_VERSION,
      projectId: database.projectId,
      snapshots,
      operations,
      checkpoints,
    });
  while (
    utf8Length(serialized()) > maxBytes &&
    (operations.length > 0 || checkpoints.length > 0 || snapshots.length > 1)
  ) {
    if (operations.length > 0) operations = operations.slice(1);
    if (utf8Length(serialized()) <= maxBytes) break;
    if (checkpoints.length > 0) checkpoints = checkpoints.slice(1);
    if (utf8Length(serialized()) <= maxBytes) break;
    if (snapshots.length > 1) snapshots = snapshots.slice(1);
  }
  return {
    version: STORAGE_VERSION,
    projectId: database.projectId,
    snapshots,
    operations,
    checkpoints,
  };
}

function latestRevision(database: StoredDatabase): number {
  return Math.max(
    0,
    ...database.snapshots.map((entry) => entry.revision),
    ...database.operations.map((entry) => entry.revision),
    ...database.checkpoints.map((entry) => entry.revision),
  );
}

function validateMetadata(value: JsonValue | undefined, field: string): JsonValue | undefined {
  if (value === undefined) return undefined;
  let nodes = 0;
  const visit = (entry: unknown, path: string): void => {
    nodes += 1;
    if (nodes > MAX_METADATA_NODES) throw new Error(`${field} has too many values`);
    if (typeof entry === 'string') {
      if (entry.length > MAX_METADATA_STRING_LENGTH)
        throw new Error(`${field} contains an oversized string`);
      return;
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new Error(`${field} contains a non-finite number`);
      return;
    }
    if (entry === null || typeof entry === 'boolean') return;
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, `${path}[${String(index)}]`));
      return;
    }
    if (!isRecord(entry)) throw new Error(`${field} must contain JSON values`);
    for (const [key, child] of Object.entries(entry)) {
      if (forbiddenKey(key)) throw new Error(`${field} contains a forbidden field: ${key}`);
      visit(child, path.length === 0 ? key : `${path}.${key}`);
    }
  };
  try {
    visit(value, '');
    return cloneJson(value);
  } catch (error) {
    throw new ProjectDocumentJournalError(
      'JOURNAL_INVALID_METADATA',
      error instanceof Error ? error.message : `${field} is invalid`,
      { cause: error },
    );
  }
}

function isSnapshot(value: unknown): value is ProjectDocumentJournalSnapshot {
  const record = isRecord(value) ? value : undefined;
  const revision = record?.revision;
  return (
    record !== undefined &&
    isDocumentLike(record.document) &&
    typeof record.checksum === 'string' &&
    typeof revision === 'number' &&
    Number.isSafeInteger(revision) &&
    revision >= 0 &&
    isIsoDate(record.createdAt)
  );
}

function isOperation(value: unknown): value is ProjectDocumentJournalOperation {
  const record = isRecord(value) ? value : undefined;
  const revision = record?.revision;
  return (
    record !== undefined &&
    typeof record.operationId === 'string' &&
    record.operationId.length > 0 &&
    typeof revision === 'number' &&
    Number.isSafeInteger(revision) &&
    revision >= 0 &&
    typeof record.kind === 'string' &&
    isIsoDate(record.createdAt) &&
    (record.metadata === undefined || isJsonValue(record.metadata))
  );
}

function isCheckpoint(value: unknown): value is ProjectDocumentJournalCheckpoint {
  const record = isRecord(value) ? value : undefined;
  const revision = record?.revision;
  const operationCount = record?.operationCount;
  return (
    record !== undefined &&
    typeof record.checkpointId === 'string' &&
    record.checkpointId.length > 0 &&
    typeof revision === 'number' &&
    Number.isSafeInteger(revision) &&
    revision >= 0 &&
    typeof record.snapshotChecksum === 'string' &&
    isIsoDate(record.createdAt) &&
    typeof operationCount === 'number' &&
    Number.isSafeInteger(operationCount) &&
    operationCount >= 0 &&
    (record.metadata === undefined || isJsonValue(record.metadata))
  );
}

function isDocumentLike(value: unknown): value is ProjectDocumentV2 {
  return validateProjectDocumentV2(value).length === 0;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    isRecord(value) &&
    Object.entries(value).every(([key, child]) => !forbiddenKey(key) && isJsonValue(child))
  );
}

function forbiddenKey(key: string): boolean {
  return /^(?:raw(?:Media|Bytes)?|media|bytes|base64|buffer|blob|path|url|uri|.*(?:Path|Url|Uri|Bytes|Base64|Buffer|Blob|MediaData))$/i.test(
    key,
  );
}

function isProjectId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError('journal limits must be positive integers');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseLegacyBackup(serialized: string): ProjectDocumentLegacyBackup {
  const value = JSON.parse(serialized) as Partial<ProjectDocumentLegacyBackup>;
  if (
    value.mimeType !== 'application/json' ||
    typeof value.filename !== 'string' ||
    value.filename.trim().length === 0 ||
    typeof value.content !== 'string'
  )
    throw new Error('legacy backup envelope is invalid');
  return value as ProjectDocumentLegacyBackup;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function checksum(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isQuotaError(value: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' &&
      value instanceof DOMException &&
      value.name === 'QuotaExceededError') ||
    (isRecord(value) && (value.name === 'QuotaExceededError' || value.code === 'QUOTA_ERR'))
  );
}
