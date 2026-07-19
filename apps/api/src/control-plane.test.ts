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
});
