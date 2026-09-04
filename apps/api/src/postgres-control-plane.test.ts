import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import {
  SHARED_LIBRARY_OWNER_ID,
  LocalControlPlane,
  MAX_WORKER_ATTEMPTS,
} from './control-plane.js';
import { PostgresControlPlane } from './postgres-control-plane.js';

describe('PostgresControlPlane', () => {
  it('renames a project with a real SQL revision CAS and rejects stale updates', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const owner = { id: 'rename-owner' };

    await controlPlane.createProject(owner, 'rename-project', 'Before');
    await expect(
      controlPlane.updateProject(owner, 'rename-project', 'After', 0),
    ).resolves.toMatchObject({ title: 'After', revision: 1 });
    await expect(
      controlPlane.updateProject(owner, 'rename-project', 'Stale', 0),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(controlPlane.getProject(owner, 'rename-project')).resolves.toMatchObject({
      title: 'After',
      revision: 1,
    });
    await pool.end();
  });

  it('durably preserves project, lease, completion, and cursor events across instances', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const first = new PostgresControlPlane(pool, { skipLocked: false });
    await first.initialize();
    const owner = { id: 'joy-user-1' };

    await expect(first.createProject(owner, 'project-1', 'Reference')).resolves.toMatchObject({
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
    const initialLease = await first.lease('worker-1', 101, 30_000);
    expect(initialLease).toMatchObject({
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
    const workerDerivative = {
      id: 'derivative-job-1',
      assetId: 'asset-1',
      kind: 'thumbnail' as const,
      profile: 'jpeg-640',
      sha256: 'a'.repeat(64),
      bytes: 1024,
      descriptor: { mimeType: 'image/jpeg', width: 640, height: 360 },
      availability: 'available-cloud' as const,
      locations: [{ kind: 'private-object' as const, ref: 'worker-object-1' }],
    };
    await expect(
      restarted.registerWorkerCloudDerivative(
        'worker-1',
        'job-1',
        workerDerivative,
        101,
        initialLease?.leaseToken,
      ),
    ).resolves.toMatchObject({ id: 'derivative-job-1', verifiedAt: 101 });
    await expect(
      restarted.registerWorkerCloudDerivative(
        'worker-1',
        'job-1',
        workerDerivative,
        102,
        initialLease?.leaseToken,
      ),
    ).resolves.toMatchObject({ id: 'derivative-job-1', verifiedAt: 101 });
    await expect(
      restarted.registerWorkerCloudDerivative(
        'worker-1',
        'job-1',
        { ...workerDerivative, profile: 'different-profile' },
        102,
        initialLease?.leaseToken,
      ),
    ).rejects.toMatchObject({ code: 'DERIVATIVE_EXISTS' });
    await expect(
      restarted.complete(
        'worker-1',
        'job-1',
        102,
        realThumbnailReceipt(),
        initialLease?.leaseToken,
      ),
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
    const retriedLease = await afterCompletionRestart.lease('worker-1', 104, 30_000);
    expect(retriedLease).toMatchObject({
      id: 'job-1',
      assetId: 'asset-1',
      state: 'leased',
      generation: 1,
    });
    await expect(
      afterCompletionRestart.complete(
        'worker-1',
        'job-1',
        105,
        realThumbnailReceipt(),
        initialLease?.leaseToken,
      ),
    ).rejects.toMatchObject({ code: 'LEASE_NOT_OWNED' });
    await expect(
      afterCompletionRestart.complete(
        'worker-1',
        'job-1',
        106,
        realThumbnailReceipt(),
        retriedLease?.leaseToken,
      ),
    ).rejects.toMatchObject({ code: 'DERIVATIVE_NOT_READY' });
    await expect(
      afterCompletionRestart.registerWorkerCloudDerivative(
        'worker-1',
        'job-1',
        workerDerivative,
        106,
        retriedLease?.leaseToken,
      ),
    ).resolves.toMatchObject({ id: 'derivative-job-1-g1' });
    await expect(
      afterCompletionRestart.complete(
        'worker-1',
        'job-1',
        107,
        realThumbnailReceipt(),
        retriedLease?.leaseToken,
      ),
    ).resolves.toMatchObject({ state: 'completed', generation: 1 });
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

  it('projects completed render exports with their verified cloud derivative', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const owner = { id: 'render-export-owner' };
    const projectId = 'render-export-project';
    const assetId = 'render-export-source';
    const jobId = 'render-export-job';
    const payload = {
      schemaVersion: 1,
      producer: 'browser-staged-preview-export',
      frameCount: 3,
      manifest: {
        projectId,
        revision: 0,
        width: 64,
        height: 36,
        frameRate: 30,
        durationUs: 100_000,
        preset: 'social-h264-aac',
      },
    } as const;
    await controlPlane.createProject(owner, projectId, 'Render export');
    await controlPlane.registerAsset(owner, projectId, {
      ...assetRegistration(),
      id: assetId,
      locations: [{ kind: 'private-object' as const, ref: 'render-source-object' }],
    });
    await controlPlane.pairWorker(owner, 'render-export-worker');
    await controlPlane.helloWorker('render-export-worker', ['render.export'], [], 100);
    await controlPlane.enqueue(owner, jobId, projectId, 'render.export', 100, assetId, payload);
    const lease = await controlPlane.lease('render-export-worker', 101, 30_000);
    expect(lease).toMatchObject({ id: jobId, state: 'leased', assetId });
    const receipt = {
      kind: 'render.export' as const,
      assetId,
      sha256: 'b'.repeat(64),
      bytes: 2048,
      localRef: 'export-render-export-job',
      descriptor: { mimeType: 'video/mp4' as const, width: 64, height: 36, durationUs: 100_000 },
    };
    await expect(
      controlPlane.registerWorkerCloudDerivative(
        'render-export-worker',
        jobId,
        {
          id: 'upload-render-export-job',
          assetId,
          kind: 'proxy',
          profile: 'joy-export-h264-aac',
          sha256: receipt.sha256,
          bytes: receipt.bytes,
          descriptor: receipt.descriptor,
          availability: 'available-cloud',
          locations: [{ kind: 'private-object' as const, ref: 'render-export-object' }],
        },
        102,
        lease?.leaseToken,
      ),
    ).resolves.toMatchObject({ id: `derivative-${jobId}`, kind: 'proxy' });
    await expect(
      controlPlane.complete('render-export-worker', jobId, 103, receipt, lease?.leaseToken),
    ).resolves.toMatchObject({ state: 'completed' });
    await expect(controlPlane.jobsForProject(owner, projectId)).resolves.toMatchObject([
      {
        id: jobId,
        state: 'completed',
        derivative: {
          id: `derivative-${jobId}`,
          kind: 'render.export',
          assetId,
          descriptor: receipt.descriptor,
          resultRef: `derivative:${jobId}`,
        },
      },
    ]);
    await pool.end();
  });

  it('requires a render-export source and matching Worker capability', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const owner = { id: 'render-export-contract-owner' };
    const projectId = 'render-export-contract-project';
    const payload = {
      schemaVersion: 1,
      producer: 'browser-staged-preview-export',
      frameCount: 3,
      manifest: {
        projectId,
        revision: 0,
        width: 64,
        height: 36,
        frameRate: 30,
        durationUs: 100_000,
        preset: 'social-h264-aac',
      },
    } as const;
    await controlPlane.createProject(owner, projectId, 'Render export contract');
    await expect(
      controlPlane.enqueue(
        owner,
        'render-export-missing-source',
        projectId,
        'render.export',
        100,
        undefined,
        payload,
      ),
    ).rejects.toMatchObject({ code: 'ASSET_JOB_INVALID' });
    const assetId = 'render-export-contract-source';
    await controlPlane.registerAsset(owner, projectId, {
      ...assetRegistration(),
      id: assetId,
      locations: [{ kind: 'private-object' as const, ref: 'render-contract-source-object' }],
    });
    await controlPlane.enqueue(
      owner,
      'render-export-capability-job',
      projectId,
      'render.export',
      100,
      assetId,
      payload,
    );
    await controlPlane.pairWorker(owner, 'render-export-incapable-worker');
    await controlPlane.helloWorker('render-export-incapable-worker', ['asset.thumbnail'], [], 100);
    await expect(
      controlPlane.lease('render-export-incapable-worker', 101),
    ).resolves.toBeUndefined();
    await controlPlane.pairWorker(owner, 'render-export-capable-worker');
    await controlPlane.helloWorker('render-export-capable-worker', ['render.export'], [], 100);
    await expect(controlPlane.lease('render-export-capable-worker', 101)).resolves.toMatchObject({
      id: 'render-export-capability-job',
      assetId,
      state: 'leased',
    });
    await pool.end();
  });

  it('does not complete a job after cancellation and closes the attempt on fail', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const owner = { id: 'cancel-race-owner' };
    await controlPlane.createProject(owner, 'cancel-race-project', 'Cancel race');
    await controlPlane.pairWorker(owner, 'cancel-race-worker');
    await controlPlane.enqueue(owner, 'cancel-race-job', 'cancel-race-project', 'render', 100);
    const lease = await controlPlane.lease('cancel-race-worker', 101, 30_000);
    await expect(
      controlPlane.cancel(owner, 'cancel-race-project', 'cancel-race-job', 102),
    ).resolves.toMatchObject({ state: 'leased', cancelRequested: true });
    await expect(
      controlPlane.complete(
        'cancel-race-worker',
        'cancel-race-job',
        103,
        { kind: 'malformed' } as never,
        lease?.leaseToken,
      ),
    ).rejects.toMatchObject({ code: 'JOB_CANCEL_REQUESTED' });
    await expect(
      controlPlane.fail(
        'cancel-race-worker',
        'cancel-race-job',
        'canceled',
        104,
        lease?.leaseToken,
      ),
    ).resolves.toMatchObject({ state: 'canceled', cancelRequested: false });
    await expect(
      pool.query<{ completed_at: Date | null }>(
        'SELECT completed_at FROM job_attempts WHERE job_id = $1',
        ['cancel-race-job'],
      ),
    ).resolves.toMatchObject({
      rows: [expect.objectContaining({ completed_at: expect.anything() })],
    });
    await pool.end();
  });

  it('persists Worker attempt limits, re-leases below the limit, and terminalizes exhaustion', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const owner = { id: 'attempt-owner' };
    await controlPlane.createProject(owner, 'attempt-project', 'Attempts');
    await controlPlane.pairWorker(owner, 'attempt-worker');
    await expect(
      controlPlane.enqueue(
        owner,
        'invalid-attempt-job',
        'attempt-project',
        'render',
        100,
        undefined,
        undefined,
        0,
      ),
    ).rejects.toMatchObject({ code: 'JOB_PAYLOAD_INVALID' });
    await controlPlane.enqueue(
      owner,
      'attempt-job',
      'attempt-project',
      'render',
      100,
      undefined,
      undefined,
      2,
    );

    await expect(controlPlane.jobsForProject(owner, 'attempt-project')).resolves.toMatchObject([
      { id: 'attempt-job', maxAttempts: 2, state: 'queued' },
    ]);
    await expect(controlPlane.lease('attempt-worker', 101, 1)).resolves.toMatchObject({
      state: 'leased',
    });
    await expect(controlPlane.lease('attempt-worker', 103, 1)).resolves.toMatchObject({
      id: 'attempt-job',
      maxAttempts: 2,
      state: 'leased',
    });
    await expect(controlPlane.lease('attempt-worker', 105, 30_000)).resolves.toBeUndefined();

    const [job] = await controlPlane.jobsForProject(owner, 'attempt-project');
    expect(job).toMatchObject({
      id: 'attempt-job',
      maxAttempts: 2,
      state: 'failed',
      error: 'Worker attempt budget exhausted',
    });
    expect(job).not.toHaveProperty('leaseOwner');
    expect(job).not.toHaveProperty('leaseExpiresAt');
    await expect(
      controlPlane.retry(owner, 'attempt-project', 'attempt-job', 106),
    ).resolves.toMatchObject({
      state: 'queued',
      generation: 1,
    });
    await expect(controlPlane.eventsAfter(owner, 'attempt-project', 0)).resolves.toMatchObject([
      { type: 'queued' },
      { type: 'leased' },
      { type: 'leased' },
      { type: 'failed' },
      { type: 'retried' },
    ]);
    const attempts = await pool.query<{ readonly completed_at: Date | null }>(
      'SELECT completed_at FROM job_attempts WHERE job_id = $1 ORDER BY id',
      ['attempt-job'],
    );
    expect(attempts.rows).toHaveLength(2);
    expect(attempts.rows[0]?.completed_at).toEqual(new Date(103));
    expect(attempts.rows[1]?.completed_at).toEqual(new Date(105));

    await controlPlane.createProject(owner, 'range-project', 'Attempt range');
    await expect(
      controlPlane.enqueue(
        owner,
        'maximum-attempt-job',
        'range-project',
        'render',
        107,
        undefined,
        undefined,
        MAX_WORKER_ATTEMPTS,
      ),
    ).resolves.toMatchObject({ maxAttempts: MAX_WORKER_ATTEMPTS });
    await expect(
      controlPlane.enqueue(
        owner,
        'oversized-attempt-job',
        'range-project',
        'render',
        107,
        undefined,
        undefined,
        MAX_WORKER_ATTEMPTS + 1,
      ),
    ).rejects.toMatchObject({ code: 'JOB_PAYLOAD_INVALID' });
    await controlPlane.registerAsset(owner, 'range-project', assetRegistration());
    await expect(
      controlPlane.enqueueAssetThumbnail(
        owner,
        'bounded-thumbnail-job',
        'range-project',
        'asset-1',
        108,
        1,
      ),
    ).resolves.toMatchObject({ maxAttempts: 1 });
    const unboundedThumbnail = await controlPlane.enqueueAssetThumbnail(
      owner,
      'unbounded-thumbnail-job',
      'range-project',
      'asset-1',
      108,
    );
    expect(unboundedThumbnail).not.toHaveProperty('maxAttempts');
    await pool.end();
  });

  it('fails closed when a persisted job contains an invalid attempt budget', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const owner = { id: 'invalid-persisted-attempt-owner' };
    await controlPlane.createProject(
      owner,
      'invalid-persisted-attempt-project',
      'Invalid attempts',
    );
    await pool.query(
      `INSERT INTO jobs
         (id, project_id, type, payload, max_attempts, state, lease_owner, lease_expires_at)
       VALUES ($1, $2, 'render', '{}', 0, 'queued', NULL, NULL)`,
      ['invalid-persisted-attempt-job', 'invalid-persisted-attempt-project'],
    );

    await expect(
      controlPlane.jobsForProject(owner, 'invalid-persisted-attempt-project'),
    ).rejects.toMatchObject({ code: 'DATABASE_ERROR' });
    await pool.end();
  });

  it('keeps personal backups private and reference-counts cloud objects on delete', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const owner = { id: 'owner' };
    const peer = { id: 'peer' };
    const publisher = { id: SHARED_LIBRARY_OWNER_ID };
    await controlPlane.createProject(owner, 'personal', 'Personal');
    await controlPlane.createProject(publisher, 'library', 'Library');
    await controlPlane.registerAsset(owner, 'personal', cloudAsset('personal-a', 'orig-shared'));
    await controlPlane.registerAsset(owner, 'personal', cloudAsset('personal-b', 'orig-shared'));
    await controlPlane.registerAsset(publisher, 'library', cloudAsset('library-a', 'orig-library'));

    await expect(controlPlane.sharedCloudAssets(peer)).resolves.toMatchObject([
      { id: 'library-a' },
    ]);
    await expect(controlPlane.sharedCloudAsset(peer, 'personal-a')).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    });
    await expect(controlPlane.sharedCloudAsset(owner, 'personal-a')).resolves.toMatchObject({
      id: 'personal-a',
    });
    await expect(controlPlane.setAssetSync(owner, 'personal', false)).rejects.toMatchObject({
      code: 'ASSET_SYNC_REQUIRED',
    });
    await expect(controlPlane.deleteAsset(owner, 'personal', 'personal-a')).resolves.toMatchObject({
      orphanedPrivateObjectRefs: [],
    });
    await expect(controlPlane.deleteAsset(owner, 'personal', 'personal-b')).resolves.toMatchObject({
      orphanedPrivateObjectRefs: ['orig-shared'],
    });
    await pool.end();
  });

  it('associates durable library assets with a target project and scopes Worker jobs there', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const owner = { id: 'association-owner' };
    const peer = { id: 'association-peer' };
    await controlPlane.createProject(owner, 'source', 'Source');
    await controlPlane.createProject(owner, 'target', 'Target');
    await controlPlane.createProject({ id: SHARED_LIBRARY_OWNER_ID }, 'library', 'Library');
    await controlPlane.registerAsset(owner, 'source', {
      ...cloudAsset('owner-cloud', 'owner-ref'),
    });
    await controlPlane.registerAsset(owner, 'source', {
      ...cloudAsset('owner-cloud-image', 'owner-image-ref'),
      kind: 'image',
      displayName: 'owner-image.png',
      descriptor: { mimeType: 'image/png', width: 1920, height: 1080 },
    });
    await controlPlane.registerAsset({ id: SHARED_LIBRARY_OWNER_ID }, 'library', {
      ...cloudAsset('shared-cloud', 'shared-ref'),
    });

    await expect(
      controlPlane.associateAsset(owner, 'target', 'owner-cloud'),
    ).resolves.toMatchObject({
      id: 'owner-cloud',
      projectId: 'target',
    });
    await expect(
      controlPlane.associateAsset(owner, 'target', 'owner-cloud-image'),
    ).resolves.toMatchObject({
      id: 'owner-cloud-image',
      projectId: 'target',
    });
    await expect(
      controlPlane.associateAsset(owner, 'target', 'shared-cloud'),
    ).resolves.toMatchObject({
      id: 'shared-cloud',
      projectId: 'target',
    });
    await expect(controlPlane.assetsForProject(owner, 'target')).resolves.toMatchObject([
      { id: 'owner-cloud', projectId: 'target' },
      { id: 'shared-cloud', projectId: 'target' },
      { id: 'owner-cloud-image', projectId: 'target' },
    ]);
    await expect(controlPlane.associateAsset(peer, 'target', 'owner-cloud')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    await expect(
      controlPlane.enqueueAssetThumbnail(owner, 'associated-job', 'target', 'owner-cloud'),
    ).resolves.toMatchObject({ projectId: 'target', assetId: 'owner-cloud' });
    await expect(
      controlPlane.enqueue(
        owner,
        'associated-mask',
        'target',
        'mask.image',
        0,
        'owner-cloud-image',
        {
          schemaVersion: 1,
          provider: 'birefnet',
          selection: { mode: 'subject' },
        },
      ),
    ).resolves.toMatchObject({ projectId: 'target', assetId: 'owner-cloud-image' });
    await expect(
      controlPlane.attachCloudOriginal(owner, 'target', 'owner-cloud', {
        kind: 'private-object',
        ref: 'must-not-replace-source',
      }),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    await expect(controlPlane.deleteAsset(owner, 'target', 'owner-cloud')).resolves.toMatchObject({
      id: 'owner-cloud',
      orphanedPrivateObjectRefs: [],
    });
    await expect(controlPlane.assetsForProject(owner, 'target')).resolves.toMatchObject([
      { id: 'shared-cloud', projectId: 'target' },
      { id: 'owner-cloud-image', projectId: 'target' },
    ]);
    await expect(
      controlPlane.deleteAsset(owner, 'target', 'owner-cloud-image'),
    ).resolves.toMatchObject({
      id: 'owner-cloud-image',
      orphanedPrivateObjectRefs: [],
    });
    await expect(controlPlane.assetsForProject(owner, 'target')).resolves.toMatchObject([
      { id: 'shared-cloud', projectId: 'target' },
    ]);
    await pool.end();
  });

  it('scopes associated-asset deletion to the current target project', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const owner = { id: 'association-lifecycle-owner' };
    await controlPlane.createProject(owner, 'source', 'Source');
    await controlPlane.createProject(owner, 'target-a', 'Target A');
    await controlPlane.createProject(owner, 'target-2', 'Target 2');
    await controlPlane.registerAsset(owner, 'source', {
      ...cloudAsset('lifecycle-cloud', 'lifecycle-ref'),
    });
    await controlPlane.associateAsset(owner, 'target-a', 'lifecycle-cloud');
    await controlPlane.associateAsset(owner, 'target-2', 'lifecycle-cloud');
    await controlPlane.enqueueAssetThumbnail(owner, 'target-a-job', 'target-a', 'lifecycle-cloud');
    await controlPlane.enqueueAssetThumbnail(owner, 'target-2-job', 'target-2', 'lifecycle-cloud');
    await controlPlane.registerLocalDerivative(owner, 'target-2', {
      id: 'target-derivative',
      assetId: 'lifecycle-cloud',
      kind: 'thumbnail',
      profile: 'jpeg-640',
      sha256: 'b'.repeat(64),
      bytes: 1024,
      descriptor: { mimeType: 'image/jpeg', width: 640, height: 360 },
      availability: 'available-local',
      locations: [{ kind: 'opfs-cache', ref: 'target-derivative-cache' }],
    });
    await expect(
      controlPlane.deleteAsset(owner, 'target-a', 'lifecycle-cloud'),
    ).resolves.toMatchObject({
      id: 'lifecycle-cloud',
      orphanedPrivateObjectRefs: [],
    });
    await expect(controlPlane.assetsForProject(owner, 'target-a')).resolves.toHaveLength(0);
    await expect(controlPlane.jobsForProject(owner, 'target-a')).resolves.toMatchObject([
      { id: 'target-a-job', state: 'canceled' },
    ]);
    await expect(controlPlane.assetsForProject(owner, 'target-2')).resolves.toMatchObject([
      { id: 'lifecycle-cloud', projectId: 'target-2' },
    ]);
    await expect(controlPlane.jobsForProject(owner, 'target-2')).resolves.toMatchObject([
      { id: 'target-2-job', state: 'queued' },
    ]);
    await expect(
      controlPlane.derivativesForAsset(owner, 'target-2', 'lifecycle-cloud'),
    ).resolves.toHaveLength(1);
    await expect(controlPlane.assetsForProject(owner, 'source')).resolves.toMatchObject([
      { id: 'lifecycle-cloud', projectId: 'source' },
    ]);
    await pool.end();
  });

  it('rejects deleting a source asset or project while another project still references it', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const owner = { id: 'association-lifecycle-owner' };
    await controlPlane.createProject(owner, 'source', 'Source');
    await controlPlane.createProject(owner, 'target-2', 'Target 2');
    await controlPlane.registerAsset(owner, 'source', {
      ...cloudAsset('lifecycle-cloud', 'lifecycle-ref'),
    });
    await controlPlane.associateAsset(owner, 'target-2', 'lifecycle-cloud');
    await expect(
      controlPlane.deleteAsset(owner, 'source', 'lifecycle-cloud'),
    ).rejects.toMatchObject({
      code: 'ASSET_REFERENCED',
    });
    await controlPlane.trashProject(owner, 'source', 0, 20);
    await expect(controlPlane.deleteProject(owner, 'source')).rejects.toMatchObject({
      code: 'PROJECT_REFERENCED',
    });
    await expect(controlPlane.assetsForOwner(owner)).resolves.toMatchObject([
      { id: 'lifecycle-cloud', projectId: 'source' },
    ]);
    await expect(controlPlane.assetsForProject(owner, 'target-2')).resolves.toHaveLength(0);
    await pool.end();
  });

  it('duplicates durable media and enforces the trash lifecycle transactionally', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const owner = { id: 'owner-lifecycle' };
    await controlPlane.createProject(owner, 'source', 'Source');
    await controlPlane.createProject(owner, 'other', 'Other');
    await controlPlane.registerAsset(owner, 'source', cloudAsset('source-asset', 'shared-ref'));
    await controlPlane.registerAsset(owner, 'other', cloudAsset('other-asset', 'shared-ref'));
    await controlPlane.enqueue(owner, 'source-job', 'source', 'render', 100);

    const copy = await controlPlane.duplicateProject(owner, 'source', 'copy', 'Copy', 0);
    expect(copy.project).toMatchObject({ id: 'copy', title: 'Copy' });
    expect(copy.assetIdMap['source-asset']).toEqual(expect.any(String));
    await expect(controlPlane.assetsForProject(owner, 'copy')).resolves.toHaveLength(1);

    await expect(controlPlane.trashProject(owner, 'source', 0, 200)).resolves.toMatchObject({
      revision: 1,
      trashedAt: 200,
    });
    await expect(controlPlane.jobsForProject(owner, 'source')).resolves.toMatchObject([
      { id: 'source-job', state: 'canceled' },
    ]);
    await expect(controlPlane.restoreProject(owner, 'source', 1)).resolves.toMatchObject({
      revision: 2,
    });
    await controlPlane.trashProject(owner, 'source', 2, 300);
    await expect(controlPlane.deleteProject(owner, 'source')).resolves.toMatchObject({
      id: 'source',
      orphanedPrivateObjectRefs: [],
    });
    await expect(controlPlane.getProject(owner, 'source')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    await expect(controlPlane.assetsForProject(owner, 'copy')).resolves.toHaveLength(1);
    await pool.end();
  });

  it.skip('creative brief opt-in defaults to false and can be enabled/disabled', async () => {
    const controlPlane = new LocalControlPlane();
    const owner = { id: 'opt-in-owner' };
    const peer = { id: 'opt-in-peer' };

    // Create project - should default to false
    controlPlane.createProject(owner, 'opt-in-project', 'OptIn Project');
    expect(controlPlane.getCreativeBriefOptIn(owner, 'opt-in-project')).toBe(false);

    // Peer cannot read opt-in status
    expect(() => controlPlane.getCreativeBriefOptIn(peer, 'opt-in-project')).toThrow(
      expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
    );

    // Enable opt-in
    const project = controlPlane.createProject(owner, 'opt-in-project-2', 'OptIn Project 2');
    const enabled = controlPlane.setCreativeBriefOptIn(
      owner,
      'opt-in-project-2',
      true,
      project.revision,
    );
    expect(enabled.creativeBriefOptIn).toBe(true);
    expect(enabled.revision).toBe(project.revision + 1);
    expect(controlPlane.getCreativeBriefOptIn(owner, 'opt-in-project-2')).toBe(true);

    // Disable opt-in
    const disabled = controlPlane.setCreativeBriefOptIn(
      owner,
      'opt-in-project-2',
      false,
      enabled.revision,
    );
    expect(disabled.creativeBriefOptIn).toBe(false);
    expect(disabled.revision).toBe(enabled.revision + 1);
    expect(controlPlane.getCreativeBriefOptIn(owner, 'opt-in-project-2')).toBe(false);

    // Peer cannot change opt-in
    expect(() =>
      controlPlane.setCreativeBriefOptIn(peer, 'opt-in-project-2', true, disabled.revision),
    ).toThrow(expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }));

    // Revision conflict
    expect(() => controlPlane.setCreativeBriefOptIn(owner, 'opt-in-project-2', true, 0)).toThrow(
      expect.objectContaining({ code: 'REVISION_CONFLICT' }),
    );

    // Unknown project
    expect(() => controlPlane.getCreativeBriefOptIn(owner, 'unknown-project')).toThrow(
      expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
    );
  });

  it.skip('treats a legacy true boolean without the current consent version as opted out', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in)
       VALUES ($1, $2, $3, 0, true, true)`,
      ['legacy-consent-project', 'legacy-owner', 'Legacy consent'],
    );

    await expect(
      controlPlane.getCreativeBriefOptIn({ id: 'legacy-owner' }, 'legacy-consent-project'),
    ).resolves.toBe(false);
    await pool.end();
  });

  it.skip('updates creative brief opt-in using the lifecycle revision CAS value', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const owner = { id: 'postgres-opt-in-owner' };

    const created = await controlPlane.createProject(owner, 'postgres-opt-in-project', 'Opt-in');
    const enabled = await controlPlane.setCreativeBriefOptIn(
      owner,
      created.id,
      true,
      created.revision,
    );

    expect(enabled.creativeBriefOptIn).toBe(true);
    expect(enabled.revision).toBe(created.revision + 1);
    await expect(controlPlane.getCreativeBriefOptIn(owner, created.id)).resolves.toBe(true);
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

function cloudAsset(id: string, ref: string) {
  return {
    ...assetRegistration(),
    id,
    bytes: 1024,
    locations: [{ kind: 'private-object' as const, ref }],
  };
}

// ============================================================================
// Project Document Store Tests (WP-37 S4-F10-E5-D2-A)
// ============================================================================

describe('PostgresControlPlane project document storage - reads', () => {
  const owner = { id: 'pg-owner' };
  const otherOwner = { id: 'pg-other' };
  const projectId = 'pg-project';
  const revisionId1 = 'rev-1';
  const revisionId2 = 'rev-2';

  function createValidDocument(title: string) {
    return {
      schemaVersion: 1,
      id: projectId,
      title,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      rootCompositionId: 'comp-1',
      settings: { defaultLocale: 'en' },
      compositions: {
        'comp-1': {
          id: 'comp-1',
          name: 'Main',
          width: 1920,
          height: 1080,
          pixelAspectRatio: { num: 1, den: 1 },
          frameRate: { num: 30, den: 1 },
          durationUs: 1_000_000,
          background: '#00000000',
          tracks: [],
        },
      },
      assets: {},
      variables: {},
      markers: [],
      visualObjects: {},
      captionDocuments: {},
      pluginData: {},
    };
  }

  it('readProjectDocument returns not-found for unknown project', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    const result = await api.readProjectDocument(owner, 'unknown-project');
    expect(result.kind).toBe('not-found');
    if (result.kind === 'not-found') {
      expect(result.projectId).toBe('unknown-project');
      expect(result.revisionId).toBeNull();
    }
  });

  it('readProjectDocument returns not-found for non-owner', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, revisionId1],
    );

    await pool.query(
      `INSERT INTO project_documents (project_id, revision_id, schema_version, document, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [projectId, revisionId1, 1, JSON.stringify({ schemaVersion: 1, id: projectId })],
    );

    const result = await api.readProjectDocument(otherOwner, projectId);
    expect(result.kind).toBe('not-found');
    if (result.kind === 'not-found') {
      expect(result.projectId).toBe(projectId);
    }
  });

  it('readProjectDocument returns not-found when no current head', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, null],
    );

    const result = await api.readProjectDocument(owner, projectId);
    expect(result.kind).toBe('not-found');
    if (result.kind === 'not-found') {
      expect(result.projectId).toBe(projectId);
    }
  });

  it('readProjectDocument reads current head when no revision specified', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    const doc1 = createValidDocument('Version 1');

    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, revisionId1],
    );

    await pool.query(
      `INSERT INTO project_documents (project_id, revision_id, schema_version, document, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [projectId, revisionId1, 1, JSON.stringify(doc1)],
    );

    const result = await api.readProjectDocument(owner, projectId);
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.record.projectId).toBe(projectId);
      expect(result.record.ownerId).toBe(owner.id);
      expect(result.record.revisionId).toBe(revisionId1);
      expect((result.record.document as any).title).toBe('Version 1');
    }
  });

  it('readProjectDocument reads historical revision when specified', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    const doc1 = createValidDocument('Version 1');
    const doc2 = createValidDocument('Version 2');

    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, revisionId2],
    );

    await pool.query(
      `INSERT INTO project_documents (project_id, revision_id, schema_version, document, created_at)
       VALUES
       ($1, $2, $3, $4, NOW()),
       ($5, $6, $7, $8, NOW())`,
      [
        projectId,
        revisionId1,
        1,
        JSON.stringify(doc1),
        projectId,
        revisionId2,
        1,
        JSON.stringify(doc2),
      ],
    );

    const result = await api.readProjectDocument(owner, projectId, revisionId1);
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.record.revisionId).toBe(revisionId1);
      expect((result.record.document as any).title).toBe('Version 1');
    }
  });

  it('readProjectDocument returns stale-revision for unknown revision', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    const doc1 = createValidDocument('Version 1');

    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, revisionId1],
    );

    await pool.query(
      `INSERT INTO project_documents (project_id, revision_id, schema_version, document, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [projectId, revisionId1, 1, JSON.stringify(doc1)],
    );

    const result = await api.readProjectDocument(owner, projectId, 'unknown-revision');
    expect(result.kind).toBe('stale-revision');
    if (result.kind === 'stale-revision') {
      expect(result.projectId).toBe(projectId);
      expect(result.requestedRevisionId).toBe('unknown-revision');
      expect(result.currentRevisionId).toBe(revisionId1);
    }
  });

  it('readProjectDocument returns unavailable for corrupt document JSON', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, revisionId1],
    );

    // pg-mem validates jsonb, so we use valid JSON that will fail schema validation
    await pool.query(
      `INSERT INTO project_documents (project_id, revision_id, schema_version, document, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [projectId, revisionId1, 1, '{"invalid": true}'],
    );

    const result = await api.readProjectDocument(owner, projectId);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.message).toBe('Project document store is unavailable');
    }
  });

  it('readProjectDocument returns unavailable for invalid document schema', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, revisionId1],
    );

    await pool.query(
      `INSERT INTO project_documents (project_id, revision_id, schema_version, document, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [projectId, revisionId1, 1, '{"schemaVersion":999}'],
    );

    const result = await api.readProjectDocument(owner, projectId);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.message).toBe('Project document store is unavailable');
    }
  });

  it('listProjectRevisions returns empty for unknown project', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    const result = await api.listProjectRevisions(owner, 'unknown-project');
    expect(result).toEqual([]);
  });

  it('listProjectRevisions returns empty for non-owner', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, revisionId1],
    );

    await pool.query(
      `INSERT INTO project_documents (project_id, revision_id, schema_version, document, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [projectId, revisionId1, 1, '{}'],
    );

    const result = await api.listProjectRevisions(otherOwner, projectId);
    expect(result).toEqual([]);
  });

  it('listProjectRevisions returns all revisions in deterministic order', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    const doc1 = createValidDocument('Version 1');
    const doc2 = createValidDocument('Version 2');

    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, revisionId2],
    );

    await pool.query(
      `INSERT INTO project_documents (project_id, revision_id, schema_version, document, created_at)
       VALUES
       ($1, $2, $3, $4, $5),
       ($6, $7, $8, $9, $10)`,
      [
        projectId,
        revisionId1,
        1,
        JSON.stringify(doc1),
        new Date(Date.now() - 3600000).toISOString(),
        projectId,
        revisionId2,
        1,
        JSON.stringify(doc2),
        new Date().toISOString(),
      ],
    );

    const result = await api.listProjectRevisions(owner, projectId);
    expect(result).toContain(revisionId1);
    expect(result).toContain(revisionId2);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(revisionId1);
    expect(result[1]).toBe(revisionId2);
  });
});

// WP-37 S4-F10-E5-D2-B: Write tests
describe('PostgresControlPlane project document storage - writes', () => {
  const owner = { id: 'pg-write-owner' };
  const otherOwner = { id: 'pg-write-other' };
  const projectId = 'pg-write-project';
  const revisionId1 = 'rev-1';
  const revisionId2 = 'rev-2';

  function createValidDocument(title: string) {
    return {
      schemaVersion: 1,
      id: projectId,
      title,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      rootCompositionId: 'comp-1',
      settings: { defaultLocale: 'en' },
      compositions: {
        'comp-1': {
          id: 'comp-1',
          name: 'Main',
          width: 1920,
          height: 1080,
          pixelAspectRatio: { num: 1, den: 1 },
          frameRate: { num: 30, den: 1 },
          durationUs: 1_000_000,
          background: '#00000000',
          tracks: [],
        },
      },
      assets: {},
      variables: {},
      markers: [],
      visualObjects: {},
      captionDocuments: {},
      pluginData: {},
    };
  }

  it('writeProjectDocument stores initial document and updates head', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    // Create project first
    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, null],
    );

    const doc = createValidDocument('Initial');
    const result = await api.writeProjectDocument(
      owner,
      {
        projectId,
        ownerId: owner.id,
        revisionId: revisionId1,
        document: doc,
      },
      '',
    );

    expect(result.kind).toBe('stored');
    if (result.kind === 'stored') {
      expect(result.projectId).toBe(projectId);
      expect(result.ownerId).toBe(owner.id);
      expect(result.revisionId).toBe(revisionId1);
    }

    // Verify head was updated
    const headResult = await pool.query<{ document_revision_id: string }>(
      'SELECT document_revision_id FROM projects WHERE id = $1',
      [projectId],
    );
    expect(headResult.rows.length).toBeGreaterThan(0);
    expect(headResult.rows[0]!.document_revision_id).toBe(revisionId1);

    // Verify document was stored
    const docResult = await pool.query<{ document: string }>(
      'SELECT document FROM project_documents WHERE project_id = $1 AND revision_id = $2',
      [projectId, revisionId1],
    );
    expect(docResult.rows.length).toBe(1);
    const storedDoc =
      typeof docResult.rows[0]!.document === 'string'
        ? JSON.parse(docResult.rows[0]!.document)
        : docResult.rows[0]!.document;
    expect((storedDoc as any).title).toBe('Initial');

    await pool.end();
  });

  it('writeProjectDocument stores second revision with CAS', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    // Create project with initial document
    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, revisionId1],
    );
    const doc1 = createValidDocument('Version 1');
    await pool.query(
      `INSERT INTO project_documents (project_id, revision_id, schema_version, document, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [projectId, revisionId1, 1, JSON.stringify(doc1)],
    );

    const doc2 = createValidDocument('Version 2');
    const result = await api.writeProjectDocument(
      owner,
      {
        projectId,
        ownerId: owner.id,
        revisionId: revisionId2,
        document: doc2,
      },
      revisionId1,
    );

    expect(result.kind).toBe('stored');
    if (result.kind === 'stored') {
      expect(result.revisionId).toBe(revisionId2);
    }

    // Verify head was updated
    const headResult = await pool.query<{ document_revision_id: string }>(
      'SELECT document_revision_id FROM projects WHERE id = $1',
      [projectId],
    );
    expect(headResult.rows.length).toBeGreaterThan(0);
    expect(headResult.rows[0]!.document_revision_id).toBe(revisionId2);

    // Verify both documents exist
    const docsResult = await pool.query<{ revision_id: string }>(
      'SELECT revision_id FROM project_documents WHERE project_id = $1 ORDER BY created_at',
      [projectId],
    );
    expect(docsResult.rows.map((r) => r.revision_id)).toEqual([revisionId1, revisionId2]);

    await pool.end();
  });

  it('writeProjectDocument returns revision-conflict on CAS mismatch', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    // Create project with initial document
    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, revisionId1],
    );
    const doc1 = createValidDocument('Version 1');
    await pool.query(
      `INSERT INTO project_documents (project_id, revision_id, schema_version, document, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [projectId, revisionId1, 1, JSON.stringify(doc1)],
    );

    const doc2 = createValidDocument('Version 2');
    const result = await api.writeProjectDocument(
      owner,
      {
        projectId,
        ownerId: owner.id,
        revisionId: revisionId2,
        document: doc2,
      },
      'wrong-base-revision',
    );

    expect(result.kind).toBe('revision-conflict');
    if (result.kind === 'revision-conflict') {
      expect(result.projectId).toBe(projectId);
      expect(result.expectedBaseRevisionId).toBe('wrong-base-revision');
      expect(result.actualBaseRevisionId).toBe(revisionId1);
    }

    // Verify no new document was inserted
    const docsResult = await pool.query<{ revision_id: string }>(
      'SELECT revision_id FROM project_documents WHERE project_id = $1',
      [projectId],
    );
    expect(docsResult.rows.length).toBe(1);
    expect(docsResult.rows[0]!.revision_id).toBe(revisionId1);

    await pool.end();
  });

  it('writeProjectDocument returns not-found for unknown project', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    const doc = createValidDocument('Test');
    const result = await api.writeProjectDocument(
      owner,
      {
        projectId: 'unknown-project',
        ownerId: owner.id,
        revisionId: revisionId1,
        document: doc,
      },
      '',
    );

    expect(result.kind).toBe('not-found');
    if (result.kind === 'not-found') {
      expect(result.projectId).toBe('unknown-project');
    }

    await pool.end();
  });

  it('writeProjectDocument returns owner-denied for non-owner', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    // Create project owned by owner
    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, null],
    );

    const doc = createValidDocument('Test');
    const result = await api.writeProjectDocument(
      otherOwner,
      {
        projectId,
        ownerId: otherOwner.id,
        revisionId: revisionId1,
        document: doc,
      },
      '',
    );

    expect(result.kind).toBe('owner-denied');
    if (result.kind === 'owner-denied') {
      expect(result.projectId).toBe(projectId);
      expect(result.ownerId).toBe(owner.id);
      expect(result.callerId).toBe(otherOwner.id);
    }

    // Verify no document was stored
    const docsResult = await pool.query<{ revision_id: string }>(
      'SELECT revision_id FROM project_documents WHERE project_id = $1',
      [projectId],
    );
    expect(docsResult.rows.length).toBe(0);

    await pool.end();
  });

  it('writeProjectDocument returns owner-denied when record ownerId does not match project', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    // Create project owned by owner
    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, null],
    );

    const doc = createValidDocument('Test');
    const result = await api.writeProjectDocument(
      owner,
      {
        projectId,
        ownerId: otherOwner.id, // Mismatch!
        revisionId: revisionId1,
        document: doc,
      },
      '',
    );

    expect(result.kind).toBe('owner-denied');
    if (result.kind === 'owner-denied') {
      expect(result.projectId).toBe(projectId);
      expect(result.ownerId).toBe(owner.id);
      expect(result.callerId).toBe(owner.id);
    }

    await pool.end();
  });

  it('writeProjectDocument returns invalid-document for invalid record', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    // Create project
    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, null],
    );

    // Invalid document (empty object)
    const result = await api.writeProjectDocument(
      owner,
      {
        projectId,
        ownerId: owner.id,
        revisionId: revisionId1,
        document: {},
      },
      '',
    );

    expect(result.kind).toBe('invalid-document');
    if (result.kind === 'invalid-document') {
      expect(result.projectId).toBe(projectId);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }

    // Verify no document was stored
    const docsResult = await pool.query<{ revision_id: string }>(
      'SELECT revision_id FROM project_documents WHERE project_id = $1',
      [projectId],
    );
    expect(docsResult.rows.length).toBe(0);

    await pool.end();
  });

  it('writeProjectDocument uses parameterized SQL', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    // Create project with a special ID that could cause SQL injection if not parameterized
    const maliciousProjectId = "project'; DROP TABLE projects; --";
    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [maliciousProjectId, owner.id, 'Test', 0, true, false, null],
    );

    const doc = createValidDocument('Test');
    const result = await api.writeProjectDocument(
      owner,
      {
        projectId: maliciousProjectId,
        ownerId: owner.id,
        revisionId: revisionId1,
        document: doc,
      },
      '',
    );

    expect(result.kind).toBe('stored');

    // Verify project still exists (no injection occurred)
    const projectResult = await pool.query<{ id: string }>(
      'SELECT id FROM projects WHERE id = $1',
      [maliciousProjectId],
    );
    expect(projectResult.rows.length).toBe(1);
    expect(projectResult.rows[0]!.id).toBe(maliciousProjectId);

    await pool.end();
  });

  it('readProjectDocument can read historical revision after write', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    // Create project
    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, null],
    );

    // Write first revision
    const doc1 = createValidDocument('Version 1');
    await api.writeProjectDocument(
      owner,
      {
        projectId,
        ownerId: owner.id,
        revisionId: revisionId1,
        document: doc1,
      },
      '',
    );

    // Write second revision
    const doc2 = createValidDocument('Version 2');
    await api.writeProjectDocument(
      owner,
      {
        projectId,
        ownerId: owner.id,
        revisionId: revisionId2,
        document: doc2,
      },
      revisionId1,
    );

    // Read historical revision
    const result = await api.readProjectDocument(owner, projectId, revisionId1);
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.record.revisionId).toBe(revisionId1);
      expect((result.record.document as any).title).toBe('Version 1');
    }

    await pool.end();
  });

  it('writeProjectDocument rolls back on database failure during insert', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();

    // Create project
    await pool.query(
      `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, creative_brief_opt_in, document_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, owner.id, 'Test', 0, true, false, null],
    );

    // We can't easily simulate a database failure in pg-mem, but we can verify
    // that the transaction is atomic by checking that partial writes don't occur.
    // Write a document with a duplicate revision_id (which should fail due to PK constraint)
    const doc = createValidDocument('Test');

    // First write should succeed
    const result1 = await api.writeProjectDocument(
      owner,
      {
        projectId,
        ownerId: owner.id,
        revisionId: revisionId1,
        document: doc,
      },
      '',
    );
    expect(result1.kind).toBe('stored');

    // Second write with same revision_id should fail
    const result2 = await api.writeProjectDocument(
      owner,
      {
        projectId,
        ownerId: owner.id,
        revisionId: revisionId1, // Same revision ID
        document: doc,
      },
      revisionId1,
    );
    expect(result2.kind).toBe('unavailable'); // PK violation causes unavailable

    // Head should still be revisionId1 (not updated to revisionId1 again, but the write failed)
    const headResult = await pool.query<{ document_revision_id: string | null }>(
      'SELECT document_revision_id FROM projects WHERE id = $1',
      [projectId],
    );
    expect(headResult.rows.length).toBeGreaterThan(0);
    expect(headResult.rows[0]!.document_revision_id).toBe(revisionId1);

    // Only one document should exist
    const docsResult = await pool.query<{ revision_id: string }>(
      'SELECT revision_id FROM project_documents WHERE project_id = $1',
      [projectId],
    );
    expect(docsResult.rows.length).toBe(1);

    await pool.end();
  });
});
