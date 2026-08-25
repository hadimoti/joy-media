import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { PostgresControlPlane } from './postgres-control-plane.js';

describe('PostgresControlPlane', () => {
  it('durably preserves project, lease, completion, and cursor events across instances', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const first = new PostgresControlPlane(pool, { skipLocked: false });
    await first.initialize();
    const owner = { id: 'joy-user-1' };

    await first.createProject(owner, 'project-1', 'Reference');
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
