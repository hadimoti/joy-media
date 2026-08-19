import { describe, expect, it } from 'vitest';
import { BrowserControlPlaneClient } from './control-plane-client.js';
import {
  getOrCreateControlPlaneProjectBinding,
  getControlPlaneProjectBinding,
  upsertControlPlaneProjectBinding,
  removeControlPlaneProjectBinding,
} from './project-control-plane.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('control-plane project binding', () => {
  it('persists one opaque control-plane identity for a reopened editor project', () => {
    const storage = memoryStorage();
    const createId = () => 'opaque-project-1';
    const first = getOrCreateControlPlaneProjectBinding(
      storage,
      { id: 'local-edit-1', title: 'Campaign cut' },
      createId,
    );
    const reopened = getOrCreateControlPlaneProjectBinding(
      storage,
      { id: 'local-edit-1', title: 'Campaign cut' },
      () => 'must-not-be-used',
    );

    expect(first).toEqual({
      editorProjectId: 'local-edit-1',
      controlPlaneProjectId: 'project-opaque-project-1',
      title: 'Campaign cut',
    });
    expect(reopened).toEqual(first);
  });

  it('keeps distinct editor projects in distinct owner-scoped records', () => {
    const storage = memoryStorage();
    const first = getOrCreateControlPlaneProjectBinding(
      storage,
      { id: 'local-edit-1', title: 'Campaign cut' },
      () => 'opaque-project-1',
    );
    const second = getOrCreateControlPlaneProjectBinding(
      storage,
      { id: 'local-edit-2', title: 'Launch reel' },
      () => 'opaque-project-2',
    );

    expect(second.controlPlaneProjectId).not.toBe(first.controlPlaneProjectId);
    expect(second.editorProjectId).toBe('local-edit-2');
  });

  it('isolates bindings per signed-in owner key', () => {
    const storage = memoryStorage();
    const gmail = getOrCreateControlPlaneProjectBinding(
      storage,
      { id: 'local-edit-1', title: 'Campaign cut' },
      { createId: () => 'gmail-project', ownerKey: 'hadimoti96@gmail.com' },
    );
    const telegram = getOrCreateControlPlaneProjectBinding(
      storage,
      { id: 'local-edit-1', title: 'Campaign cut' },
      { createId: () => 'telegram-project', ownerKey: '68238523' },
    );

    expect(gmail.controlPlaneProjectId).toBe('project-gmail-project');
    expect(telegram.controlPlaneProjectId).toBe('project-telegram-project');
  });

  it('migrates legacy v1 bindings under the legacy owner bucket', () => {
    const storage = memoryStorage();
    storage.setItem(
      'joy-media.control-plane-project-bindings.v1',
      JSON.stringify({
        version: 1,
        bindings: {
          'local-edit-1': {
            editorProjectId: 'local-edit-1',
            controlPlaneProjectId: 'project-legacy-1',
            title: 'Campaign cut',
          },
        },
      }),
    );

    const rebound = getOrCreateControlPlaneProjectBinding(
      storage,
      { id: 'local-edit-1', title: 'Campaign cut' },
      { createId: () => 'must-not-be-used', ownerKey: 'legacy' },
    );
    expect(rebound.controlPlaneProjectId).toBe('project-legacy-1');
  });

  it('does not reuse malformed browser state as a project binding', () => {
    const storage = memoryStorage();
    storage.setItem('joy-media.control-plane-project-bindings.v1', '{not-json');

    expect(
      getOrCreateControlPlaneProjectBinding(
        storage,
        { id: 'local-edit-1', title: 'Campaign cut' },
        () => 'recovered-project',
      ),
    ).toMatchObject({ controlPlaneProjectId: 'project-recovered-project' });
  });

  it('reopens the same owner-scoped job history through the persisted binding', async () => {
    const storage = memoryStorage();
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      return json(200, { data: [{ id: 'job-1', state: 'queued' }] });
    };
    const first = getOrCreateControlPlaneProjectBinding(
      storage,
      { id: 'local-edit-1', title: 'Campaign cut' },
      () => 'opaque-project-1',
    );
    const reopened = getOrCreateControlPlaneProjectBinding(
      storage,
      { id: 'local-edit-1', title: 'Campaign cut' },
      () => 'must-not-be-used',
    );
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await expect(client.jobs(reopened.controlPlaneProjectId)).resolves.toMatchObject([
        { id: 'job-1', state: 'queued' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(reopened.controlPlaneProjectId).toBe(first.controlPlaneProjectId);
    expect(requests).toContain(
      `https://media.joyteam.ir/api/v1/projects/${first.controlPlaneProjectId}/jobs`,
    );
  });

  it('round-trips the documentRevisionId through binding persistence', () => {
    const storage = memoryStorage();
    const binding = {
      editorProjectId: 'local-edit-1',
      controlPlaneProjectId: 'project-server-1',
      title: 'Campaign cut',
      documentRevisionId: 'cas-rev-abc123',
    };
    upsertControlPlaneProjectBinding(storage, binding, 'user-1');

    const restored = getControlPlaneProjectBinding(storage, 'local-edit-1', 'user-1');
    expect(restored).toEqual(binding);
  });

  it('isolates documentRevisionId per owner-scoped binding', () => {
    const storage = memoryStorage();
    const bindingA = {
      editorProjectId: 'local-edit-1',
      controlPlaneProjectId: 'project-server-1',
      title: 'Campaign cut',
      documentRevisionId: 'cas-rev-gmail',
    };
    const bindingB = {
      editorProjectId: 'local-edit-1',
      controlPlaneProjectId: 'project-server-2',
      title: 'Campaign cut',
      documentRevisionId: 'cas-rev-telegram',
    };
    upsertControlPlaneProjectBinding(storage, bindingA, 'gmail-user');
    upsertControlPlaneProjectBinding(storage, bindingB, 'telegram-user');

    const restoredA = getControlPlaneProjectBinding(storage, 'local-edit-1', 'gmail-user');
    const restoredB = getControlPlaneProjectBinding(storage, 'local-edit-1', 'telegram-user');

    expect(restoredA?.documentRevisionId).toBe('cas-rev-gmail');
    expect(restoredB?.documentRevisionId).toBe('cas-rev-telegram');
  });

  it('reads legacy V2 bindings without documentRevisionId', () => {
    const storage = memoryStorage();
    storage.setItem(
      'joy-media.control-plane-project-bindings.v1',
      JSON.stringify({
        version: 2,
        bindingsByOwner: {
          'owner-1': {
            'local-edit-1': {
              editorProjectId: 'local-edit-1',
              controlPlaneProjectId: 'project-legacy-v2',
              title: 'Legacy project',
              revision: 42,
            },
          },
        },
      }),
    );

    const binding = getControlPlaneProjectBinding(storage, 'local-edit-1', 'owner-1');
    expect(binding).toEqual({
      editorProjectId: 'local-edit-1',
      controlPlaneProjectId: 'project-legacy-v2',
      title: 'Legacy project',
      revision: 42,
    });
  });

  it('reads legacy V1 bindings without documentRevisionId', () => {
    const storage = memoryStorage();
    storage.setItem(
      'joy-media.control-plane-project-bindings.v1',
      JSON.stringify({
        version: 1,
        bindings: {
          'local-edit-1': {
            editorProjectId: 'local-edit-1',
            controlPlaneProjectId: 'project-legacy-v1',
            title: 'Legacy V1 project',
          },
        },
      }),
    );

    const binding = getControlPlaneProjectBinding(storage, 'local-edit-1', 'legacy');
    expect(binding).toEqual({
      editorProjectId: 'local-edit-1',
      controlPlaneProjectId: 'project-legacy-v1',
      title: 'Legacy V1 project',
    });
  });

  it('updates documentRevisionId on existing binding via upsert', () => {
    const storage = memoryStorage();
    const initialBinding = {
      editorProjectId: 'local-edit-1',
      controlPlaneProjectId: 'project-server-1',
      title: 'Campaign cut',
    };
    upsertControlPlaneProjectBinding(storage, initialBinding, 'user-1');

    const updatedBinding = {
      ...initialBinding,
      documentRevisionId: 'cas-rev-updated',
    };
    upsertControlPlaneProjectBinding(storage, updatedBinding, 'user-1');

    const restored = getControlPlaneProjectBinding(storage, 'local-edit-1', 'user-1');
    expect(restored?.documentRevisionId).toBe('cas-rev-updated');
  });
});
