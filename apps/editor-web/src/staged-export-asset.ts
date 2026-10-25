/**
 * A finished export is copied to the cloud as a private asset so the Worker can verify it. That copy
 * is internal: it is created for one export attempt and deleted after verification, so it is never
 * library media. Every producer and filter uses this one prefix.
 */
export const STAGED_EXPORT_ASSET_PREFIX = 'export-source-';

export function isStagedExportAssetId(assetId: string): boolean {
  return assetId.startsWith(STAGED_EXPORT_ASSET_PREFIX);
}
