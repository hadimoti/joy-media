import { describe, expect, it } from 'vitest';
import { LocalControlPlane } from './control-plane.js';

const document = (projectId: string, title: string) => ({
  schemaVersion: 2 as const,
  projectId,
  title,
  timeline: { clips: [] },
});

describe('project document revisions', () => {
  it('supports owner-scoped append, idempotent retry, stale rejection, and restore', async () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    api.createProject(owner, 'project-1', 'Project');
    const first = await api.appendProjectRevision(owner, 'project-1', {
      baseRevision: 0,
      idempotencyKey: 'write-1',
      document: document('project-1', 'A'),
    });
    await expect(
      api.appendProjectRevision(owner, 'project-1', {
        baseRevision: 0,
        idempotencyKey: 'write-2',
        document: document('project-1', 'B'),
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(
      api.appendProjectRevision(owner, 'project-1', {
        baseRevision: 0,
        idempotencyKey: 'write-1',
        document: document('project-1', 'A'),
      }),
    ).resolves.toMatchObject({ revision: first.revision });
    const restored = await api.restoreProjectRevision(owner, 'project-1', {
      baseRevision: 1,
      revision: 1,
      idempotencyKey: 'restore-1',
    });
    expect(restored.operation).toMatchObject({ kind: 'restore', label: 'restore revision 1' });
    await expect(
      api.restoreProjectRevision(owner, 'project-1', {
        baseRevision: 1,
        revision: 1,
        idempotencyKey: 'restore-1',
      }),
    ).resolves.toMatchObject({ operation: { kind: 'restore', label: 'restore revision 1' } });
    await expect(api.getProjectDocument(owner, 'project-1')).resolves.toMatchObject({
      revision: 2,
      document: document('project-1', 'A'),
    });
  });

  it('rejects media bytes, filesystem paths, and URLs while allowing opaque refs', async () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    api.createProject(owner, 'project-2', 'Project');
    for (const [key, value] of [
      ['filePath', 'C:/secret.mp4'],
      ['thumbnailUrl', 'https://example.test/a.jpg'],
      ['mediaBytes', 'AAAA'],
    ] as const) {
      await expect(
        api.appendProjectRevision(owner, 'project-2', {
          baseRevision: 0,
          idempotencyKey: `bad-${key}`,
          document: { ...document('project-2', 'bad'), [key]: value },
        }),
      ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    }
    await expect(
      api.appendProjectRevision(owner, 'project-2', {
        baseRevision: 0,
        idempotencyKey: 'good-ref',
        document: {
          ...document('project-2', 'good'),
          assetRef: 'opaque-asset',
          mediaType: 'video/mp4',
        },
      }),
    ).resolves.toMatchObject({ revision: 1 });
  });

  it('includes operation kind and restore source in idempotency identity', async () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    api.createProject(owner, 'identity-project', 'Project');
    const first = document('identity-project', 'same');
    await api.appendProjectRevision(owner, 'identity-project', {
      baseRevision: 0,
      idempotencyKey: 'shared-key',
      document: first,
    });
    await expect(
      api.appendProjectRevision(owner, 'identity-project', {
        baseRevision: 1,
        idempotencyKey: 'next',
        document: first,
      }),
    ).resolves.toMatchObject({ revision: 2 });
    await expect(
      api.restoreProjectRevision(owner, 'identity-project', {
        baseRevision: 2,
        revision: 1,
        idempotencyKey: 'shared-key',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await api.appendProjectRevision(owner, 'identity-project', {
      baseRevision: 2,
      idempotencyKey: 'third',
      document: first,
    });
    await expect(
      api.restoreProjectRevision(owner, 'identity-project', {
        baseRevision: 3,
        revision: 1,
        idempotencyKey: 'restore-key',
      }),
    ).resolves.toMatchObject({ revision: 4 });
    await expect(
      api.restoreProjectRevision(owner, 'identity-project', {
        baseRevision: 4,
        revision: 2,
        idempotencyKey: 'restore-key',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});
