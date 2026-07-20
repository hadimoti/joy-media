import { describe, expect, it } from 'vitest';
import { TeamCollaborationStore } from './index.js';

describe('team collaboration store', () => {
  it('keeps team-library versions immutable and separate from project snapshots', () => {
    const store = new TeamCollaborationStore();
    const asset = {
      id: 'brand.logo',
      version: '1.0.0',
      kind: 'brand' as const,
      displayName: 'JOY logo',
      metadata: { color: 'amber' },
    };
    expect(store.publishAsset(asset)).toEqual(asset);
    (asset.metadata as { color: string }).color = 'changed outside';
    expect(store.listAssets('brand')[0]?.metadata).toEqual({ color: 'amber' });
    expect(store.publishAsset({ ...asset, metadata: {} })).toBeUndefined();
  });

  it('compares immutable project versions and supports a non-mutating branch', () => {
    const store = new TeamCollaborationStore();
    const v1 = { id: 'v1', snapshot: { title: 'Draft', clips: [{ id: 'a', startUs: 0 }] } };
    const v2 = {
      id: 'v2',
      parentId: 'v1',
      snapshot: { title: 'Final', clips: [{ id: 'a', startUs: 10 }] },
    };
    expect(store.createVersion(v1)).toEqual(v1);
    (v1.snapshot.clips[0] as { startUs: number }).startUs = 999;
    expect(store.createVersion(v2)).toEqual(v2);
    expect(
      store.createBranch({ id: 'alt', baseVersionId: 'v1', snapshot: { title: 'Alt' } }),
    ).toMatchObject({ id: 'alt' });
    const comparison = store.compareVersions('v1', 'v2')!;
    expect(comparison).toMatchObject({
      equal: false,
      changedPaths: ['/clips/0/startUs', '/title'],
    });
    expect(v1.snapshot).toEqual({ title: 'Draft', clips: [{ id: 'a', startUs: 999 }] });
  });

  it('anchors approvals to a project version, proxy asset, and integer timecode', () => {
    const store = new TeamCollaborationStore();
    store.createVersion({ id: 'v1', snapshot: {} });
    expect(
      store.addReview({
        id: 'r1',
        projectVersionId: 'v1',
        proxyAssetId: 'proxy-1',
        timeUs: 1_250_000,
        authorId: 'editor',
        comment: 'Trim this beat',
      }),
    ).toMatchObject({ status: 'open' });
    expect(
      store.addReview({
        id: 'bad',
        projectVersionId: 'v1',
        proxyAssetId: 'proxy-1',
        timeUs: 1.5,
        authorId: 'editor',
        comment: 'Bad clock',
      }),
    ).toBeUndefined();
    expect(store.decideReview('r1', 'lead', 'changes-requested')).toMatchObject({
      status: 'changes-requested',
      decisionBy: 'lead',
    });
    expect(store.decideReview('r1', 'lead', 'approved')).toBeUndefined();
  });
});
