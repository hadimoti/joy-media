import { describe, expect, it } from 'vitest';
import {
  LocalControlPlane,
  MAX_WORKER_ATTEMPTS,
  SHARED_LIBRARY_OWNER_ID,
} from './control-plane.js';
describe('local control plane', () => {
  it('leases private mask parameters only to a capable Worker with the source asset', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner-mask' };
    api.createProject(owner, 'mask-project', 'Mask');
    api.registerAsset(owner, 'mask-project', {
      ...assetRegistration(),
      id: 'mask-source',
      kind: 'image',
      displayName: 'subject.png',
      descriptor: { mimeType: 'image/png', width: 640, height: 360 },
    });
    api.pairWorker(owner, 'mask-worker');
    api.helloWorker('mask-worker', ['mask.image'], ['mask-source'], 100);
    api.enqueue(owner, 'mask-job', 'mask-project', 'mask.image', 101, 'mask-source', {
      schemaVersion: 1,
      provider: 'birefnet',
      selection: { mode: 'subject' },
    });
    const leased = api.lease('mask-worker', 102);
    expect(leased).toMatchObject({
      id: 'mask-job',
      payload: {
        schemaVersion: 1,
        provider: 'birefnet',
        selection: { mode: 'subject' },
      },
    });
    api.fail('mask-worker', 'mask-job', 'model unavailable', 103, leased?.leaseToken);
    api.retry(owner, 'mask-project', 'mask-job', 104);
    expect(api.lease('mask-worker', 105)?.payload).toEqual(leased?.payload);
  });
  it('enforces revisions, revocation, leases, and cursored events', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    api.createProject(owner, 'p', 'Project');
    expect(() => api.updateProject(owner, 'p', 'stale', 1)).toThrow(
      expect.objectContaining({ code: 'REVISION_CONFLICT' }),
    );
    api.pairWorker(owner, 'w');
    api.enqueue(owner, 'j', 'p', 'render', 100);
    const leased = api.lease('w', 101, 10);
    expect(leased).toMatchObject({ id: 'j', state: 'leased' });
    api.complete('w', 'j', 102, undefined, leased?.leaseToken);
    expect(api.lease('w', 1_000)).toBeUndefined();
    expect(api.eventsAfter(owner, 'p', 1).map((event) => event.type)).toEqual([
      'leased',
      'completed',
    ]);
    api.revokeWorker(owner, 'w');
    expect(() => api.lease('w')).toThrow(expect.objectContaining({ code: 'WORKER_UNAUTHORIZED' }));
  });

  it('terminalizes an expired lease when its Worker attempt budget is exhausted', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'attempt-owner' };
    api.createProject(owner, 'attempt-project', 'Attempts');
    api.pairWorker(owner, 'attempt-worker');
    api.enqueue(owner, 'attempt-job', 'attempt-project', 'render', 101, undefined, undefined, 1);

    expect(api.lease('attempt-worker', 102, 1)).toMatchObject({ state: 'leased' });
    expect(api.lease('attempt-worker', 104, 30_000)).toBeUndefined();
    const [job] = api.jobsForProject(owner, 'attempt-project');
    expect(job).toMatchObject({
      id: 'attempt-job',
      maxAttempts: 1,
      state: 'failed',
      error: 'Worker attempt budget exhausted',
    });
    expect(job).not.toHaveProperty('leaseOwner');
    expect(job).not.toHaveProperty('leaseExpiresAt');
    expect(api.retry(owner, 'attempt-project', 'attempt-job', 105)).toMatchObject({
      state: 'queued',
      generation: 1,
    });
    expect(api.eventsAfter(owner, 'attempt-project', 0).map((event) => event.type)).toEqual([
      'queued',
      'leased',
      'failed',
      'retried',
    ]);
  });

  it('re-leases an expired job while its Worker attempt budget remains', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'retry-owner' };
    api.createProject(owner, 'retry-project', 'Retries');
    api.pairWorker(owner, 'retry-worker');
    api.enqueue(owner, 'retry-job', 'retry-project', 'render', 101, undefined, undefined, 2);

    expect(api.lease('retry-worker', 102, 1)).toMatchObject({ state: 'leased' });
    expect(api.lease('retry-worker', 104, 30_000)).toMatchObject({
      id: 'retry-job',
      maxAttempts: 2,
      state: 'leased',
    });
    expect(api.eventsAfter(owner, 'retry-project', 0).map((event) => event.type)).toEqual([
      'queued',
      'leased',
      'leased',
    ]);
  });

  it('rejects a stale completion from an older lease of the same Worker', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'same-worker-owner' };
    api.createProject(owner, 'same-worker-project', 'Same worker');
    api.pairWorker(owner, 'same-worker');
    api.enqueue(owner, 'same-worker-job', 'same-worker-project', 'render', 100);
    const first = api.lease('same-worker', 101, 1);
    const second = api.lease('same-worker', 103, 30_000);
    expect(second?.leaseToken).not.toBe(first?.leaseToken);
    expect(() =>
      api.complete('same-worker', 'same-worker-job', 104, undefined, first?.leaseToken),
    ).toThrow(expect.objectContaining({ code: 'LEASE_NOT_OWNED' }));
    expect(
      api.complete('same-worker', 'same-worker-job', 105, undefined, second?.leaseToken),
    ).toMatchObject({
      state: 'completed',
    });
  });

  it('rejects invalid Worker attempt budgets', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'invalid-attempt-owner' };
    api.createProject(owner, 'invalid-attempt-project', 'Invalid attempts');

    expect(() =>
      api.enqueue(
        owner,
        'zero-attempt-job',
        'invalid-attempt-project',
        'render',
        101,
        undefined,
        undefined,
        0,
      ),
    ).toThrow(expect.objectContaining({ code: 'JOB_PAYLOAD_INVALID' }));
    expect(() =>
      api.enqueue(
        owner,
        'fractional-attempt-job',
        'invalid-attempt-project',
        'render',
        101,
        undefined,
        undefined,
        1.5,
      ),
    ).toThrow(expect.objectContaining({ code: 'JOB_PAYLOAD_INVALID' }));
    expect(
      api.enqueue(
        owner,
        'maximum-attempt-job',
        'invalid-attempt-project',
        'render',
        101,
        undefined,
        undefined,
        MAX_WORKER_ATTEMPTS,
      ),
    ).toMatchObject({ maxAttempts: MAX_WORKER_ATTEMPTS });
    expect(() =>
      api.enqueue(
        owner,
        'oversized-attempt-job',
        'invalid-attempt-project',
        'render',
        101,
        undefined,
        undefined,
        MAX_WORKER_ATTEMPTS + 1,
      ),
    ).toThrow(expect.objectContaining({ code: 'JOB_PAYLOAD_INVALID' }));
  });

  it('records opaque asset and local-derivative metadata without accepting paths or cloud claims', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    expect(api.createProject(owner, 'project-1', 'Project')).toMatchObject({
      assetSyncEnabled: true,
    });
    const asset = api.registerAsset(owner, 'project-1', assetRegistration(), 100);
    expect(asset).toMatchObject({
      id: 'asset-1',
      projectId: 'project-1',
      locations: [{ kind: 'opfs-cache', ref: 'opfs-a1' }],
      createdAt: 100,
    });
    expect(JSON.stringify(asset)).not.toMatch(/C:|\\\\|\/Users|https?:\/\//i);

    expect(
      api.registerLocalDerivative(owner, 'project-1', localDerivativeRegistration(), 101),
    ).toMatchObject({
      id: 'derivative-1',
      assetId: 'asset-1',
      availability: 'available-local',
      verifiedAt: 101,
    });
    expect(api.derivativesForAsset(owner, 'project-1', 'asset-1')).toHaveLength(1);
    expect(() =>
      api.registerAsset(owner, 'project-1', {
        ...assetRegistration(),
        id: 'asset-unsafe',
        displayName: 'C:\\Users\\Hadi\\source.mp4',
      }),
    ).toThrow(expect.objectContaining({ code: 'ASSET_INVALID' }));
    expect(() =>
      api.registerLocalDerivative(owner, 'project-1', {
        ...localDerivativeRegistration(),
        id: 'derivative-cloud',
        availability: 'available-cloud',
      } as never),
    ).toThrow(expect.objectContaining({ code: 'DERIVATIVE_INVALID' }));
    expect(() => api.assetsForProject({ id: 'other-owner' }, 'project-1')).toThrow(
      expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
    );
  });

  it('deletes an owned asset and its derivatives; strangers cannot access the project', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    api.createProject(owner, 'project-1', 'Project');
    api.registerAsset(owner, 'project-1', assetRegistration(), 100);
    api.registerLocalDerivative(owner, 'project-1', localDerivativeRegistration(), 101);
    expect(api.deleteAsset(owner, 'project-1', 'asset-1')).toEqual({
      id: 'asset-1',
      orphanedPrivateObjectRefs: [],
    });
    expect(api.assetsForProject(owner, 'project-1')).toHaveLength(0);
    expect(() => api.derivativesForAsset(owner, 'project-1', 'asset-1')).toThrow(
      expect.objectContaining({ code: 'ASSET_NOT_FOUND' }),
    );
    expect(() => api.deleteAsset(owner, 'project-1', 'asset-1')).toThrow(
      expect.objectContaining({ code: 'ASSET_NOT_FOUND' }),
    );
    expect(() => api.deleteAsset({ id: 'other' }, 'project-1', 'asset-1')).toThrow(
      expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
    );
  });

  it('keeps personal cloud backups owner-only', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner-a' };
    const peer = { id: 'owner-b' };
    api.createProject(owner, 'project-a', 'A');
    const image = api.registerAsset(
      owner,
      'project-a',
      {
        id: 'img-1',
        kind: 'image',
        displayName: 'shot.png',
        sha256: SHA256,
        bytes: 1200,
        descriptor: { mimeType: 'image/png' },
        locations: [{ kind: 'opfs-cache', ref: 'opfs-img1' }],
      },
      200,
    );
    expect(api.sharedCloudAssets(peer)).toHaveLength(0);
    api.attachCloudOriginal(owner, 'project-a', image.id, {
      kind: 'private-object',
      ref: 'orig-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(api.sharedCloudAssets(peer)).toHaveLength(0);
    expect(() => api.sharedCloudAsset(peer, 'img-1')).toThrow(
      expect.objectContaining({ code: 'ASSET_NOT_FOUND' }),
    );
    expect(api.sharedCloudAsset(owner, 'img-1').id).toBe('img-1');
  });

  it('lists only service-published originals in the curated cloud library', () => {
    const api = new LocalControlPlane();
    const peer = { id: 'peer-video' };
    const publisher = { id: SHARED_LIBRARY_OWNER_ID };
    api.createProject(publisher, 'project-library', 'Library');
    const video = api.registerAsset(publisher, 'project-library', assetRegistration(), 300);
    api.attachCloudOriginal(publisher, 'project-library', video.id, {
      kind: 'private-object',
      ref: 'orig-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(api.sharedCloudAssets(peer)).toMatchObject([{ id: 'asset-1', kind: 'video' }]);
    expect(api.sharedCloudAsset(peer, 'asset-1').id).toBe('asset-1');
  });

  it('returns only private objects no remaining record references when deleting', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner-delete' };
    const ref = 'orig-shared-content';
    api.createProject(owner, 'project-delete', 'Delete');
    api.registerAsset(owner, 'project-delete', {
      ...assetRegistration(),
      id: 'asset-a',
      locations: [{ kind: 'private-object', ref }],
    });
    api.registerAsset(owner, 'project-delete', {
      ...assetRegistration(),
      id: 'asset-b',
      locations: [{ kind: 'private-object', ref }],
    });

    expect(api.deleteAsset(owner, 'project-delete', 'asset-a').orphanedPrivateObjectRefs).toEqual(
      [],
    );
    expect(api.deleteAsset(owner, 'project-delete', 'asset-b').orphanedPrivateObjectRefs).toEqual([
      ref,
    ]);
  });

  it('keeps mandatory private backup enabled', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner-sync' };
    api.createProject(owner, 'project-sync', 'Sync');
    expect(() => api.setAssetSync(owner, 'project-sync', false)).toThrow(
      expect.objectContaining({ code: 'ASSET_SYNC_REQUIRED' }),
    );
    expect(api.setAssetSync(owner, 'project-sync', true).assetSyncEnabled).toBe(true);
  });

  it('lists every owned asset across projects for the same Joy identity', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner-cross' };
    api.createProject(owner, 'project-chrome', 'Chrome');
    api.createProject(owner, 'project-cursor', 'Cursor');
    api.registerAsset(
      owner,
      'project-chrome',
      {
        id: 'chrome-img',
        kind: 'image',
        displayName: 'a.png',
        sha256: SHA256,
        bytes: 10,
        descriptor: { mimeType: 'image/png' },
        locations: [{ kind: 'opfs-cache', ref: 'opfs-a' }],
      },
      1,
    );
    expect(api.assetsForOwner(owner)).toMatchObject([{ id: 'chrome-img' }]);
    expect(api.assetsForProject(owner, 'project-cursor')).toHaveLength(0);
  });

  it('associates durable owner and shared-library assets without changing their stable IDs', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner-association' };
    const peer = { id: 'peer-association' };
    api.createProject(owner, 'source', 'Source');
    api.createProject(owner, 'target', 'Target');
    api.createProject(owner, 'target-2', 'Target 2');
    api.createProject({ id: SHARED_LIBRARY_OWNER_ID }, 'library', 'Library');
    api.registerAsset(owner, 'source', {
      ...assetRegistration(),
      id: 'owner-cloud-asset',
      locations: [{ kind: 'private-object', ref: 'owner-original' }],
    });
    api.registerAsset({ id: SHARED_LIBRARY_OWNER_ID }, 'library', {
      ...assetRegistration(),
      id: 'shared-cloud-asset',
      locations: [{ kind: 'private-object', ref: 'shared-original' }],
    });
    api.registerAsset(owner, 'source', { ...assetRegistration(), id: 'owner-local-asset' });

    expect(api.associateAsset(owner, 'target', 'owner-cloud-asset')).toMatchObject({
      id: 'owner-cloud-asset',
      projectId: 'target',
    });
    expect(api.assetsForProject(owner, 'target')).toMatchObject([
      { id: 'owner-cloud-asset', projectId: 'target' },
    ]);
    expect(api.associateAsset(owner, 'target', 'shared-cloud-asset')).toMatchObject({
      id: 'shared-cloud-asset',
      projectId: 'target',
    });
    expect(api.assetsForProject(owner, 'target')).toHaveLength(2);
    expect(() => api.associateAsset(peer, 'target', 'owner-cloud-asset')).toThrow(
      expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
    );
    expect(() => api.associateAsset(owner, 'target', 'owner-local-asset')).toThrow(
      expect.objectContaining({ code: 'ASSET_NOT_FOUND' }),
    );

    const job = api.enqueueAssetThumbnail(
      owner,
      'associated-thumbnail',
      'target',
      'owner-cloud-asset',
    );
    expect(job).toMatchObject({ projectId: 'target', assetId: 'owner-cloud-asset' });
    expect(() =>
      api.attachCloudOriginal(owner, 'target', 'owner-cloud-asset', {
        kind: 'private-object',
        ref: 'must-not-replace-source',
      }),
    ).toThrow(expect.objectContaining({ code: 'ASSET_NOT_FOUND' }));
    expect(api.deleteAsset(owner, 'target', 'owner-cloud-asset')).toEqual({
      id: 'owner-cloud-asset',
      orphanedPrivateObjectRefs: [],
    });
    expect(api.assetsForProject(owner, 'target')).toMatchObject([
      { id: 'shared-cloud-asset', projectId: 'target' },
    ]);
  });

  it('removes asset associations when either the source or target project is deleted', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner-association-lifecycle' };
    api.createProject(owner, 'source', 'Source');
    api.createProject(owner, 'target', 'Target');
    api.createProject(owner, 'target-2', 'Target 2');
    api.registerAsset(owner, 'source', {
      ...assetRegistration(),
      id: 'lifecycle-cloud',
      locations: [{ kind: 'private-object', ref: 'lifecycle-original' }],
    });
    api.associateAsset(owner, 'target', 'lifecycle-cloud');
    api.trashProject(owner, 'target', 0, 10);
    expect(api.deleteProject(owner, 'target')).toMatchObject({ id: 'target' });
    expect(api.assetsForProject(owner, 'source')).toMatchObject([{ id: 'lifecycle-cloud' }]);
    api.associateAsset(owner, 'target-2', 'lifecycle-cloud');
    api.trashProject(owner, 'source', 0, 20);
    expect(api.deleteProject(owner, 'source')).toMatchObject({ id: 'source' });
    expect(api.assetsForProject(owner, 'target-2')).toHaveLength(0);
  });

  it('duplicates durable media, cancels queued work on Trash, restores, and purges safely', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner-lifecycle' };
    api.createProject(owner, 'source-project', 'Source');
    api.registerAsset(owner, 'source-project', {
      ...assetRegistration(),
      id: 'source-asset',
      locations: [{ kind: 'private-object', ref: 'orig-shared-content' }],
    });
    api.enqueue(owner, 'source-job', 'source-project', 'render', 100);
    const copied = api.duplicateProject(owner, 'source-project', 'copy-project', 'Copy', 0);
    expect(copied.project.title).toBe('Copy');
    expect(copied.assetIdMap['source-asset']).toBeDefined();
    expect(api.assetsForProject(owner, 'copy-project')).toHaveLength(1);

    const trashed = api.trashProject(owner, 'source-project', 0, 200);
    expect(trashed.trashedAt).toBe(200);
    expect(api.jobsForProject(owner, 'source-project')[0]).toMatchObject({ state: 'canceled' });
    expect(api.getProject(owner, 'source-project')).toMatchObject({ activeJobCount: 0 });
    const restored = api.restoreProject(owner, 'source-project', 1);
    expect(restored.trashedAt).toBeUndefined();
    api.trashProject(owner, 'source-project', 2, 300);
    const deleted = api.deleteProject(owner, 'source-project');
    expect(deleted.orphanedPrivateObjectRefs).toEqual([]);
    expect(() => api.getProject(owner, 'source-project')).toThrow(
      expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
    );
    expect(api.assetsForProject(owner, 'copy-project')).toHaveLength(1);
  });
});

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

