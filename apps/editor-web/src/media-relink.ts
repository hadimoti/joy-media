import type { AssetRecordV1 } from '@joy-media/project-schema';
import type { OriginalAssetDescriptor } from './opfs-original-asset-cache.js';

/** The cache surface relink needs: a read to detect missing media, and a verified write. */
export interface RelinkCache {
  get(assetId: string): Promise<Blob | undefined>;
  put(descriptor: OriginalAssetDescriptor, file: Blob): Promise<void>;
}

export type ReplacementVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'missing-integrity' | 'size-mismatch' | 'hash-mismatch';
    };

/**
 * A replacement file is accepted only when it matches the hash and byte length
 * recorded for the original. A record without that metadata cannot be verified,
 * so it is refused rather than trusted.
 */
export async function verifyReplacementMedia(
  record: AssetRecordV1,
  file: Blob,
): Promise<ReplacementVerdict> {
  if (record.sha256 === undefined || record.bytes === undefined)
    return { ok: false, reason: 'missing-integrity' };
  if (file.size !== record.bytes) return { ok: false, reason: 'size-mismatch' };
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== record.sha256) return { ok: false, reason: 'hash-mismatch' };
  return { ok: true };
}

/** True when this browser profile holds no original for the asset. */
export async function isMediaMissing(cache: RelinkCache, assetId: string): Promise<boolean> {
  return (await cache.get(assetId)) === undefined;
}

export const RELINK_REFUSAL_MESSAGES: Readonly<
  Record<Exclude<ReplacementVerdict, { ok: true }>['reason'], string>
> = {
  'missing-integrity':
    'This media has no recorded checksum, so the replacement cannot be verified.',
  'size-mismatch':
    'The chosen file has a different size from the original. Choose the original file.',
  'hash-mismatch':
    'The chosen file does not match the original checksum. Choose the original file.',
};

/**
 * Verifies a replacement against the record and, only then, writes it through the
 * cache. The cache re-checks the hash and size on write.
 */
export async function relinkMissingMedia(
  cache: RelinkCache,
  record: AssetRecordV1,
  file: Blob,
): Promise<ReplacementVerdict> {
  const verdict = await verifyReplacementMedia(record, file);
  if (!verdict.ok) return verdict;
  await cache.put(
    {
      assetId: record.id,
      sha256: record.sha256!,
      bytes: record.bytes!,
      mimeType: record.descriptor?.mimeType ?? file.type,
    },
    file,
  );
  return verdict;
}
