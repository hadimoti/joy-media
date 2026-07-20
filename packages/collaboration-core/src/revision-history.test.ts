import { describe, expect, it } from 'vitest';
import { RevisionHistory } from './revision-history.js';

describe('revision history', () => {
  it('accepts only fast-forward proposals and preserves a stale proposal as a conflict', () => {
    const history = new RevisionHistory();
    expect(
      history.createRoot({
        id: 'r0',
        projectId: 'project',
        actorId: 'owner',
        snapshot: { title: 'A' },
      }),
    ).toMatchObject({ id: 'r0' });
    expect(
      history.propose({
        id: 'r1',
        projectId: 'project',
        baseRevisionId: 'r0',
        actorId: 'a',
        snapshot: { title: 'B' },
      }),
    ).toMatchObject({ status: 'pending' });
    expect(
      history.propose({
        id: 'stale',
        projectId: 'project',
        baseRevisionId: 'r0',
        actorId: 'b',
        snapshot: { title: 'C' },
      }),
    ).toMatchObject({ status: 'pending' });
    expect(history.accept('r1')).toMatchObject({ status: 'accepted' });
    expect(history.accept('stale')).toMatchObject({ status: 'conflicted' });
    expect(history.head('project')).toMatchObject({
      id: 'r1',
      parentId: 'r0',
      snapshot: { title: 'B' },
    });
    expect(history.revision('r0')).toMatchObject({ snapshot: { title: 'A' } });
  });

  it('rejects proposals against a non-head base and lets a pending proposal be rejected explicitly', () => {
    const history = new RevisionHistory();
    history.createRoot({ id: 'r0', projectId: 'project', actorId: 'owner', snapshot: {} });
    expect(
      history.propose({
        id: 'bad',
        projectId: 'project',
        baseRevisionId: 'missing',
        actorId: 'a',
        snapshot: {},
      }),
    ).toBeUndefined();
    history.propose({
      id: 'r1',
      projectId: 'project',
      baseRevisionId: 'r0',
      actorId: 'a',
      snapshot: {},
    });
    expect(history.reject('r1')).toMatchObject({ status: 'rejected' });
    expect(history.head('project')).toMatchObject({ id: 'r0' });
  });
});
