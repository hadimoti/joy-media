import { buildManifest } from './manifest.js';
import type { ArchiveEntry, ArchiveManifest } from './manifest.js';
import { encryptArchive, generateArchiveKey } from './encryption.js';
import type { EncryptedPayload } from './encryption.js';

/**
 * Encrypted, checksummed export of one owner's hosted/browser data (JOY Media desktop
 * migration, wave 6). Locked owner decision: "Archive existing hosted/browser projects and
 * start a fresh desktop workspace ... do not silently migrate or delete customer data."
 *
 * `ProjectArchiveSource` is the seam a real caller plugs a live data source into — a Postgres-
 * backed implementation over `project-document-store.ts`/`private-object-store.ts` is future
 * work (see the wave 6 progress log); this module never opens a database connection itself,
 * so it is fully testable with a fake source and never touches production data on its own.
 */

export interface ArchiveProjectRecord {
  readonly id: string;
  readonly document: unknown;
}

export interface ArchiveMediaAsset {
  readonly id: string;
  readonly displayName: string;
  readonly bytes: Uint8Array;
}

export interface ProjectArchiveSource {
  listProjects(ownerId: string): Promise<readonly ArchiveProjectRecord[]>;
  listMediaAssets(projectId: string): Promise<readonly ArchiveMediaAsset[]>;
}

export interface ArchiveExportResult {
  readonly manifest: ArchiveManifest;
  readonly encrypted: EncryptedPayload;
  /** Base64. Returned to the caller exactly once — never persisted or logged by this module. */
  readonly keyBase64: string;
}

interface ArchiveBundleEntry {
  readonly name: string;
  readonly bytesBase64: string;
}

export interface ArchiveBundle {
  readonly manifest: ArchiveManifest;
  readonly entries: readonly ArchiveBundleEntry[];
}

export async function exportOwnerArchive(
  ownerId: string,
  source: ProjectArchiveSource,
  now?: () => string,
): Promise<ArchiveExportResult> {
  const entries: ArchiveEntry[] = [];
  for (const project of await source.listProjects(ownerId)) {
    entries.push({
      name: `projects/${project.id}.json`,
      bytes: Buffer.from(JSON.stringify(project.document), 'utf8'),
    });
    for (const asset of await source.listMediaAssets(project.id)) {
      entries.push({
        name: `media/${project.id}/${asset.id}-${sanitizeFileNameSegment(asset.displayName)}`,
        bytes: asset.bytes,
      });
    }
  }

  const manifest = now === undefined ? buildManifest(entries) : buildManifest(entries, now);
  const bundle: ArchiveBundle = {
    manifest,
    entries: entries.map((entry) => ({
      name: entry.name,
      bytesBase64: Buffer.from(entry.bytes).toString('base64'),
    })),
  };
  const plaintext = Buffer.from(JSON.stringify(bundle), 'utf8');
  const key = generateArchiveKey();
  const encrypted = encryptArchive(plaintext, key);
  return { manifest, encrypted, keyBase64: key.toString('base64') };
}

/** Strips path separators, `..` traversal sequences, and control characters so a display name
 * can never escape its `media/<projectId>/` prefix inside the archive namespace — even if a
 * future caller naively joins this name onto a filesystem path. */
function sanitizeFileNameSegment(value: string): string {
  const withoutControlChars = [...value].filter((char) => char.charCodeAt(0) > 0x1f).join('');
  const cleaned = withoutControlChars.replace(/[/\\]+/g, '_').replace(/\.\.+/g, '_');
  return cleaned.trim().slice(0, 200) || 'asset';
}
