import { migrateToLatest, validateProjectDocumentV2 } from '@joy-media/project-schema';
import type { ProjectDocumentV2 } from '@joy-media/project-schema';

/** A deliberately tiny interface keeps this seam usable without DOM globals. */
export interface MigrationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Browser Storage-shaped source, kept structural for easy test doubles. */
export interface LegacyDomainStorage extends MigrationStorage {
  readonly length: number;
  key(index: number): string | null;
}

export type LegacyProjectDomains = Readonly<Record<string, unknown>> | LegacyDomainStorage;
export type LegacyMigrationStatus = 'migrated' | 'already-migrated' | 'invalid' | 'no-data';

export interface LegacyMigrationOptions {
  readonly projectId?: string;
  readonly storage?: MigrationStorage;
  readonly markerKey?: string;
  /** A previously returned document may be supplied by callers without storage. */
  readonly existingDocument?: ProjectDocumentV2;
}

export interface LegacyBackupPayload {
  readonly filename: string;
  readonly mimeType: 'application/json';
  readonly content: string;
}

export interface LegacyMigrationResult {
  readonly status: LegacyMigrationStatus;
  readonly document?: ProjectDocumentV2;
  readonly digest?: string;
  readonly digestVerified: boolean;
  readonly backup: LegacyBackupPayload;
  readonly warnings: readonly string[];
  readonly diagnostics: readonly {
    readonly code: string;
    readonly message: string;
    readonly path?: string;
  }[];
}

const DEFAULT_MARKER_KEY = 'joy-media.legacy-project-migration.v2';

/**
 * Converts the old collection of local JSON domains into one bounded V2
 * envelope. It has no side effects unless a storage adapter is supplied.
 * Unknown domains are copied verbatim; the V2 validator remains the final
 * boundary and rejects media bytes, blobs, and filesystem paths.
 */
export async function migrateLegacyProjectDomains(
  input: LegacyProjectDomains | null | undefined,
  options: LegacyMigrationOptions = {},
): Promise<LegacyMigrationResult> {
  const domains = normalizeDomains(input);
  const backup = serializeLegacyBackup(domains);
  if (Object.keys(domains).length === 0) return result('no-data', backup, [], []);
  try {
    canonicalJson(domains);
  } catch (error) {
    return result(
      'invalid',
      backup,
      [`legacy backup is bounded but contains unsupported data: ${(error as Error).message}`],
      [{ code: 'LEGACY_SERIALIZATION', message: (error as Error).message, path: '' }],
    );
  }

  const markerKey = options.markerKey ?? DEFAULT_MARKER_KEY;
  const markedDigest = options.storage?.getItem(markerKey);

  if (options.existingDocument !== undefined) {
    const diagnostics = validateProjectDocumentV2(options.existingDocument);
    if (diagnostics.length === 0) {
      const digest = await documentDigest(options.existingDocument);
      const markerMatchesDocument =
        markedDigest !== null &&
        markedDigest !== undefined &&
        /^[a-f0-9]{64}$/.test(markedDigest) &&
        markedDigest === digest;
      // Without a marker, a caller-provided valid document is still a useful
      // idempotency signal. If a marker exists, however, it must authenticate
      // this exact deterministic document rather than merely be non-empty.
      if (markedDigest === null || markedDigest === undefined || markerMatchesDocument) {
        return {
          ...result('already-migrated', backup, ['a V2 document was supplied by the caller'], []),
          document: options.existingDocument,
          digest,
          digestVerified: true,
        };
      }
    }
  }

  const projectId = options.projectId ?? findProjectId(domains) ?? 'legacy-project';
  const migratedDomains = migrateKnownProject(domains);
  const document = {
    schemaVersion: 2 as const,
    projectId,
    ...migratedDomains,
  } as ProjectDocumentV2;
  const diagnostics = validateProjectDocumentV2(document);
  if (diagnostics.length > 0)
    return result(
      'invalid',
      backup,
      ['legacy domains could not be represented by ProjectDocumentV2'],
      diagnostics,
    );

  const digest = await documentDigest(document);
  const verified = digest === (await sha256(canonicalJson(document)));
  if (!verified)
    return result('invalid', backup, ['migrated document digest verification failed'], []);
  const markerIsValid =
    markedDigest !== null && markedDigest !== undefined && /^[a-f0-9]{64}$/.test(markedDigest);
  if (markerIsValid && markedDigest === digest) {
    return {
      status: 'already-migrated',
      document,
      digest,
      digestVerified: true,
      backup,
      warnings: ['legacy domains were already migrated'],
      diagnostics: [],
    };
  }
  options.storage?.setItem(markerKey, digest);
  const markerWasSupplied = markedDigest !== null && markedDigest !== undefined;
  const markerVerified = !markerWasSupplied;
  const warnings = [
    ...(markerWasSupplied ? ['ignored stale or invalid migration marker'] : []),
    ...Object.keys(domains)
      .filter((key) => !KNOWN_DOMAINS.has(key))
      .map((key) => `preserved unknown legacy domain: ${key}`),
  ];
  return {
    status: 'migrated',
    document,
    digest,
    digestVerified: markerVerified,
    backup,
    warnings,
    diagnostics: [],
  };
}

