import type { AssetRecordV1 } from '@joy-media/project-schema';
import { sha256OfBlob } from './blob-sha256.js';
import { assetMediaMimeType } from './asset-mime-type.js';
import type { OriginalAssetDescriptor } from './opfs-original-asset-cache.js';

/** The cache surface relink needs: a read to detect missing media, and a verified write. */
export interface RelinkCache {
  get(assetId: string): Promise<Blob | undefined>;
  put(descriptor: OriginalAssetDescriptor, file: Blob): Promise<void>;
  /**
   * False when the cache cannot be read at all (no OPFS), so an absent file is not the same as a
   * file that is missing. A cache without this method is taken to be readable.
   */
  isAvailable?(): boolean;
  /** Removes one cached original. A cache without this method keeps what it was given. */
  remove?(assetId: string): Promise<void>;
}

/** True unless the cache says it cannot be read. */
export function isCacheReadable(cache: RelinkCache): boolean {
  return cache.isAvailable?.() ?? true;
}

/** The checksum and byte length a record can be verified against, with the checksum in lowercase hex. */
export interface RecordedIntegrity {
  readonly sha256: string;
  readonly bytes: number;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * What a record says its original is, or undefined when it cannot be verified: no checksum or length,
 * or a checksum that is not a SHA-256. Hex digits are compared in lowercase, which is how every digest
 * here is written and how the cache stores them, so a record written in uppercase still matches.
 */
export function recordedIntegrity(record: AssetRecordV1): RecordedIntegrity | undefined {
  if (record.sha256 === undefined || record.bytes === undefined) return undefined;
  const sha256 = record.sha256.toLowerCase();
  return SHA256_HEX.test(sha256) ? { sha256, bytes: record.bytes } : undefined;
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
 * so it is refused rather than trusted. The file is hashed in slices, never as
 * one whole buffer.
 */
export async function verifyReplacementMedia(
  record: AssetRecordV1,
  file: Blob,
): Promise<ReplacementVerdict> {
  const recorded = recordedIntegrity(record);
  if (recorded === undefined) return { ok: false, reason: 'missing-integrity' };
  if (file.size !== recorded.bytes) return { ok: false, reason: 'size-mismatch' };
  if ((await sha256OfBlob(file)) !== recorded.sha256) return { ok: false, reason: 'hash-mismatch' };
  return { ok: true };
}

/**
 * True when this browser profile holds no original for the asset. A cache that cannot be read
 * does not know, so it never reports media as missing.
 */
export async function isMediaMissing(cache: RelinkCache, assetId: string): Promise<boolean> {
  if (!isCacheReadable(cache)) return false;
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
  const recorded = recordedIntegrity(record)!;
  await cache.put(
    {
      assetId: record.id,
      sha256: recorded.sha256,
      bytes: recorded.bytes,
      mimeType: assetMediaMimeType(record.kind, [record.descriptor?.mimeType, file.type]),
    },
    file,
  );
  return verdict;
}
