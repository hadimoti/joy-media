import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserAsset,
  BrowserAssetRegistration,
  BrowserProject,
} from './control-plane-client.js';
import {
  importAssetLocallyByDefault,
  readAuthoritativeAssetSync,
  type AssetImportClient,
} from './asset-import-privacy.js';

const registration: BrowserAssetRegistration = {
  id: 'image-local',
  kind: 'image',
  displayName: 'local.png',
  sha256: 'a'.repeat(64),
  bytes: 3,
  descriptor: { mimeType: 'image/png' },
  locations: [{ kind: 'opfs-cache', ref: 'opfs-local' }],
};

describe('local-first asset import privacy', () => {
  it('caches and registers a local-only image without uploading bytes', async () => {
    const harness = createHarness(false);

    await expect(runImport(harness)).resolves.toMatchObject({ backupState: 'disabled' });

    expect(harness.cache.put).toHaveBeenCalledOnce();
    expect(harness.client.registerAsset).toHaveBeenCalledOnce();
    expect(harness.client.project).toHaveBeenCalledWith('project-1');
    expect(harness.client.uploadAssetOriginal).not.toHaveBeenCalled();
  });

  it('uploads exactly once only after explicit sync opt-in', async () => {
    const harness = createHarness(false);

    await runImport(harness);
    expect(harness.client.uploadAssetOriginal).not.toHaveBeenCalled();

    await harness.enableSync();
    await expect(runImport(harness)).resolves.toMatchObject({ backupState: 'uploaded' });

    expect(harness.enableSync).toHaveBeenCalledOnce();
    expect(harness.client.uploadAssetOriginal).toHaveBeenCalledOnce();
    expect(harness.client.uploadAssetOriginal).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ id: 'image-local' }),
      expect.any(Blob),
      undefined,
    );
  });

  it('uses the refreshed project response instead of a stale enabled component state', async () => {
    const harness = createHarness(false);
    const observedSyncState = vi.fn<(enabled: boolean) => void>();

    await runImport(harness, observedSyncState);

    expect(observedSyncState).toHaveBeenCalledWith(false);
    expect(harness.client.uploadAssetOriginal).not.toHaveBeenCalled();
    await expect(readAuthoritativeAssetSync(harness.client, 'project-1')).resolves.toBe(false);
  });

  it('fails closed when authoritative sync state cannot be refreshed', async () => {
    const harness = createHarness(true);
    harness.client.project.mockRejectedValueOnce(new Error('offline'));
    const observedSyncState = vi.fn<(enabled: boolean) => void>();

    await expect(runImport(harness, observedSyncState)).resolves.toMatchObject({
      backupState: 'sync-state-unavailable',
      backupError: expect.objectContaining({ message: 'offline' }),
    });

    expect(harness.cache.put).toHaveBeenCalledOnce();
    expect(harness.client.registerAsset).toHaveBeenCalledOnce();
    expect(observedSyncState).toHaveBeenCalledWith(false);
    expect(harness.client.uploadAssetOriginal).not.toHaveBeenCalled();
  });

  it('retains a successful local import when optional cloud backup fails', async () => {
    const harness = createHarness(true);
    harness.client.uploadAssetOriginal.mockRejectedValueOnce(new Error('private store offline'));

    await expect(runImport(harness)).resolves.toMatchObject({
      backupState: 'upload-failed',
      backupError: expect.objectContaining({ message: 'private store offline' }),
    });

    expect(harness.cache.put).toHaveBeenCalledOnce();
    expect(harness.client.registerAsset).toHaveBeenCalledOnce();
    expect(harness.client.uploadAssetOriginal).toHaveBeenCalledOnce();
  });
});

function createHarness(initialSyncEnabled: boolean) {
  let syncEnabled = initialSyncEnabled;
  const asset: BrowserAsset = {
    ...registration,
    projectId: 'project-1',
    createdAt: 1,
  };
  const project = (): BrowserProject => ({
    id: 'project-1',
    title: 'Project',
    revision: 0,
    ownerId: 'owner',
    assetSyncEnabled: syncEnabled,
  });
  const client = {
    project: vi.fn(async () => project()),
    registerAsset: vi.fn(async () => asset),
    retagAsset: vi.fn(async () => asset),
    uploadAssetOriginal: vi.fn(async () => asset),
  } satisfies AssetImportClient;
  const cache = { put: vi.fn(async () => undefined) };
  const enableSync = vi.fn(async () => {
    syncEnabled = true;
  });
  return {
    cache,
    client,
    enableSync,
  };
}

function runImport(
  harness: ReturnType<typeof createHarness>,
  onAuthoritativeSyncState?: (enabled: boolean) => void,
) {
  return importAssetLocallyByDefault({
    client: harness.client,
    cache: harness.cache,
    projectId: 'project-1',
    registration,
    file: new Blob(['png'], { type: 'image/png' }),
    ...(onAuthoritativeSyncState === undefined ? {} : { onAuthoritativeSyncState }),
  });
}
