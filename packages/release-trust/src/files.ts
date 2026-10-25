import type { ReleaseManifest, ReleaseManifestFile } from './manifest.js';

export type FileCheck =
  | { readonly ok: true; readonly entry: ReleaseManifestFile }
  | { readonly ok: false; readonly reason: 'not-listed' | 'size-mismatch' | 'digest-mismatch' };

/**
 * Checks a file on disk against the signed manifest. The caller measures the file (size and SHA-256, streamed) and
 * passes the result. A name the manifest does not list is refused, so a stray file can never pass as part of a release.
 */
export function checkFileAgainstManifest(
  manifest: ReleaseManifest,
  name: string,
  actual: { readonly size: number; readonly sha256: string },
): FileCheck {
  const entry = manifest.files.find((file) => file.name === name);
  if (entry === undefined) return { ok: false, reason: 'not-listed' };
  if (actual.size !== entry.size) return { ok: false, reason: 'size-mismatch' };
  if (actual.sha256.toLowerCase() !== entry.sha256) return { ok: false, reason: 'digest-mismatch' };
  return { ok: true, entry };
}
