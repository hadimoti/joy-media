import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { PostgresControlPlane } from './postgres-control-plane.js';
import type { PrivateObjectStore } from './private-object-store.js';
import { deliveryPromiseFromManifest } from '@joy-media/production-quality';

describe('PostgresControlPlane', () => {
  it('durably revokes asset access, cancels jobs, snapshots refs, and purges every historical object', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const removed: string[] = [];
    const store: PrivateObjectStore = {
      put: async () => undefined,
      get: async () => new Uint8Array(),
      remove: async (ref) => {
        removed.push(ref);
      },
    };
    const api = new PostgresControlPlane(pool, { skipLocked: false, privateObjectStore: store });
    await api.initialize();
    const owner = { id: 'revoke-owner' };
    await api.createProject(owner, 'revoke-project', 'Revoke');
    const asset = {
      ...assetRegistration(),
      kind: 'image' as const,
      descriptor: { mimeType: 'image/png' as const, width: 640, height: 360 },
      locations: [
        { kind: 'opfs-cache' as const, ref: 'opfs-revoke' },
        { kind: 'private-object' as const, ref: 'original-old' },
      ],
    };
    await api.registerAsset(owner, 'revoke-project', asset, 100);
    await api.setAssetSync(owner, 'revoke-project', true);
    await api.attachCloudOriginal(owner, 'revoke-project', 'asset-1', {
      kind: 'private-object',
      ref: 'original-new',
    });
    await api.createPairingOffer('revoke-worker', 'pairing', 10_000);
    await api.approvePairing(owner, 'revoke-worker', 'pairing', 101);
    await api.claimWorkerSession('revoke-worker', 'pairing', 'session', 20_000, 102);
    await api.helloWorker('revoke-worker', ['asset.thumbnail'], ['asset-1'], 103);
    await api.enqueueAssetThumbnail(owner, 'leased-revoke', 'revoke-project', 'asset-1', 105);
    await api.enqueueAssetThumbnail(owner, 'queued-revoke', 'revoke-project', 'asset-1', 104);
    const leased = await api.lease('revoke-worker', 106, 30_000);
    expect(leased?.id).toBeDefined();
    await pool.query(
      `INSERT INTO media_derivatives
         (id, project_id, asset_id, kind, profile, sha256, byte_length, descriptor, availability, locations, verified_at)
       VALUES ('cloud-derivative-revoke', 'revoke-project', 'asset-1', 'thumbnail', 'jpeg-640', $1, 1024,
         '{"mimeType":"image/jpeg","width":640,"height":360}'::jsonb, 'available-cloud',
         '[{"kind":"private-object","ref":"derivative-ref"}]'::jsonb, NOW())`,
      [SHA256],
    );

    await expect(api.deleteAsset(owner, 'revoke-project', 'asset-1')).resolves.toEqual({
      id: 'asset-1',
    });
    await expect(api.retry(owner, 'revoke-project', 'queued-revoke')).rejects.toMatchObject({
      code: 'JOB_NOT_RETRYABLE',
    });
    expect(removed).toEqual(['derivative-ref', 'original-new', 'original-old']);
    await expect(api.assetsForProject(owner, 'revoke-project')).resolves.toEqual([]);
    await expect(api.deleteAsset(owner, 'revoke-project', 'asset-1')).resolves.toEqual({
      id: 'asset-1',
    });
    await expect(
      api.assetRevocationAudit(owner, 'revoke-project', 'asset-1'),
    ).resolves.toMatchObject({
      objectRefs: ['derivative-ref', 'original-new', 'original-old'],
      canceledJobIds: ['leased-revoke', 'queued-revoke'],
      purgeState: 'complete',
    });
    await expect(
      api.complete('revoke-worker', leased!.id, 107, realThumbnailReceipt()),
    ).rejects.toMatchObject({
      code: 'LEASE_NOT_OWNED',
    });
    await api.registerAsset(owner, 'revoke-project', {
      ...asset,
      locations: [{ kind: 'opfs-cache', ref: 'opfs-reused' }],
    });
    await api.attachCloudOriginal(owner, 'revoke-project', 'asset-1', {
      kind: 'private-object',
      ref: 'original-reused',
    });
    await api.deleteAsset(owner, 'revoke-project', 'asset-1');
    await expect(
      api.assetRevocationAudit(owner, 'revoke-project', 'asset-1'),
    ).resolves.toMatchObject({
      objectRefs: ['original-reused'],
    });
  });

  it('retains inaccessible state and a redacted retryable audit when purge fails', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const store: PrivateObjectStore = {
      put: async () => undefined,
      get: async () => new Uint8Array(),
      remove: async () => {
        throw new Error('remote object key original-failure must not escape');
      },
    };
    const api = new PostgresControlPlane(pool, { skipLocked: false, privateObjectStore: store });
    await api.initialize();
    const owner = { id: 'failure-owner' };
    await api.createProject(owner, 'failure-project', 'Failure');
    await api.registerAsset(owner, 'failure-project', {
      ...assetRegistration(),
      locations: [
        { kind: 'opfs-cache', ref: 'opfs-failure' },
        { kind: 'private-object', ref: 'original-failure' },
      ],
    });
    await api.stagePrivateObjectReference(
      owner,
      'failure-project',
      'asset-1',
      'original',
      'staged-orphan',
    );
    await expect(api.deleteAsset(owner, 'failure-project', 'asset-1')).resolves.toEqual({
      id: 'asset-1',
    });
    await expect(
      api.assetRevocationAudit(owner, 'failure-project', 'asset-1'),
    ).resolves.toMatchObject({
      purgeState: 'failed',
      purgeError: 'OBJECT_PURGE_FAILED',
    });
    await expect(api.assetsForProject(owner, 'failure-project')).resolves.toEqual([]);
    await expect(api.retryPendingObjectCleanup()).resolves.toBe(0);
    await expect(
      pool.query<{ state: string; last_error: string | null }>(
        `SELECT state, last_error FROM private_object_cleanup_refs WHERE object_ref = 'staged-orphan'`,
      ),
    ).resolves.toMatchObject({
      rows: [{ state: 'pending', last_error: 'OBJECT_CLEANUP_FAILED' }],
    });
  });

  it('retries PostgreSQL revisions idempotently and persists restore metadata', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();
    const owner = { id: 'owner-revisions' };
    await api.createProject(owner, 'revision-project', 'Revisions');
    const document = { schemaVersion: 2 as const, projectId: 'revision-project', title: 'A' };
    const first = await api.appendProjectRevision(owner, 'revision-project', {
      baseRevision: 0,
      idempotencyKey: 'write-1',
      document,
    });
    await expect(
      api.appendProjectRevision(owner, 'revision-project', {
        baseRevision: 0,
        idempotencyKey: 'write-1',
        document,
      }),
    ).resolves.toMatchObject({ revision: first.revision });
    const restored = await api.restoreProjectRevision(owner, 'revision-project', {
      baseRevision: 1,
      revision: 1,
      idempotencyKey: 'restore-1',
    });
    expect(restored.operation).toMatchObject({ kind: 'restore', label: 'restore revision 1' });
    await expect(
      api.restoreProjectRevision(owner, 'revision-project', {
        baseRevision: 1,
        revision: 1,
        idempotencyKey: 'restore-1',
      }),
    ).resolves.toMatchObject({ operation: { kind: 'restore', label: 'restore revision 1' } });
    await expect(
      api.restoreProjectRevision(owner, 'revision-project', {
        baseRevision: 2,
        revision: 1,
        idempotencyKey: 'write-1',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('durably preserves project, lease, completion, and cursor events across instances', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const first = new PostgresControlPlane(pool, { skipLocked: false });
    await first.initialize();
    const owner = { id: 'joy-user-1' };

    await first.createProject(owner, 'project-1', 'Reference');
    await expect(first.getProject(owner, 'project-1')).resolves.toMatchObject({
      id: 'project-1',
      ownerId: owner.id,
      assetSyncEnabled: false,
    });
    await expect(first.getProject({ id: 'joy-user-2' }, 'project-1')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    await expect(first.setAssetSync(owner, 'project-1', true)).resolves.toMatchObject({
      assetSyncEnabled: true,
    });
    await first.registerAsset(owner, 'project-1', assetRegistration(), 99);
    await first.registerLocalDerivative(owner, 'project-1', localDerivativeRegistration(), 100);
    await first.createPairingOffer('worker-1', 'pairing-hash', 10_000);
    await expect(
      first.approvePairing(owner, 'worker-1', 'pairing-hash', 100),
    ).resolves.toMatchObject({
      paired: false,
    });
    await expect(
      first.claimWorkerSession('worker-1', 'pairing-hash', 'session-hash', 20_000, 101),
    ).resolves.toMatchObject({ workerId: 'worker-1' });
    await expect(first.authenticateWorker('session-hash', 102)).resolves.toBe('worker-1');
    await first.helloWorker('worker-1', ['asset.thumbnail'], ['asset-1'], 100);
    await first.enqueueAssetThumbnail(owner, 'job-1', 'project-1', 'asset-1', 100);
    await expect(first.lease('worker-1', 101, 30_000)).resolves.toMatchObject({
      id: 'job-1',
      state: 'leased',
      leaseOwner: 'worker-1',
    });

    const restarted = new PostgresControlPlane(pool, { skipLocked: false });
    await expect(restarted.assetsForProject(owner, 'project-1')).resolves.toMatchObject([
      { id: 'asset-1', bytes: 8_589_934_592, locations: [{ kind: 'opfs-cache', ref: 'opfs-a1' }] },
    ]);
    await expect(
      restarted.derivativesForAsset(owner, 'project-1', 'asset-1'),
    ).resolves.toMatchObject([
      { id: 'derivative-1', availability: 'available-local', verifiedAt: 100 },
    ]);
    await expect(
      restarted.complete('worker-1', 'job-1', 102, realThumbnailReceipt()),
    ).resolves.toMatchObject({
      id: 'job-1',
      state: 'completed',
      derivative: {
        jobId: 'job-1',
        workerRef: 'worker-1',
        resultRef: 'derivative:job-1',
        assetId: 'asset-1',
        localRef: 'thumb-job-1-aaaaaaaaaaaaaaaa',
        verifiedAt: 102,
      },
    });
    await expect(restarted.eventsAfter(owner, 'project-1', 0)).resolves.toMatchObject([
      { type: 'queued' },
      { type: 'leased' },
      { type: 'completed' },
    ]);
    const afterCompletionRestart = new PostgresControlPlane(pool, { skipLocked: false });
    await expect(afterCompletionRestart.jobsForProject(owner, 'project-1')).resolves.toMatchObject([
      {
        id: 'job-1',
        state: 'completed',
        derivative: {
          jobId: 'job-1',
          resultRef: 'derivative:job-1',
          workerRef: 'worker-1',
          assetId: 'asset-1',
          descriptor: { mimeType: 'image/jpeg', width: 640, height: 360 },
          verifiedAt: 102,
        },
      },
    ]);
    await afterCompletionRestart.retry(owner, 'project-1', 'job-1', 103);
    await expect(afterCompletionRestart.jobsForProject(owner, 'project-1')).resolves.toEqual([
      expect.objectContaining({ id: 'job-1', assetId: 'asset-1', state: 'queued', progress: 0 }),
    ]);
    const retried = await afterCompletionRestart.jobsForProject(owner, 'project-1');
    expect(retried[0]?.derivative).toBeUndefined();
    await expect(afterCompletionRestart.lease('worker-1', 104, 30_000)).resolves.toMatchObject({
      id: 'job-1',
      assetId: 'asset-1',
      state: 'leased',
    });
    await pool.end();
  });

  it('rejects a stale Worker completion after another worker re-leases the job', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const owner = { id: 'joy-user-1' };
    await controlPlane.createProject(owner, 'project-1', 'Reference');
    await controlPlane.pairWorker(owner, 'worker-old');
    await controlPlane.pairWorker(owner, 'worker-new');
    await controlPlane.enqueue(owner, 'job-1', 'project-1', 'fixture.thumbnail', 100);
    await controlPlane.lease('worker-old', 101, 5);
    await controlPlane.lease('worker-new', 106, 5);

    await expect(controlPlane.complete('worker-old', 'job-1', 107)).rejects.toMatchObject({
      code: 'LEASE_NOT_OWNED',
    });
    await pool.end();
  });

  it('durably round-trips typed job payloads and render inspect receipts', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const owner = { id: 'joy-user-1' };
    await controlPlane.createProject(owner, 'project-1', 'Reference');
    await controlPlane.pairWorker(owner, 'worker-render');
    await controlPlane.helloWorker('worker-render', ['render.inspect'], [], 100);
    await controlPlane.enqueue(
      owner,
      'render-inspect-1',
      'project-1',
      'render.inspect',
      101,
      undefined,
      {
        protocolVersion: 1,
        jobId: 'render-inspect-1',
        type: 'render.inspect',
        payload: {
          projectRef: 'project-ref-1',
          compositionId: 'composition-main',
          presetId: 'inspect',
          reportRef: 'report-render-inspect-1',
          legacyVersion: 0,
        },
        requirements: { capabilities: ['render.inspect'], privacy: 'local-only' },
        idempotencyKey: 'idem-render-inspect-1',
        maxAttempts: 4,
      },
    );

    const restarted = new PostgresControlPlane(pool, { skipLocked: false });
    await expect(restarted.lease('worker-render', 102, 30_000)).resolves.toMatchObject({
      id: 'render-inspect-1',
      payload: {
        projectRef: 'project-ref-1',
        compositionId: 'composition-main',
        presetId: 'inspect',
        reportRef: 'report-render-inspect-1',
      },
      requirements: { capabilities: ['render.inspect'], privacy: 'local-only' },
      idempotencyKey: 'idem-render-inspect-1',
      maxAttempts: 4,
    });
    await expect(
      restarted.complete('worker-render', 'render-inspect-1', 103, {
        kind: 'render.inspect',
        reportRef: 'report-render-inspect-1',
        findings: 3,
      }),
    ).resolves.toMatchObject({
      derivative: {
        kind: 'render.inspect',
        reportRef: 'report-render-inspect-1',
        findings: 3,
        resultRef: 'derivative:render-inspect-1',
      },
    });

    const afterCompletionRestart = new PostgresControlPlane(pool, { skipLocked: false });
    await expect(afterCompletionRestart.jobsForProject(owner, 'project-1')).resolves.toMatchObject([
      {
        id: 'render-inspect-1',
        state: 'completed',
        derivative: {
          kind: 'render.inspect',
          reportRef: 'report-render-inspect-1',
          findings: 3,
          resultRef: 'derivative:render-inspect-1',
          workerRef: 'worker-render',
        },
      },
    ]);
    await pool.end();
  });

  it('requires typed artifact evidence for new inspect jobs and denies expired artifact reads', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const owner = { id: 'inspect-owner' };
    await controlPlane.createProject(owner, 'inspect-project', 'Inspect');
    await controlPlane.pairWorker(owner, 'worker-export');
    await controlPlane.pairWorker(owner, 'worker-old');
    await controlPlane.pairWorker(owner, 'worker-new');
    await controlPlane.helloWorker('worker-export', ['render.export'], [], 100);
    await controlPlane.helloWorker('worker-old', ['render.inspect'], [], 100);
    await controlPlane.helloWorker('worker-new', ['render.inspect'], [], 100);

    await controlPlane.enqueue(
      owner,
      'export-for-inspect',
      'inspect-project',
      'render.export',
      100,
    );
    await controlPlane.lease('worker-export', 101, 10_000);
    await controlPlane.registerWorkerRenderArtifact(
      'worker-export',
      'export-for-inspect',
      {
        id: 'artifact-export-for-inspect',
        outputRef: 'output-export-for-inspect',
        sha256: 'a'.repeat(64),
        bytes: 1024,
        descriptor: { mimeType: 'video/mp4' },
        location: { kind: 'private-object', ref: 'render-export-for-inspect' },
      },
      101,
    );
    await controlPlane.complete('worker-export', 'export-for-inspect', 102, {
      kind: 'render.export',
      reportRef: 'report-export-for-inspect',
      outputRef: 'output-export-for-inspect',
      sha256: 'a'.repeat(64),
      bytes: 1024,
    });

    const promise = deliveryPromiseFromManifest({
      projectId: 'inspect-project',
      revision: 0,
      width: 640,
      height: 360,
      frameRate: 30,
      durationUs: 1_000_000,
      preset: 'social-h264-aac',
    });
    await controlPlane.enqueue(
      owner,
      'inspect-artifact',
      'inspect-project',
      'render.inspect',
      103,
      undefined,
      {
        protocolVersion: 1,
        jobId: 'inspect-artifact',
        type: 'render.inspect',
        payload: {
          projectRef: 'project-inspect',
          compositionId: 'composition-root',
          presetId: 'preset-social',
          reportRef: 'report-inspect-artifact',
          artifactId: 'artifact-export-for-inspect',
          outputRef: 'output-export-for-inspect',
          promise,
        },
        requirements: { capabilities: ['render.inspect'], privacy: 'local-only' },
        idempotencyKey: 'inspect-artifact',
        maxAttempts: 3,
      },
    );
    await controlPlane.lease('worker-old', 200, 1);
    await expect(
      controlPlane.renderArtifactForWorker(
        'worker-old',
        'inspect-artifact',
        'output-export-for-inspect',
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
    await expect(controlPlane.lease('worker-new', Date.now(), 30_000)).resolves.toMatchObject({
      id: 'inspect-artifact',
    });
    await expect(
      controlPlane.renderArtifactForWorker(
        'worker-new',
        'inspect-artifact',
        'output-export-for-inspect',
      ),
    ).resolves.toMatchObject({ id: 'artifact-export-for-inspect' });
    await expect(
      controlPlane.complete('worker-new', 'inspect-artifact', Date.now(), {
        kind: 'render.inspect',
        reportRef: 'report-inspect-artifact',
        findings: 0,
      }),
    ).rejects.toMatchObject({ code: 'RESULT_INVALID' });
    await expect(
      controlPlane.complete('worker-new', 'inspect-artifact', Date.now(), {
        kind: 'render.inspect',
        reportRef: 'report-inspect-artifact',
        outputRef: 'output-export-for-inspect',
        report: {
          version: 1,
          promiseId: promise.id,
          checkedAt: '2026-08-26T00:00:00.000Z',
          evidenceLevel: 'sampled',
          artifact: {
            outputRef: 'output-export-for-inspect',
            sha256: 'a'.repeat(64),
            bytes: 1024,
          },
          facts: {},
          findings: [],
        },
      }),
    ).resolves.toMatchObject({ state: 'completed' });
    await pool.end();
  });

  it('durably persists a leased render artifact and enforces owner binding', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const first = new PostgresControlPlane(pool, { skipLocked: false });
    await first.initialize();
    const owner = { id: 'joy-user-1' };
    await first.createProject(owner, 'project-1', 'Reference');
    await first.pairWorker(owner, 'worker-render');
    await first.helloWorker('worker-render', ['render.export'], [], 100);
    await first.enqueue(owner, 'render-job-1', 'project-1', 'render.export', 100);
    await first.lease('worker-render', 101, 30_000);
    const artifact = await first.registerWorkerRenderArtifact(
      'worker-render',
      'render-job-1',
      {
        id: 'artifact-render-job-1',
        outputRef: 'render-render-job-1-aaaaaaaaaaaaaaaa',
        sha256: 'a'.repeat(64),
        bytes: 1234,
        descriptor: { mimeType: 'video/mp4' },
        location: { kind: 'private-object', ref: 'render-render-job-1-aaaaaaaaaaaaaaaa' },
      },
      102,
    );
    await first.complete('worker-render', 'render-job-1', 103, {
      kind: 'render.export',
      reportRef: 'report-render-job-1',
      outputRef: artifact.outputRef,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    });
    const restarted = new PostgresControlPlane(pool, { skipLocked: false });
    await expect(
      restarted.renderArtifactForOwner(owner, 'project-1', artifact.id),
    ).resolves.toMatchObject({
      id: artifact.id,
      jobId: 'render-job-1',
      descriptor: { mimeType: 'video/mp4' },
      location: { kind: 'private-object', ref: 'render-render-job-1-aaaaaaaaaaaaaaaa' },
    });
    await expect(
      restarted.renderArtifactForOwner({ id: 'other-owner' }, 'project-1', artifact.id),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await pool.end();
  });

  it('owner-binds private backup catalog reads while retaining the curated library', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const owner = { id: 'owner-a' };
    const peer = { id: 'owner-b' };
    await controlPlane.createProject(owner, 'private-project', 'Private');
    await controlPlane.setAssetSync(owner, 'private-project', true);
    await controlPlane.registerAsset(owner, 'private-project', {
      id: 'private-img',
      kind: 'image',
      displayName: 'Private.png',
      sha256: SHA256,
      bytes: 1200,
      descriptor: { mimeType: 'image/png' },
      locations: [{ kind: 'opfs-cache', ref: 'private-local' }],
    });
    await controlPlane.attachCloudOriginal(owner, 'private-project', 'private-img', {
      kind: 'private-object',
      ref: 'private-object-ref',
    });

    await expect(controlPlane.sharedCloudAssets(owner)).resolves.toMatchObject([
      { id: 'private-img' },
    ]);
    await expect(controlPlane.sharedCloudAssets(peer)).resolves.toHaveLength(0);
    await expect(controlPlane.sharedCloudAsset(peer, 'private-img')).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    });

    const libraryOwner = { id: 'joy-media-library' };
    await controlPlane.createProject(libraryOwner, 'joy-media-alpha-library', 'Curated');
    await controlPlane.registerAsset(libraryOwner, 'joy-media-alpha-library', {
      id: 'curated-img',
      kind: 'image',
      displayName: 'Curated.png',
      sha256: SHA256,
      bytes: 1200,
      descriptor: { mimeType: 'image/png' },
      locations: [{ kind: 'private-object', ref: 'joylib-' + SHA256 }],
    });
    await expect(controlPlane.sharedCloudAssets(peer)).resolves.toMatchObject([
      { id: 'curated-img' },
    ]);
    await expect(controlPlane.sharedCloudAsset(peer, 'curated-img')).resolves.toMatchObject({
      id: 'curated-img',
    });
    await pool.end();
  });
});

function realThumbnailReceipt() {
  return {
    kind: 'asset.thumbnail' as const,
    assetId: 'asset-1',
    sha256: 'a'.repeat(64),
    bytes: 1024,
    localRef: 'thumb-job-1-aaaaaaaaaaaaaaaa',
    descriptor: { mimeType: 'image/jpeg' as const, width: 640, height: 360 },
  };
}

const SHA256 = 'a'.repeat(64);

function assetRegistration() {
  return {
    id: 'asset-1',
    kind: 'video' as const,
    displayName: 'clip.mp4',
    sha256: SHA256,
    bytes: 8_589_934_592,
    descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000, width: 1920, height: 1080 },
    locations: [{ kind: 'opfs-cache' as const, ref: 'opfs-a1' }],
  };
}

function localDerivativeRegistration() {
  return {
    id: 'derivative-1',
    assetId: 'asset-1',
    kind: 'proxy' as const,
    profile: 'h264-720p',
    sha256: SHA256,
    bytes: 1234,
    descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000, width: 1280, height: 720 },
    availability: 'available-local' as const,
    locations: [{ kind: 'opfs-cache' as const, ref: 'opfs-d1' }],
  };
}
