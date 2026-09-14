import { verifyManifest } from './manifest.js';
import type { ArchiveEntry, ArchiveManifest } from './manifest.js';
import { decryptArchive } from './encryption.js';
import type { EncryptedPayload } from './encryption.js';
import type { ArchiveBundle } from './archive-export.js';

/**
 * The "clear import boundary" the locked owner decision requires: decrypts an exported
 * archive, verifies every checksum before trusting a single byte, and hands back a plain,
 * already-verified bundle. This module never writes anywhere itself — a caller (the desktop
 * app's local project store, in a future wave) decides what to do with the verified entries.
 * Nothing here silently imports or merges data on its own.
 */

export class ArchiveImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveImportError';
  }
}

export interface ImportedArchive {
  readonly manifest: ArchiveManifest;
  readonly entries: readonly ArchiveEntry[];
}

export function importOwnerArchive(
  encrypted: EncryptedPayload,
  keyBase64: string,
): ImportedArchive {
  // Buffer.from(str, 'base64') never throws for a malformed string (it decodes leniently) —
  // an invalid key surfaces as a normal ArchiveEncryptionError('DECRYPTION_FAILED') from
  // decryptArchive below, via the wrong key length or a failed GCM auth-tag check.
  const key = Buffer.from(keyBase64, 'base64');
  const plaintext = decryptArchive(encrypted, key); // throws ArchiveEncryptionError on its own

  let bundle: ArchiveBundle;
  try {
    bundle = JSON.parse(plaintext.toString('utf8')) as ArchiveBundle;
  } catch {
    throw new ArchiveImportError('ARCHIVE_PAYLOAD_INVALID', 'decrypted archive is not valid JSON');
  }
  if (!isRecord(bundle) || !Array.isArray(bundle.entries) || !isRecord(bundle.manifest)) {
    throw new ArchiveImportError(
      'ARCHIVE_PAYLOAD_INVALID',
      'decrypted archive does not have the expected {manifest, entries} shape',
    );
  }

  if (!isArchiveManifestShape(bundle.manifest)) {
    throw new ArchiveImportError(
      'ARCHIVE_PAYLOAD_INVALID',
      'decrypted archive manifest has an invalid shape',
    );
  }

  const entries: ArchiveEntry[] = [];
  for (const entry of bundle.entries) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.bytesBase64 !== 'string') {
      throw new ArchiveImportError(
        'ARCHIVE_PAYLOAD_INVALID',
        'decrypted archive contains an invalid entry shape',
      );
    }
    entries.push({ name: entry.name, bytes: Buffer.from(entry.bytesBase64, 'base64') });
  }

  const verification = verifyManifest(entries, bundle.manifest as ArchiveManifest);
  if (!verification.ok) {
    throw new ArchiveImportError(
      'ARCHIVE_CHECKSUM_MISMATCH',
      `archive failed integrity verification: ${verification.reason}`,
    );
  }

  return { manifest: bundle.manifest, entries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isArchiveManifestShape(value: Record<string, unknown>): boolean {
  return (
    value.formatVersion === 1 &&
    typeof value.createdAt === 'string' &&
    Number.isInteger(value.entryCount) &&
    Number.isInteger(value.totalByteLength) &&
    typeof value.manifestChecksum === 'string' &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.name === 'string' &&
        typeof entry.sha256 === 'string' &&
        Number.isInteger(entry.byteLength),
    )
  );
}
