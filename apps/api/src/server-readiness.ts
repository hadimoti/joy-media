import type { ControlPlane } from './control-plane.js';
import type { ApiReadinessOptions, ApiReleaseIdentity } from './http-server.js';
import type { PrivateObjectStore } from './private-object-store.js';
import { POSTGRES_MIGRATIONS } from './postgres-migrations.js';

/** Schema version emitted by the release tooling and required by readiness. */
export const EXPECTED_RELEASE_SCHEMA_VERSION = POSTGRES_MIGRATIONS.length;
export const PRIVATE_OBJECT_STORE_READINESS_TIMEOUT_MS = 2_500;

interface ReadinessQueryClient {
  query(sql: string): Promise<unknown>;
}

export interface ProductionReadinessDependencies {
  readonly pool: ReadinessQueryClient | undefined;
  readonly durableControlPlane: ControlPlane | undefined;
  readonly privateObjectStore: PrivateObjectStore | undefined;
  readonly releaseIdentity: ApiReleaseIdentity | undefined;
}

export const RELEASE_IDENTITY_ENVIRONMENT_KEYS = {
  commitSha: 'JOY_MEDIA_RELEASE_COMMIT_SHA',
  treeHash: 'JOY_MEDIA_RELEASE_TREE_HASH',
  lockfileSha256: 'JOY_MEDIA_RELEASE_LOCKFILE_SHA256',
  schemaVersion: 'JOY_MEDIA_RELEASE_SCHEMA_VERSION',
} as const;

/**
 * Reads only explicitly named, non-secret release metadata. Invalid or partial
 * metadata is discarded so readiness can fail closed without echoing it.
 */
export function releaseIdentityFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): ApiReleaseIdentity | undefined {
  const commitSha = environment[RELEASE_IDENTITY_ENVIRONMENT_KEYS.commitSha]?.trim();
  const treeHash = environment[RELEASE_IDENTITY_ENVIRONMENT_KEYS.treeHash]?.trim();
  const lockfileSha256 = environment[RELEASE_IDENTITY_ENVIRONMENT_KEYS.lockfileSha256]?.trim();
  const rawSchemaVersion = environment[RELEASE_IDENTITY_ENVIRONMENT_KEYS.schemaVersion]?.trim();
  const schemaVersion = rawSchemaVersion === undefined ? Number.NaN : Number(rawSchemaVersion);

  if (
    commitSha === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(commitSha) ||
    treeHash === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(treeHash) ||
    lockfileSha256 === undefined ||
    !/^[0-9a-f]{64}$/u.test(lockfileSha256) ||
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion !== EXPECTED_RELEASE_SCHEMA_VERSION
  )
    return undefined;

  return { commitSha, treeHash, lockfileSha256, schemaVersion };
}

/**
 * Production readiness is deliberately fail-closed. The schema probe resolves
 * the critical persistence, asset, and job tables without reading row data.
 */
export function productionReadinessOptions(
  dependencies: ProductionReadinessDependencies,
): ApiReadinessOptions {
  return {
    ...(dependencies.releaseIdentity === undefined
      ? {}
      : { releaseIdentity: dependencies.releaseIdentity }),
    checks: {
      releaseIdentity: () =>
        dependencies.releaseIdentity !== undefined &&
        dependencies.releaseIdentity.schemaVersion === EXPECTED_RELEASE_SCHEMA_VERSION,
      database: async () => {
        if (dependencies.pool === undefined) return false;
        await dependencies.pool.query('SELECT 1');
        return true;
      },
      controlPlane: async () => {
        if (dependencies.pool === undefined || dependencies.durableControlPlane === undefined)
          return false;
        await dependencies.pool.query(
          'SELECT 1 FROM projects, project_documents, media_assets, jobs LIMIT 0',
        );
        return true;
      },
      privateObjectStore: async () => {
        const store = dependencies.privateObjectStore;
        if (store === undefined) return false;
        if (typeof store.probeReadiness !== 'function') return true;
        await store.probeReadiness({ timeoutMs: PRIVATE_OBJECT_STORE_READINESS_TIMEOUT_MS });
        return true;
      },
    },
  };
}
