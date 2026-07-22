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
    await first.pairWorker(owner, 'worker-1');
    await first.enqueue(owner, 'job-1', 'project-1', 'asset.thumbnail', 100);
    await expect(first.lease('worker-1', 101, 30_000)).resolves.toMatchObject({
      id: 'job-1',
      state: 'leased',
      leaseOwner: 'worker-1',
    });

    const restarted = new PostgresControlPlane(pool, { skipLocked: false });
    await expect(restarted.complete('worker-1', 'job-1', 102)).resolves.toMatchObject({
      id: 'job-1',
      state: 'completed',
    });
    await expect(restarted.eventsAfter(owner, 'project-1', 0)).resolves.toMatchObject([
      { type: 'queued' },
      { type: 'leased' },
      { type: 'completed' },
    ]);
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
    await controlPlane.enqueue(owner, 'job-1', 'project-1', 'asset.thumbnail', 100);
    await controlPlane.lease('worker-old', 101, 5);
    await controlPlane.lease('worker-new', 106, 5);

    await expect(controlPlane.complete('worker-old', 'job-1', 107)).rejects.toMatchObject({
      code: 'LEASE_NOT_OWNED',
    });
    await pool.end();
  });
});
