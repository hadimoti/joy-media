import type { BrowserAsset } from './control-plane-client.js';

/**
 * Guards the legacy-original recovery action before any bytes leave the browser.
 * Recovery deliberately reuses the registered asset and upload endpoint; it never
 * imports a replacement or creates a new asset.
 */
export async function verifyOriginalRecoveryCandidate(
  asset: Pick<BrowserAsset, 'kind' | 'sha256' | 'bytes'>,
  file: File,
): Promise<void> {
  if (asset.kind !== 'video') throw new Error('Only a registered video can be recovered here.');
  if (!/^video\/[a-z0-9.+-]+$/i.test(file.type))
    throw new Error('Choose the original video file; this file is not a video.');
  if (file.size !== asset.bytes)
    throw new Error('This file has a different byte length and was not uploaded.');
  const sha256 = hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
  );
  if (sha256 !== asset.sha256)
    throw new Error('This file has a different SHA-256 and was not uploaded.');
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
