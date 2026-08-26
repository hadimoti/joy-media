import type {
  BrowserAsset,
  BrowserAssetRegistration,
  BrowserProject,
} from './control-plane-client.js';
import type { OpfsOriginalAssetCache } from './opfs-original-asset-cache.js';

export type AssetImportStage = 'cache-local' | 'register' | 'check-sync' | 'upload-private-backup';

export type AssetImportBackupState =
  'uploaded' | 'disabled' | 'unsupported-kind' | 'sync-state-unavailable' | 'upload-failed';

export interface LocalFirstAssetImportResult {
  readonly asset: BrowserAsset;
  readonly backupState: AssetImportBackupState;
  readonly backupError?: unknown;
}

export interface AssetImportClient {
  project(projectId: string): Promise<BrowserProject>;
  registerAsset(projectId: string, asset: BrowserAssetRegistration): Promise<BrowserAsset>;
  retagAsset(projectId: string, assetId: string): Promise<BrowserAsset>;
  uploadAssetOriginal(
    projectId: string,
    asset: Pick<BrowserAsset, 'id' | 'sha256' | 'bytes' | 'descriptor'>,
    file: Blob,
    onProgress?: (ratio: number) => void,
  ): Promise<BrowserAsset>;
}

export async function readAuthoritativeAssetSync(
  client: Pick<AssetImportClient, 'project'>,
  projectId: string,
): Promise<boolean> {
  const project = await client.project(projectId);
  if (project.id !== projectId) throw new Error('project sync response did not match the request');
  return project.assetSyncEnabled;
}

/**
 * Persists every selected original locally before catalog registration. Image
 * bytes leave the browser only after a fresh, authoritative project read says
 * private backup is enabled. Failures after registration never erase the local
 * original or misreport the import itself as failed.
 */
export async function importAssetLocallyByDefault({
  client,
  cache,
  projectId,
  registration,
  file,
  onStage,
  onUploadProgress,
  onAuthoritativeSyncState,
}: {
  readonly client: AssetImportClient;
  readonly cache: Pick<OpfsOriginalAssetCache, 'put'>;
  readonly projectId: string;
  readonly registration: BrowserAssetRegistration;
  readonly file: Blob;
  readonly onStage?: (stage: AssetImportStage) => void;
  readonly onUploadProgress?: (ratio: number) => void;
  readonly onAuthoritativeSyncState?: (enabled: boolean) => void;
}): Promise<LocalFirstAssetImportResult> {
  onStage?.('cache-local');
  await cache.put(
    {
      assetId: registration.id,
      sha256: registration.sha256,
      bytes: registration.bytes,
      mimeType: registration.descriptor.mimeType,
    },
    file,
  );

  onStage?.('register');
  const asset = await client.registerAsset(projectId, registration);
  if (asset.kind !== 'image') {
    await bestEffortRetag(client, projectId, asset.id);
    return { asset, backupState: 'unsupported-kind' };
  }

  onStage?.('check-sync');
  let syncEnabled: boolean;
  try {
    syncEnabled = await readAuthoritativeAssetSync(client, projectId);
    onAuthoritativeSyncState?.(syncEnabled);
  } catch (error) {
    onAuthoritativeSyncState?.(false);
    await bestEffortRetag(client, projectId, asset.id);
    return { asset, backupState: 'sync-state-unavailable', backupError: error };
  }

  if (!syncEnabled) {
    await bestEffortRetag(client, projectId, asset.id);
    return { asset, backupState: 'disabled' };
  }

  onStage?.('upload-private-backup');
  try {
    await client.uploadAssetOriginal(projectId, asset, file, onUploadProgress);
    return { asset, backupState: 'uploaded' };
  } catch (error) {
    await bestEffortRetag(client, projectId, asset.id);
    return { asset, backupState: 'upload-failed', backupError: error };
  }
}

async function bestEffortRetag(
  client: Pick<AssetImportClient, 'retagAsset'>,
  projectId: string,
  assetId: string,
): Promise<void> {
  try {
    await client.retagAsset(projectId, assetId);
  } catch {
    // Local persistence and catalog registration are the import contract.
  }
}
