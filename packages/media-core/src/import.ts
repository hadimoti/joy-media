import type { AssetKind, AssetRecord, LocalAssetBridge, LocalFileSelection } from './assets.js';
export interface ImportRequest {
  readonly absolutePath: string;
  readonly displayName: string;
  readonly kind: AssetKind;
  readonly contentHash: string;
  readonly byteLength: number;
}
/** Browser/desktop picker adapter passes an approved selection; only the bridge retains the path. */
export function importLocalAsset(bridge: LocalAssetBridge, request: ImportRequest): AssetRecord {
  const selection: LocalFileSelection = request;
  const asset = bridge.registerSelectedFile(selection);
  bridge.generateDerivative(asset.id, 'thumbnail', 720);
  if (asset.kind === 'video') bridge.generateDerivative(asset.id, 'proxy', 540);
  return bridge.controlPlaneRecord(asset.id);
}
