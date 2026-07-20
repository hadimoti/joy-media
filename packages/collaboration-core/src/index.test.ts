import { describe, expect, it } from 'vitest';
import { StaticTeamCollaborationAuthorization, TeamCollaborationStore } from './index.js';

const authorization = new StaticTeamCollaborationAuthorization({
  owner: ['library.publish', 'version.create', 'branch.create'],
  editor: ['version.create', 'branch.create', 'review.create'],
  reviewer: ['review.decide'],
});

describe('team collaboration store', () => {
  it('keeps team-library versions immutable and separate from project snapshots', () => {
    const store = new TeamCollaborationStore(authorization);
    const asset = {
      id: 'brand.logo',
      version: '1.0.0',
      kind: 'brand' as const,
      displayName: 'JOY logo',
      metadata: { color: 'amber' },
    };
    expect(store.publishAsset('owner', asset)).toEqual(asset);
    (asset.metadata as { color: string }).color = 'changed outside';
    expect(store.listAssets('brand')[0]?.metadata).toEqual({ color: 'amber' });
    expect(store.publishAsset('owner', { ...asset, metadata: {} })).toBeUndefined();
    const reopened = new TeamCollaborationStore(authorization, store.snapshot());
    expect(reopened.listAssets()).toEqual(store.listAssets());
  });

  it('compares immutable project versions and supports a non-mutating branch', () => {
    const store = new TeamCollaborationStore(authorization);
    const v1 = { id: 'v1', snapshot: { title: 'Draft', clips: [{ id: 'a', startUs: 0 }] } };
    const v2 = {
      id: 'v2',
      parentId: 'v1',
      snapshot: { title: 'Final', clips: [{ id: 'a', startUs: 10 }] },
    };
    expect(store.createVersion('editor', v1)).toEqual(v1);
    (v1.snapshot.clips[0] as { startUs: number }).startUs = 999;
    expect(store.createVersion('editor', v2)).toEqual(v2);
    expect(
      store.createBranch('editor', { id: 'alt', baseVersionId: 'v1', snapshot: { title: 'Alt' } }),
    ).toMatchObject({ id: 'alt' });
    const comparison = store.compareVersions('v1', 'v2')!;
    expect(comparison).toMatchObject({
      equal: false,
      changedPaths: ['/clips/0/startUs', '/title'],
    });
    expect(v1.snapshot).toEqual({ title: 'Draft', clips: [{ id: 'a', startUs: 999 }] });
    const reopened = new TeamCollaborationStore(authorization, store.snapshot());
    expect(reopened.snapshot()).toEqual(store.snapshot());
  });

  it('anchors approvals to a project version, proxy asset, and integer timecode', () => {
    const store = new TeamCollaborationStore(authorization);
    store.createVersion('editor', { id: 'v1', snapshot: {} });
    expect(
      store.addReview('editor', {
        id: 'r1',
        projectVersionId: 'v1',
        proxyAssetId: 'proxy-1',
        timeUs: 1_250_000,
        comment: 'Trim this beat',
      }),
    ).toMatchObject({ status: 'open' });
    expect(
      store.addReview('editor', {
        id: 'bad',
        projectVersionId: 'v1',
        proxyAssetId: 'proxy-1',
        timeUs: 1.5,
        comment: 'Bad clock',
      }),
    ).toBeUndefined();
    expect(store.decideReview('editor', 'r1', 'changes-requested')).toBeUndefined();
    expect(store.decideReview('reviewer', 'r1', 'changes-requested')).toMatchObject({
      status: 'changes-requested',
      decisionBy: 'reviewer',
    });
    expect(store.decideReview('reviewer', 'r1', 'approved')).toBeUndefined();
    const reopened = new TeamCollaborationStore(authorization, store.snapshot());
    expect(reopened.listReviews()).toEqual(store.listReviews());
    expect(reopened.audit()).toEqual(store.audit());
  });
});
