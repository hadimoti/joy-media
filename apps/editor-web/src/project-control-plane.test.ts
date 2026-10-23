import { describe, expect, it } from 'vitest';
import {
  BrowserControlPlaneClient,
  RESUMABLE_ORIGINAL_UPLOAD_THRESHOLD_BYTES,
  UNBOUND_PROJECT_MESSAGE,
  type BrowserAsset,
  type BrowserAssetRegistration,
} from './control-plane-client.js';
import {
  getOrCreateControlPlaneProjectBinding,
  getControlPlaneProjectBinding,
  upsertControlPlaneProjectBinding,
  removeControlPlaneProjectBinding,
  controlPlaneOwnerKeyFor,
  controlPlaneProjectIsReady,
  unboundControlPlaneProject,
} from './project-control-plane.js';
import type { JoySessionState } from './identity.js';

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

  it('names an owner only from a ready session with a subject', () => {
    const ready = (subject: string | undefined): JoySessionState => ({
      kind: 'ready',
      subject,
      displayName: subject,
      method: undefined,
      avatarAvailable: false,
      avatarObjectUrl: undefined,
    });

    expect(controlPlaneOwnerKeyFor({ kind: 'unknown' })).toBeUndefined();
    expect(controlPlaneOwnerKeyFor({ kind: 'signed-out' })).toBeUndefined();
    expect(controlPlaneOwnerKeyFor({ kind: 'unavailable' })).toBeUndefined();
    expect(
      controlPlaneOwnerKeyFor({ kind: 'no-access', message: 'Access denied' }),
    ).toBeUndefined();
    expect(controlPlaneOwnerKeyFor(ready('user@example.com'))).toBe('user@example.com');
    expect(controlPlaneOwnerKeyFor(ready(undefined))).toBeUndefined();
    expect(controlPlaneOwnerKeyFor(ready('   '))).toBeUndefined();
  });

  it('leaves a legacy signed-in bucket untouched when a subject binds the same project', () => {
    const storage = memoryStorage();
    const legacy = {
      editorProjectId: 'local-edit-1',
      controlPlaneProjectId: 'project-transitional',
      title: 'Campaign cut',
    };
    storage.setItem(
      'joy-media.control-plane-project-bindings.v1',
      JSON.stringify({ version: 2, bindingsByOwner: { 'signed-in': { 'local-edit-1': legacy } } }),
    );

    const bound = getOrCreateControlPlaneProjectBinding(
      storage,
      { id: 'local-edit-1', title: 'Campaign cut' },
      { createId: () => 'subject-project', ownerKey: 'user@example.com' },
    );

    expect(bound.controlPlaneProjectId).toBe('project-subject-project');
    expect(getControlPlaneProjectBinding(storage, 'local-edit-1', 'signed-in')).toEqual(legacy);
  });

  it('reuses the subject binding after sign-out and sign-in', () => {
    const storage = memoryStorage();
    const project = { id: 'local-edit-1', title: 'Campaign cut' };
    const first = getOrCreateControlPlaneProjectBinding(storage, project, {
      createId: () => 'subject-project',
      ownerKey: 'user@example.com',
    });

    // Signed out: the project is unbound, and the stored subject binding is left alone.
    expect(unboundControlPlaneProject(project).controlPlaneProjectId).toBe('unbound-local-edit-1');
    expect(getControlPlaneProjectBinding(storage, 'local-edit-1', 'user@example.com')).toEqual(
      first,
    );

    // Signed in again with the same subject: the stored binding is reused, not replaced.
    const again = getOrCreateControlPlaneProjectBinding(storage, project, {
      createId: () => 'must-not-be-used',
      ownerKey: 'user@example.com',
    });
    expect(again).toEqual(first);
  });

  it('counts a project ready only for the owner and project whose ensure completed', () => {
    const ready = { ownerKey: 'owner-a', projectId: 'project-1' };

    expect(controlPlaneProjectIsReady(ready, 'owner-a', 'project-1')).toBe(true);
    expect(controlPlaneProjectIsReady(ready, 'owner-b', 'project-1')).toBe(false);
    expect(controlPlaneProjectIsReady(ready, 'owner-a', 'project-2')).toBe(false);
    expect(controlPlaneProjectIsReady(ready, undefined, 'project-1')).toBe(false);
    expect(controlPlaneProjectIsReady(undefined, 'owner-a', 'project-1')).toBe(false);
  });

  it('describes an unbound editor project without storing a binding', () => {
    const storage = memoryStorage();

    expect(unboundControlPlaneProject({ id: 'local-edit-1', title: 'Campaign cut' })).toEqual({
      editorProjectId: 'local-edit-1',
      controlPlaneProjectId: 'unbound-local-edit-1',
      title: 'Campaign cut',
    });
    expect(storage.getItem('joy-media.control-plane-project-bindings.v1')).toBeNull();
  });

  it('refuses every project-scoped request for an unbound project before any network call', async () => {
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return json(200, { data: {} });
    };
    const unbound = 'unbound-local-edit-1';
    const file = new Blob(['video']);
    const asset = {
      id: 'asset-1',
      sha256: 'digest-1',
      bytes: file.size,
      descriptor: {},
    } as Pick<BrowserAsset, 'id' | 'sha256' | 'bytes' | 'descriptor'>;
    const registration = {} as BrowserAssetRegistration;
    const documentParams = {} as Parameters<BrowserControlPlaneClient['syncProjectDocument']>[1];
    const gpuFrame = { projectId: unbound } as Parameters<
      BrowserControlPlaneClient['submitGpuPreviewFrame']
    >[0];
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      const attempts = [
        () => client.ensureProject(unbound, 'Campaign cut'),
        () => client.createProject(unbound, 'Campaign cut'),
        () => client.project(unbound),
        () => client.renameProject(unbound, 'Campaign cut', 1),
        () => client.duplicateProject(unbound, 'project-copy-1', 'Campaign copy', 1),
        () => client.duplicateProject('project-source-1', unbound, 'Campaign copy', 1),
        () => client.trashProject(unbound, 1),
        () => client.restoreProject(unbound, 1),
        () => client.deleteProject(unbound),
        () => client.openGpuPreviewSession(unbound),
        () => client.submitGpuPreviewFrame(gpuFrame),
        () => client.startStockVideoImport(unbound, 'stock-video-1'),
        () => client.stockVideoImportStatus(unbound, 'import-1'),
        () => client.jobs(unbound),
        () => client.assets(unbound),
        () => client.myAssets(unbound),
        () => client.projectDocument(unbound),
        () => client.syncProjectDocument(unbound, documentParams),
        () => client.setAssetSync(unbound, true),
        () => client.registerAsset(unbound, registration),
        () => client.uploadAssetOriginal(unbound, asset, file),
        () => client.remuxBrowserMp4(unbound, file),
        () => client.derivatives(unbound, 'asset-1'),
        () => client.originalBytes(unbound, 'asset-1'),
        () => client.derivativeBytes(unbound, 'asset-1', 'derivative-1'),
        () => client.associateAsset(unbound, 'asset-1'),
        () => client.retagAsset(unbound, 'asset-1'),
        () => client.deleteAsset(unbound, 'asset-1'),
        () => client.enqueueAssetThumbnail(unbound, 'job-1', 'asset-1'),
        () => client.enqueueWorkerGeneration(unbound, 'job-1', 'image.comfy', 'asset-1'),
        () => client.enqueueRenderExport(unbound, 'job-1', 'asset-1', {}),
        () => client.enqueueAiGeneration(unbound, 'job-1', 'text.openrouter', 'Add a title card'),
        () => client.enqueueMask(unbound, 'job-1', 'mask.image', 'asset-1', {}),
        () => client.enqueueUpscale(unbound, 'job-1', 'upscale.image', 'asset-1', {}),
        () => client.enqueueComfyRemoveBg(unbound, 'job-1', 'asset-1'),
        () => client.cancel(unbound, 'job-1'),
        () => client.retry(unbound, 'job-1'),
        () => client.denoiseAudioOperation(unbound, 'operation-1'),
        () =>
          client.denoiseAudio({
            projectId: unbound,
            operationId: 'operation-1',
            assetId: 'asset-1',
            media: file,
          }),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toThrow(UNBOUND_PROJECT_MESSAGE);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requests).toEqual([]);
  });

  it('keeps the bound project path for ensure and reads', async () => {
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return json(200, { data: [] });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await client.ensureProject('project-opaque-project-1', 'Campaign cut');
      await client.jobs('project-opaque-project-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requests).toEqual([
      'https://media.joyteam.ir/api/v1/projects/ensure',
      'https://media.joyteam.ir/api/v1/projects/project-opaque-project-1/jobs',
    ]);
  });

  it('keeps the bound project path for project record changes', async () => {
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? ` ${init.body}` : '';
      requests.push(`${init?.method ?? 'GET'} ${String(input)}${body}`);
      return json(200, { data: {} });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await client.createProject('project-opaque-project-1', 'Campaign cut');
      await client.project('project-opaque-project-1');
      await client.renameProject('project-opaque-project-1', 'Launch cut', 4);
      await client.duplicateProject(
        'project-opaque-project-1',
        'project-copy-1',
        'Campaign copy',
        4,
      );
      await client.trashProject('project-opaque-project-1', 5);
      await client.restoreProject('project-opaque-project-1', 6);
      await client.deleteProject('project-opaque-project-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requests).toEqual([
      'POST https://media.joyteam.ir/api/v1/projects {"id":"project-opaque-project-1","title":"Campaign cut"}',
      'GET https://media.joyteam.ir/api/v1/projects/project-opaque-project-1',
      'PATCH https://media.joyteam.ir/api/v1/projects/project-opaque-project-1 {"title":"Launch cut","baseRevision":4}',
      'POST https://media.joyteam.ir/api/v1/projects/project-opaque-project-1/duplicate {"id":"project-copy-1","title":"Campaign copy","baseRevision":4}',
      'POST https://media.joyteam.ir/api/v1/projects/project-opaque-project-1/trash {"baseRevision":5}',
      'POST https://media.joyteam.ir/api/v1/projects/project-opaque-project-1/restore {"baseRevision":6}',
      'DELETE https://media.joyteam.ir/api/v1/projects/project-opaque-project-1',
    ]);
  });

  it('reports no upload progress and sends no bytes for an unbound project', async () => {
    const requests: string[] = [];
    const progress: number[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return json(200, { data: {} });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      // One size per upload path: a single request, and the resumable parts path.
      for (const size of [5, RESUMABLE_ORIGINAL_UPLOAD_THRESHOLD_BYTES + 1]) {
        const file = new Blob([new Uint8Array(size)]);
        const asset = {
          id: 'asset-1',
          sha256: 'digest-1',
          bytes: size,
          descriptor: {},
        } as Pick<BrowserAsset, 'id' | 'sha256' | 'bytes' | 'descriptor'>;
        await expect(
          client.uploadAssetOriginal('unbound-local-edit-1', asset, file, (ratio) =>
            progress.push(ratio),
          ),
        ).rejects.toThrow(UNBOUND_PROJECT_MESSAGE);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(progress).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('keeps reporting upload progress for a bound project', async () => {
    const progress: number[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => json(200, { data: { asset: { id: 'asset-1' } } });
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      const file = new Blob(['video']);
      const asset = {
        id: 'asset-1',
        sha256: 'digest-1',
        bytes: file.size,
        descriptor: {},
      } as Pick<BrowserAsset, 'id' | 'sha256' | 'bytes' | 'descriptor'>;
      await client.uploadAssetOriginal('project-opaque-project-1', asset, file, (ratio) =>
        progress.push(ratio),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(progress).toEqual([0.05, 0.9, 1]);
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
      return json(200, {
        data: [
          {
            id: 'job-1',
            projectId: 'project-opaque-project-1',
            type: 'export.video',
            state: 'queued',
            progress: 0,
            cancelRequested: false,
          },
        ],
      });
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
