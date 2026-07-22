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
    api.enqueue(owner, 'j', 'p', 'render', 100);
    expect(api.lease('w', 101, 10)).toMatchObject({ id: 'j', state: 'leased' });
    api.complete('w', 'j', 102);
    expect(api.lease('w', 1_000)).toBeUndefined();
    expect(api.eventsAfter(owner, 'p', 1).map((event) => event.type)).toEqual([
      'leased',
      'completed',
    ]);
    api.revokeWorker(owner, 'w');
    expect(() => api.lease('w')).toThrow(expect.objectContaining({ code: 'WORKER_UNAUTHORIZED' }));
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
