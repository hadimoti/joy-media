import { describe, expect, it } from 'vitest';
import { LocalControlPlane } from './control-plane.js';
describe('local control plane', () => {
  it('enforces revisions, revocation, leases, and cursored events', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    api.createProject(owner, 'p', 'Project');
    expect(() => api.updateProject(owner, 'p', 'stale', 1)).toThrow(
      expect.objectContaining({ code: 'REVISION_CONFLICT' }),
    );
    api.pairWorker(owner, 'w');
    api.helloWorker('w', ['render.export'], [], 100);
    api.enqueue(owner, 'j', 'p', 'render.export', 100);
    expect(api.lease('w', 101, 10)).toMatchObject({ id: 'j', state: 'leased' });
    api.registerWorkerRenderArtifact(
      'w',
      'j',
      {
        id: 'artifact-j',
        outputRef: 'export-j',
        sha256: 'a'.repeat(64),
        bytes: 1024,
        descriptor: { mimeType: 'video/mp4' },
        location: { kind: 'private-object', ref: 'render-j-aaaaaaaaaaaaaaaa' },
      },
      101,
    );
    api.complete('w', 'j', 102, {
      kind: 'render.export',
      reportRef: 'report-j',
      outputRef: 'export-j',
      sha256: 'a'.repeat(64),
      bytes: 1024,
    });
    expect(api.lease('w', 1_000)).toBeUndefined();
    expect(api.eventsAfter(owner, 'p', 1).map((event) => event.type)).toEqual([
      'leased',
      'completed',
    ]);
    api.revokeWorker(owner, 'w');
    expect(() => api.lease('w')).toThrow(expect.objectContaining({ code: 'WORKER_UNAUTHORIZED' }));
  });

  it('rejects unknown job types, capability-mismatched leases, and duplicate enqueue overwrites', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    api.createProject(owner, 'p', 'Project');
    api.pairWorker(owner, 'w');
    expect(() => api.enqueue(owner, 'bad', 'p', 'unknown.job', 100)).toThrow(
      expect.objectContaining({ code: 'WORKER_JOB_INVALID' }),
    );
    const first = api.enqueue(owner, 'render-1', 'p', 'render.export', 100);
    const second = api.enqueue(owner, 'render-1', 'p', 'render.inspect', 101);
    expect(second).toEqual(first);
    expect(api.lease('w', 102)).toBeUndefined();
    api.helloWorker('w', ['render.inspect'], [], 103);
    expect(api.lease('w', 104)).toBeUndefined();
    api.helloWorker('w', ['render.export'], [], 105);
    expect(api.lease('w', 106)).toMatchObject({ id: 'render-1', type: 'render.export' });
    expect(() =>
      api.complete('w', 'render-1', 107, { kind: 'render.inspect', reportRef: 'r', findings: 0 }),
    ).toThrow(expect.objectContaining({ code: 'RESULT_INVALID' }));
  });

  it('round-trips validated typed Worker jobs through enqueue, lease, and completion receipts', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    api.createProject(owner, 'p', 'Project');
    api.pairWorker(owner, 'w');
    api.helloWorker('w', ['render.inspect'], [], 100);
    const first = api.enqueue(owner, 'render-inspect-1', 'p', 'render.inspect', 101, undefined, {
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
      maxAttempts: 3,
    });
    const duplicate = api.enqueue(owner, 'render-inspect-1', 'p', 'render.export', 102);
    expect(duplicate).toEqual(first);
    expect(api.lease('w', 103)).toMatchObject({
      id: 'render-inspect-1',
      type: 'render.inspect',
      payload: {
        projectRef: 'project-ref-1',
        compositionId: 'composition-main',
        presetId: 'inspect',
        reportRef: 'report-render-inspect-1',
      },
      requirements: { capabilities: ['render.inspect'], privacy: 'local-only' },
      idempotencyKey: 'idem-render-inspect-1',
      maxAttempts: 3,
    });
    expect(
      api.complete('w', 'render-inspect-1', 104, {
        kind: 'render.inspect',
        reportRef: 'report-render-inspect-1',
        findings: 2,
      }).derivative,
    ).toMatchObject({
      kind: 'render.inspect',
      reportRef: 'report-render-inspect-1',
      findings: 2,
      resultRef: 'derivative:render-inspect-1',
    });
    expect(() =>
      api.enqueue(owner, 'bad-render', 'p', 'render.inspect', 105, undefined, {
        protocolVersion: 1,
        jobId: 'bad-render',
        type: 'render.inspect',
        payload: {
          projectRef: 'C:\\private\\project.json',
          compositionId: 'composition-main',
          presetId: 'inspect',
          reportRef: 'report-bad',
        },
        requirements: { capabilities: ['render.inspect'], privacy: 'local-only' },
        idempotencyKey: 'idem-bad-render',
        maxAttempts: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'WORKER_JOB_INVALID' }));
  });

  it('records opaque asset and local-derivative metadata without accepting paths or cloud claims', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    api.createProject(owner, 'project-1', 'Project');
    expect(api.setAssetSync(owner, 'project-1', true)).toMatchObject({ assetSyncEnabled: true });
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
    expect(api.deleteAsset(owner, 'project-1', 'asset-1')).toEqual({ id: 'asset-1' });
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

  it('lists private-object assets in the shared cloud library for any authenticated Joy user', () => {
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
    expect(api.sharedCloudAssets(peer)).toMatchObject([
      { id: 'img-1', kind: 'image', displayName: 'shot.png' },
    ]);
    expect(api.sharedCloudAsset(peer, 'img-1').id).toBe('img-1');
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
