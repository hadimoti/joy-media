import { describe, expect, it } from 'vitest';
import { RevisionHistory, StaticRevisionHistoryAuthorization } from './revision-history.js';

const authorization = new StaticRevisionHistoryAuthorization({
  owner: ['revision.root.create', 'revision.accept', 'revision.reject'],
  editor: ['revision.propose'],
});

describe('revision history', () => {
  it('accepts only fast-forward proposals and preserves a stale proposal as a conflict', () => {
    const history = new RevisionHistory(authorization);
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
        actorId: 'editor',
        snapshot: { title: 'B' },
      }),
    ).toMatchObject({ status: 'pending' });
    expect(
      history.propose({
        id: 'stale',
        projectId: 'project',
        baseRevisionId: 'r0',
        actorId: 'editor',
        snapshot: { title: 'C' },
      }),
    ).toMatchObject({ status: 'pending' });
    expect(history.accept('editor', 'r1')).toBeUndefined();
    expect(history.accept('owner', 'r1')).toMatchObject({ status: 'accepted' });
    expect(history.accept('owner', 'stale')).toMatchObject({ status: 'conflicted' });
    expect(history.head('project')).toMatchObject({
      id: 'r1',
      parentId: 'r0',
      snapshot: { title: 'B' },
    });
    expect(history.revision('r0')).toMatchObject({ snapshot: { title: 'A' } });
  });

  it('rejects proposals against a non-head base and lets a pending proposal be rejected explicitly', () => {
    const history = new RevisionHistory(authorization);
    history.createRoot({ id: 'r0', projectId: 'project', actorId: 'owner', snapshot: {} });
    expect(
      history.propose({
        id: 'bad',
        projectId: 'project',
        baseRevisionId: 'missing',
        actorId: 'editor',
        snapshot: {},
      }),
    ).toBeUndefined();
    history.propose({
      id: 'r1',
      projectId: 'project',
      baseRevisionId: 'r0',
      actorId: 'editor',
      snapshot: {},
    });
    expect(history.reject('owner', 'r1')).toMatchObject({ status: 'rejected' });
    expect(history.head('project')).toMatchObject({ id: 'r0' });
    const reopened = new RevisionHistory(authorization, history.snapshot());
    expect(reopened.head('project')).toEqual(history.head('project'));
    expect(reopened.audit()).toEqual(history.audit());
  });
});