// ============================================================================
// Project Document Store Tests (WP-37 S4-F10-E5-C2)
// ============================================================================

describe('LocalControlPlane project document storage', () => {
  it('roundtrip: write then read project document', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'doc-owner' };
    api.createProject(owner, 'doc-project', 'Doc Project');

    const document = {
      schemaVersion: 1,
      id: 'doc-project',
      title: 'Test Document',
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

    const writeResult = api.writeProjectDocument(
      owner,
      {
        projectId: 'doc-project',
        ownerId: 'doc-owner',
        revisionId: 'rev-1',
        document,
      },
      '',
    );

    expect(writeResult.kind).toBe('stored');
    if (writeResult.kind !== 'stored') throw new Error('Expected stored outcome');
    expect(writeResult.projectId).toBe('doc-project');
    expect(writeResult.revisionId).toBe('rev-1');

    const readResult = api.readProjectDocument(owner, 'doc-project');
    expect(readResult.kind).toBe('ready');
    if (readResult.kind !== 'ready') throw new Error('Expected ready outcome');
    expect(readResult.record.projectId).toBe('doc-project');
    expect(readResult.record.revisionId).toBe('rev-1');
    expect(readResult.record.document).toEqual(document);
  });

  it('owner isolation: different owner cannot read document', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'doc-owner' };
    const other = { id: 'other-owner' };
    api.createProject(owner, 'doc-project', 'Doc Project');

    api.writeProjectDocument(
      owner,
      {
        projectId: 'doc-project',
        ownerId: 'doc-owner',
        revisionId: 'rev-1',
        document: { schemaVersion: 1, id: 'doc-project', title: 'Test' },
      },
      '',
    );

    const readResult = api.readProjectDocument(other, 'doc-project');
    expect(readResult.kind).toBe('not-found');
    if (readResult.kind !== 'not-found') throw new Error('Expected not-found outcome');
    expect(readResult.projectId).toBe('doc-project');
  });

  it('CAS conflict: write fails when baseRevision does not match', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'doc-owner' };
    api.createProject(owner, 'doc-project', 'Doc Project');

    api.writeProjectDocument(
      owner,
      {
        projectId: 'doc-project',
        ownerId: 'doc-owner',
        revisionId: 'rev-1',
        document: { schemaVersion: 1, id: 'doc-project', title: 'V1' },
      },
      '',
    );

    const writeResult = api.writeProjectDocument(
      owner,
      {
        projectId: 'doc-project',
        ownerId: 'doc-owner',
        revisionId: 'rev-2',
        document: { schemaVersion: 1, id: 'doc-project', title: 'V2' },
      },
      'wrong-revision',
    );

    expect(writeResult.kind).toBe('revision-conflict');
    if (writeResult.kind !== 'revision-conflict')
      throw new Error('Expected revision-conflict outcome');
    expect(writeResult.expectedBaseRevisionId).toBe('wrong-revision');
    expect(writeResult.actualBaseRevisionId).toBe('rev-1');
  });

  it('unknown project returns not-found on read', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'doc-owner' };

    const readResult = api.readProjectDocument(owner, 'nonexistent');
    expect(readResult.kind).toBe('not-found');
    if (readResult.kind !== 'not-found') throw new Error('Expected not-found outcome');
    expect(readResult.projectId).toBe('nonexistent');
    expect(readResult.revisionId).toBeNull();
  });
});
