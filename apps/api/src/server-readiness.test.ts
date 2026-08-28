import { describe, expect, it } from 'vitest';
import { LocalControlPlane } from './control-plane.js';
import type { PrivateObjectStore } from './private-object-store.js';
import {
  EXPECTED_RELEASE_SCHEMA_VERSION,
  productionReadinessOptions,
  releaseIdentityFromEnvironment,
} from './server-readiness.js';

const configuredPrivateObjectStore = {} as PrivateObjectStore;
const releaseIdentity = {
  commitSha: 'a'.repeat(40),
  treeHash: 'b'.repeat(40),
  lockfileSha256: 'c'.repeat(64),
  schemaVersion: EXPECTED_RELEASE_SCHEMA_VERSION,
} as const;

describe('production readiness wiring', () => {
  it('probes PostgreSQL and the critical control-plane schema without reading rows', async () => {
    const queries: string[] = [];
    const readiness = productionReadinessOptions({
      pool: {
        async query(sql) {
          queries.push(sql);
          return {};
        },
      },
      durableControlPlane: new LocalControlPlane(),
      privateObjectStore: configuredPrivateObjectStore,
      releaseIdentity,
    });
    const checks = readiness.checks!;

    expect(checks.releaseIdentity!()).toBe(true);
    expect(readiness.releaseIdentity).toEqual(releaseIdentity);
    await expect(checks.database!()).resolves.toBe(true);
    await expect(checks.controlPlane!()).resolves.toBe(true);
    expect(checks.privateObjectStore!()).toBe(true);
    expect(queries).toEqual([
      'SELECT 1',
      'SELECT 1 FROM projects, project_documents, media_assets, jobs LIMIT 0',
    ]);
  });

  it('fails closed when production dependencies are not configured', async () => {
    const checks = productionReadinessOptions({
      pool: undefined,
      durableControlPlane: undefined,
      privateObjectStore: undefined,
      releaseIdentity: undefined,
    }).checks!;

    expect(checks.releaseIdentity!()).toBe(false);
    await expect(checks.database!()).resolves.toBe(false);
    await expect(checks.controlPlane!()).resolves.toBe(false);
    expect(checks.privateObjectStore!()).toBe(false);
  });

  it('propagates database and schema probe failures to the readiness boundary', async () => {
    const failure = new Error('database unavailable');
    const checks = productionReadinessOptions({
      pool: { query: async () => Promise.reject(failure) },
      durableControlPlane: new LocalControlPlane(),
      privateObjectStore: configuredPrivateObjectStore,
      releaseIdentity,
    }).checks!;

    await expect(checks.database!()).rejects.toBe(failure);
    await expect(checks.controlPlane!()).rejects.toBe(failure);
  });

  it('does not claim control-plane readiness from database connectivity alone', async () => {
    let queries = 0;
    const checks = productionReadinessOptions({
      pool: {
        async query() {
          queries++;
          return {};
        },
      },
      durableControlPlane: undefined,
      privateObjectStore: configuredPrivateObjectStore,
      releaseIdentity,
    }).checks!;

    await expect(checks.database!()).resolves.toBe(true);
    await expect(checks.controlPlane!()).resolves.toBe(false);
    expect(queries).toBe(1);
  });

  it('accepts complete, validated non-secret release metadata', () => {
    expect(
      releaseIdentityFromEnvironment({
        JOY_MEDIA_RELEASE_COMMIT_SHA: releaseIdentity.commitSha,
        JOY_MEDIA_RELEASE_TREE_HASH: releaseIdentity.treeHash,
        JOY_MEDIA_RELEASE_LOCKFILE_SHA256: releaseIdentity.lockfileSha256,
        JOY_MEDIA_RELEASE_SCHEMA_VERSION: String(EXPECTED_RELEASE_SCHEMA_VERSION),
        JOY_MEDIA_DATABASE_URL: 'must-not-be-read-or-returned',
      }),
    ).toEqual(releaseIdentity);
  });

  it.each([
    {},
    { JOY_MEDIA_RELEASE_COMMIT_SHA: 'not-a-sha' },
    {
      JOY_MEDIA_RELEASE_COMMIT_SHA: releaseIdentity.commitSha,
      JOY_MEDIA_RELEASE_TREE_HASH: releaseIdentity.treeHash,
      JOY_MEDIA_RELEASE_LOCKFILE_SHA256: 'not-a-digest',
      JOY_MEDIA_RELEASE_SCHEMA_VERSION: String(EXPECTED_RELEASE_SCHEMA_VERSION),
    },
    {
      JOY_MEDIA_RELEASE_COMMIT_SHA: releaseIdentity.commitSha,
      JOY_MEDIA_RELEASE_TREE_HASH: releaseIdentity.treeHash,
      JOY_MEDIA_RELEASE_LOCKFILE_SHA256: releaseIdentity.lockfileSha256,
      JOY_MEDIA_RELEASE_SCHEMA_VERSION: '0',
    },
    {
      JOY_MEDIA_RELEASE_COMMIT_SHA: releaseIdentity.commitSha,
      JOY_MEDIA_RELEASE_TREE_HASH: releaseIdentity.treeHash,
      JOY_MEDIA_RELEASE_LOCKFILE_SHA256: releaseIdentity.lockfileSha256,
      JOY_MEDIA_RELEASE_SCHEMA_VERSION: String(EXPECTED_RELEASE_SCHEMA_VERSION + 1),
    },
  ])('rejects partial or invalid release metadata without projecting it', (environment) => {
    expect(releaseIdentityFromEnvironment(environment)).toBeUndefined();
  });
});
