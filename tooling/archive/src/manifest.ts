import { createHash } from 'node:crypto';

/**
 * Checksummed archive manifest (JOY Media desktop migration, wave 6). Locked owner decision:
 * "Provide a reversible, encrypted, checksummed archive export."
 *
 * A manifest lists every entry's own SHA-256 plus a top-level `manifestChecksum` covering the
 * sorted list of (name, checksum, byte length) triples — so a caller can confirm the manifest
 * itself was not silently edited independently of re-hashing every entry, and can confirm any
 * single entry independently of decrypting the whole archive.
 */

export interface ArchiveEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface ManifestEntry {
  readonly name: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ArchiveManifest {
  readonly formatVersion: 1;
  readonly createdAt: string;
  readonly entryCount: number;
  readonly totalByteLength: number;
  readonly entries: readonly ManifestEntry[];
  readonly manifestChecksum: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildManifest(
  entries: readonly ArchiveEntry[],
  now: () => string = () => new Date().toISOString(),
): ArchiveManifest {
  const manifestEntries = [...entries]
    .map((entry): ManifestEntry => ({
      name: entry.name,
      sha256: sha256Hex(entry.bytes),
      byteLength: entry.bytes.byteLength,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const totalByteLength = manifestEntries.reduce((sum, entry) => sum + entry.byteLength, 0);
  return {
    formatVersion: 1,
    createdAt: now(),
    entryCount: manifestEntries.length,
    totalByteLength,
    entries: manifestEntries,
    manifestChecksum: manifestChecksumOf(manifestEntries),
  };
}

export type ManifestVerification =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Recomputes every checksum from the actual bytes and compares against the manifest — this is
 * the "no-data-loss verification" check run at import time, before anything is trusted.
 */
export function verifyManifest(
  entries: readonly ArchiveEntry[],
  manifest: ArchiveManifest,
): ManifestVerification {
  if (manifest.formatVersion !== 1) {
    return { ok: false, reason: `unsupported manifest formatVersion ${manifest.formatVersion}` };
  }
  const recomputed = buildManifest(entries, () => manifest.createdAt);
  if (recomputed.entryCount !== manifest.entryCount) {
    return {
      ok: false,
      reason: `entry count mismatch: manifest says ${manifest.entryCount}, archive has ${recomputed.entryCount}`,
    };
  }
  if (recomputed.totalByteLength !== manifest.totalByteLength) {
    return {
      ok: false,
      reason: `total byte length mismatch: manifest says ${manifest.totalByteLength}, archive has ${recomputed.totalByteLength}`,
    };
  }
  for (let index = 0; index < manifest.entries.length; index++) {
    const expected = manifest.entries[index]!;
    const actual = recomputed.entries[index]!;
    if (expected.name !== actual.name) {
      return {
        ok: false,
        reason: `entry ${index} name mismatch: expected "${expected.name}", got "${actual.name}"`,
      };
    }
    if (expected.sha256 !== actual.sha256) {
      return { ok: false, reason: `checksum mismatch for "${expected.name}"` };
    }
    if (expected.byteLength !== actual.byteLength) {
      return { ok: false, reason: `byte length mismatch for "${expected.name}"` };
    }
  }
  if (recomputed.manifestChecksum !== manifest.manifestChecksum) {
    return { ok: false, reason: 'manifest checksum mismatch' };
  }
  return { ok: true };
}

function manifestChecksumOf(entries: readonly ManifestEntry[]): string {
  const canonical = entries
    .map((entry) => `${entry.name}:${entry.sha256}:${entry.byteLength}`)
    .join('\n');
  return sha256Hex(Buffer.from(canonical, 'utf8'));
}
