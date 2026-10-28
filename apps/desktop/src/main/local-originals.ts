import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SqliteLocalAssetStore } from '../store/local-assets.js';

/** Largest original the editor may upload for a local render. */
export const MAX_LOCAL_ORIGINAL_BYTES = 1024 * 1024 * 1024;

export type StoreOriginalResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface LocalOriginalWriter {
  storeOriginal(assetId: string, bytes: Uint8Array): Promise<StoreOriginalResult>;
}

/** The message the renderer gets when a write fails. It never carries a file path. */
const STORE_FAILED = 'Original could not be stored';

/**
 * Writes an uploaded original to `directory`, named by its checksum, after checking it against the
 * registration. A write goes to a temporary name first, so a crash never leaves a half file under
 * the final name. A filesystem error gets the fixed message above, because the Node error text
 * carries the full path.
 */
export function createLocalOriginalWriter(options: {
  readonly directory: string;
  readonly assets: SqliteLocalAssetStore;
}): LocalOriginalWriter {
  return {
    async storeOriginal(assetId, bytes) {
      const asset = options.assets.get(assetId);
      if (asset === undefined) return { ok: false, error: 'Asset is not registered' };
      if (bytes.byteLength !== asset.bytes) {
        return { ok: false, error: 'Original size does not match its registration' };
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== asset.sha256) {
        return { ok: false, error: 'Original does not match its registered checksum' };
      }
      const target = join(options.directory, `${sha256}.bin`);
      const partial = `${target}.${randomUUID()}.partial`;
      try {
        await mkdir(options.directory, { recursive: true });
        await writeFile(partial, bytes);
        // The name is the checksum of the content, so a file already there holds these bytes.
        if (await exists(target)) await unlink(partial);
        else await rename(partial, target);
      } catch {
        await unlink(partial).catch(() => undefined);
        return { ok: false, error: STORE_FAILED };
      }
      options.assets.markStored(assetId, target);
      return { ok: true };
    },
  };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
