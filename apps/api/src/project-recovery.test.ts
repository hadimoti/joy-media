import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { LocalControlPlane } from './control-plane.js';
import { PostgresControlPlane } from './postgres-control-plane.js';

const sourceDocument = (projectId: string, title: string) => ({
  schemaVersion: 2 as const,
  projectId,
  title,
  project: { id: projectId, title },
  timeline: { id: `timeline-${projectId}`, clips: [] },
});

describe('recovered project copies', () => {
  it('creates an isolated rewritten copy and replays it idempotently in memory', async () => {
    const api = new LocalControlPlane();
    const owner = { id: 'recovery-owner' };
    api.createProject(owner, 'recovery-source', 'Source');
    await api.appendProjectRevision(owner, 'recovery-source', {
      baseRevision: 0,
      idempotencyKey: 'source-1',
      document: sourceDocument('recovery-source', 'Original'),
    });
    await api.appendProjectRevision(owner, 'recovery-source', {
      baseRevision: 1,
      idempotencyKey: 'source-2',
      document: sourceDocument('recovery-source', 'Changed'),
    });
    const input = {
      baseRevision: 1,
      idempotencyKey: 'recover-1',
      suggestedName: 'Recovered Name',
      operation: { kind: 'append' as const, document: sourceDocument('stale', 'Draft') },
    };
    const result = await api.createRecoveredCopy(owner, 'recovery-source', input);
    expect(result).toMatchObject({
      kind: 'recovered-copy',
      name: 'Recovered Name',
      basedOnRevision: 1,
      serverRevision: 1,
      provenance: { sourceProjectId: 'recovery-source', sourceHeadRevision: 2 },
    });
    expect(result.document).toMatchObject({
      projectId: result.projectId,
      title: 'Recovered Name',
      project: { id: result.projectId, title: 'Recovered Name' },
      timeline: { id: result.projectId },
    });
    await expect(api.getProjectDocument(owner, 'recovery-source')).resolves.toMatchObject({
      revision: 2,
      document: sourceDocument('recovery-source', 'Changed'),
    });
    await expect(api.createRecoveredCopy(owner, 'recovery-source', input)).resolves.toEqual(result);
    await expect(
      api.createRecoveredCopy(owner, 'recovery-source', { ...input, suggestedName: 'Other' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      api.createRecoveredCopy(owner, 'recovery-source', {
        ...input,
        idempotencyKey: 'fresh',
        baseRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(
      api.createRecoveredCopy({ id: 'other' }, 'recovery-source', input),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('requires an initialized source head strictly newer than the base revision', async () => {
    const api = new LocalControlPlane();
    const owner = { id: 'recovery-stale-owner' };
    api.createProject(owner, 'empty-source', 'Empty');
    const request = {
      baseRevision: 0,
      idempotencyKey: 'empty-recovery',
      suggestedName: 'Copy',
      operation: { kind: 'append' as const, document: sourceDocument('old', 'Draft') },
    };
    await expect(api.createRecoveredCopy(owner, 'empty-source', request)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      details: { currentRevision: 0 },
    });
    await api.appendProjectRevision(owner, 'empty-source', {
      baseRevision: 0,
      idempotencyKey: 'empty-source-1',
      document: sourceDocument('empty-source', 'Initialized'),
    });
    await expect(
      api.createRecoveredCopy(owner, 'empty-source', {
        ...request,
        idempotencyKey: 'future',
        baseRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT', details: { currentRevision: 1 } });
    await expect(
      api.createRecoveredCopy(owner, 'empty-source', {
        ...request,
        idempotencyKey: 'equal',
        baseRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT', details: { currentRevision: 1 } });
  });

  it('restores a source revision durably across control-plane instances', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const first = new PostgresControlPlane(pool, { skipLocked: false });
    await first.initialize();
    const owner = { id: 'recovery-pg-owner' };
    await first.createProject(owner, 'recovery-pg-source', 'Source');
    await first.appendProjectRevision(owner, 'recovery-pg-source', {
      baseRevision: 0,
      idempotencyKey: 'pg-source-1',
      document: sourceDocument('recovery-pg-source', 'One'),
    });
    await first.appendProjectRevision(owner, 'recovery-pg-source', {
      baseRevision: 1,
      idempotencyKey: 'pg-source-2',
      document: sourceDocument('recovery-pg-source', 'Two'),
    });
    const result = await first.createRecoveredCopy(owner, 'recovery-pg-source', {
      baseRevision: 1,
      idempotencyKey: 'pg-recover-1',
      suggestedName: 'Restored',
      operation: { kind: 'restore', targetRevision: 1 },
    });
    const restarted = new PostgresControlPlane(pool, { skipLocked: false });
    await expect(
      restarted.createRecoveredCopy(owner, 'recovery-pg-source', {
        baseRevision: 1,
        idempotencyKey: 'pg-recover-1',
        suggestedName: 'Restored',
        operation: { kind: 'restore', targetRevision: 1 },
      }),
    ).resolves.toEqual(result);
    await expect(restarted.getProjectDocument(owner, result.projectId)).resolves.toMatchObject({
      revision: 1,
      document: { projectId: result.projectId, title: 'Restored' },
    });
    await expect(restarted.getProjectDocument(owner, 'recovery-pg-source')).resolves.toMatchObject({
      revision: 2,
      document: sourceDocument('recovery-pg-source', 'Two'),
    });
  });

  it('hides cross-owner duplicate project creation in PostgreSQL', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const api = new PostgresControlPlane(pool, { skipLocked: false });
    await api.initialize();
    const owner = { id: 'duplicate-owner' };
    await api.createProject(owner, 'duplicate-project', 'Project');
    await expect(api.createProject(owner, 'duplicate-project', 'Project')).rejects.toMatchObject({
      code: 'PROJECT_EXISTS',
    });
    await expect(
      api.createProject({ id: 'other-owner' }, 'duplicate-project', 'Project'),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
});