export function serializeLegacyBackup(domains: LegacyProjectDomains): LegacyBackupPayload {
  const normalized = normalizeDomains(domains);
  let content: string;
  try {
    content = `${canonicalJson(normalized)}\n`;
  } catch (error) {
    // Keep the download action safe even when old storage contains hostile or
    // non-JSON values. The migration result separately reports the failure.
    content = `{"error":"legacy backup unavailable","reason":${JSON.stringify((error as Error).message).slice(0, 512)}}\n`;
  }
  return {
    filename: 'joy-media-legacy-project-backup.json',
    mimeType: 'application/json',
    content,
  };
}

async function documentDigest(document: ProjectDocumentV2): Promise<string> {
  return sha256(canonicalJson(document));
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.subtle === undefined) throw new Error('SHA-256 is unavailable in this runtime');
  const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeDomains(input: LegacyProjectDomains | null | undefined): Record<string, unknown> {
  if (input === null || input === undefined) return {};
  const storageInput = input as Partial<LegacyDomainStorage>;
  if (typeof storageInput.length === 'number' && typeof storageInput.key === 'function') {
    const domains: Record<string, unknown> = {};
    for (let index = 0; index < storageInput.length; index += 1) {
      const key = storageInput.key(index);
      if (key === null) continue;
      const value = storageInput.getItem?.(key) ?? null;
      if (value === null) continue;
      try {
        domains[key] = JSON.parse(value) as unknown;
      } catch {
        domains[key] = value;
      }
    }
    return domains;
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') {
      output[key] = value;
      continue;
    }
    try {
      output[key] = JSON.parse(value) as unknown;
    } catch {
      output[key] = value;
    }
  }
  return output;
}

const KNOWN_DOMAINS = new Set([
  'project',
  'timeline',
  'tracks',
  'clips',
  'assets',
  'captions',
  'audio',
  'color',
  'effects',
  'motion',
  'templates',
  'exportSettings',
]);

function migrateKnownProject(domains: Record<string, unknown>): Record<string, unknown> {
  const project = domains.project;
  if (project !== null && typeof project === 'object' && !Array.isArray(project)) {
    const version = (project as { schemaVersion?: unknown }).schemaVersion;
    if (version === 0 || version === 1) {
      try {
        return { ...domains, project: migrateToLatest(project as never) };
      } catch {
        /* validator reports the original data */
      }
    }
  }
  return domains;
}

function findProjectId(domains: Record<string, unknown>): string | undefined {
  const project = domains.project;
  if (project !== null && typeof project === 'object' && !Array.isArray(project)) {
    const id =
      (project as { id?: unknown; projectId?: unknown }).projectId ??
      (project as { id?: unknown }).id;
    if (typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return id;
  }
  return undefined;
}

function result(
  status: LegacyMigrationStatus,
  backup: LegacyBackupPayload,
  warnings: string[],
  diagnostics: readonly {
    readonly code: string;
    readonly message: string;
    readonly path?: string;
  }[],
): LegacyMigrationResult {
  return { status, backup, warnings, diagnostics, digestVerified: false };
}

/** Stable JSON for objects, including unknown legacy domains. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (entry: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > 50_000) throw new Error('value exceeds the 50,000-node migration bound');
    if (depth > 32) throw new Error('value exceeds the 32-level migration bound');
    if (entry === null) return 'null';
    if (typeof entry === 'string') {
      if (entry.length > 16_384)
        throw new Error('string exceeds the 16,384-character migration bound');
      return JSON.stringify(entry);
    }
    if (typeof entry === 'number' || typeof entry === 'boolean') return JSON.stringify(entry);
    if (typeof entry !== 'object') throw new Error(`unsupported ${typeof entry} value`);
    if (seen.has(entry)) throw new Error('circular value is not supported');
    seen.add(entry);
    let output: string;
    if (Array.isArray(entry))
      output = `[${entry.map((child) => visit(child, depth + 1)).join(',')}]`;
    else {
      const record = entry as Record<string, unknown>;
      if (Reflect.ownKeys(record).some((key) => typeof key !== 'string'))
        throw new Error('symbol keys are not supported');
      output = `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${visit(record[key], depth + 1)}`)
        .join(',')}}`;
    }
    seen.delete(entry);
    return output;
  };
  return visit(value, 0);
}
