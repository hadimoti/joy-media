import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readdirSync, unlinkSync } from 'node:fs';
import { access, mkdir, open, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { SqliteLocalAssetStore } from '../store/local-assets.js';

/** Largest original the editor may upload for a local render. */
export const MAX_LOCAL_ORIGINAL_BYTES = 5 * 1024 * 1024 * 1024;

/** Largest piece of an original that one chunked upload message may carry. */
export const MAX_ORIGINAL_CHUNK_BYTES = 16 * 1024 * 1024;

export type StoreOriginalResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface LocalOriginalWriter {
  storeOriginal(assetId: string, bytes: Uint8Array): Promise<StoreOriginalResult>;
  /**
   * Writes the next piece of a chunked upload. `offset` must equal the bytes already written, and
   * offset 0 starts a new upload, replacing any unfinished one.
   */
  appendOriginalChunk(
    assetId: string,
    offset: number,
    bytes: Uint8Array,
  ): Promise<StoreOriginalResult>;
  /** Checks a finished chunked upload against its registration and commits it under its checksum. */
  finishOriginalUpload(assetId: string): Promise<StoreOriginalResult>;
  /** Marks a finished upload as retained after its caller commits the surrounding operation. */
  commitOriginalUpload(assetId: string): void;
  /** Drops an unfinished upload, or rolls back a just-finished upload not yet committed by its caller. */
  abortOriginalUpload(assetId: string): Promise<void>;
  /** Drops every unfinished chunked upload and its temporary file. Called when the app quits. */
  abortAllOriginalUploads(): Promise<void>;
}

/** The message the renderer gets when a write fails. It never carries a file path. */
const STORE_FAILED = 'Original could not be stored';

/** An upload that is still being written in pieces, before it is checked and committed. */
interface PartialUpload {
  readonly path: string;
  readonly handle: FileHandle;
  written: number;
}

/**
 * Writes an uploaded original to `directory`, named by its checksum, after checking it against the
 * registration. A write goes to a temporary name first, so a crash never leaves a half file under
 * the final name. A filesystem error gets the fixed message above, because the Node error text
 * carries the full path.
 *
 * A chunked upload is written piece by piece to its own temporary name, and only the finished file
 * is checked and committed, so no piece has to hold the whole original.
 */
export function createLocalOriginalWriter(options: {
  readonly directory: string;
  readonly assets: SqliteLocalAssetStore;
}): LocalOriginalWriter {
  const uploads = new Map<string, PartialUpload>();
  const finishedUploads = new Map<string, { readonly path: string; readonly created: boolean }>();
  // The last step queued for each asset, so pieces, finish and abort for one asset never interleave.
  const queues = new Map<string, Promise<unknown>>();

  removeStaleUploads(options.directory);

  const discardUpload = async (assetId: string): Promise<void> => {
    const upload = uploads.get(assetId);
    if (upload === undefined) return;
    uploads.delete(assetId);
    await upload.handle.close().catch(() => undefined);
    await unlink(upload.path).catch(() => undefined);
  };

  /** Runs `step` once every earlier step for this asset has finished. */
  const inOrder = <T>(assetId: string, step: () => Promise<T>): Promise<T> => {
    const previous = queues.get(assetId) ?? Promise.resolve();
    const next = previous.then(step);
    const settled = next.catch(() => undefined);
    queues.set(assetId, settled);
    void settled.then(() => {
      if (queues.get(assetId) === settled) queues.delete(assetId);
    });
    return next;
  };

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

    appendOriginalChunk(assetId, offset, bytes) {
      return inOrder<StoreOriginalResult>(assetId, async () => {
        const asset = options.assets.get(assetId);
        if (asset === undefined) return { ok: false, error: 'Asset is not registered' };
        if (bytes.byteLength > MAX_ORIGINAL_CHUNK_BYTES) {
          return { ok: false, error: 'Original piece is larger than one message allows' };
        }
        if (offset === 0) await discardUpload(assetId);
        let upload = uploads.get(assetId);
        if (upload === undefined) {
          if (offset !== 0) return { ok: false, error: 'Original upload is out of order' };
          try {
            const path = join(options.directory, `${randomUUID()}.upload`);
            await mkdir(options.directory, { recursive: true });
            upload = { path, handle: await open(path, 'w'), written: 0 };
          } catch {
            return { ok: false, error: STORE_FAILED };
          }
          uploads.set(assetId, upload);
        }
        if (offset !== upload.written) {
          await discardUpload(assetId);
          return { ok: false, error: 'Original upload is out of order' };
        }
        if (upload.written + bytes.byteLength > asset.bytes) {
          await discardUpload(assetId);
          return { ok: false, error: 'Original size does not match its registration' };
        }
        try {
          let position = 0;
          while (position < bytes.byteLength) {
            const { bytesWritten } = await upload.handle.write(
              bytes,
              position,
              bytes.byteLength - position,
            );
            position += bytesWritten;
          }
        } catch {
          await discardUpload(assetId);
          return { ok: false, error: STORE_FAILED };
        }
        upload.written += bytes.byteLength;
        return { ok: true };
      });
    },

    finishOriginalUpload(assetId) {
      return inOrder<StoreOriginalResult>(assetId, async () => {
        const asset = options.assets.get(assetId);
        if (asset === undefined) return { ok: false, error: 'Asset is not registered' };
        const upload = uploads.get(assetId);
        if (upload === undefined) return { ok: false, error: 'Original upload is incomplete' };
        uploads.delete(assetId);
        // Flush the bytes before the file gets its final name, so a crash cannot commit a short file.
        const flushed = await upload.handle.sync().then(
          () => true,
          () => false,
        );
        await upload.handle.close().catch(() => undefined);
        if (!flushed) {
          await unlink(upload.path).catch(() => undefined);
          return { ok: false, error: STORE_FAILED };
        }
        if (upload.written !== asset.bytes) {
          await unlink(upload.path).catch(() => undefined);
          return { ok: false, error: 'Original size does not match its registration' };
        }
        const sha256 = await sha256OfFile(upload.path).catch(() => undefined);
        if (sha256 === undefined) {
          await unlink(upload.path).catch(() => undefined);
          return { ok: false, error: STORE_FAILED };
        }
        if (sha256 !== asset.sha256) {
          await unlink(upload.path).catch(() => undefined);
          return { ok: false, error: 'Original does not match its registered checksum' };
        }
        const target = join(options.directory, `${sha256}.bin`);
        let createdTarget = false;
        try {
          // The name is the checksum of the content, so a file already there holds these bytes.
          if (await exists(target)) await unlink(upload.path);
          else {
            await rename(upload.path, target);
            createdTarget = true;
          }
        } catch {
          await unlink(upload.path).catch(() => undefined);
          return { ok: false, error: STORE_FAILED };
        }
        options.assets.markStored(assetId, target);
        finishedUploads.set(assetId, { path: target, created: createdTarget });
        return { ok: true };
      });
    },

    commitOriginalUpload(assetId) {
      finishedUploads.delete(assetId);
    },

    abortOriginalUpload(assetId) {
      return inOrder<void>(assetId, async () => {
        await discardUpload(assetId);
        const finished = finishedUploads.get(assetId);
        finishedUploads.delete(assetId);
        if (finished?.created) await unlink(finished.path).catch(() => undefined);
      });
    },

    async abortAllOriginalUploads() {
      for (const assetId of [...uploads.keys()]) await discardUpload(assetId);
    },
  };
}

/** Removes the temporary files of uploads that an earlier run never finished. */
function removeStaleUploads(directory: string): void {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.upload')) continue;
    try {
      unlinkSync(join(directory, name));
    } catch {
      // A file that cannot be removed is tried again the next time the app starts.
    }
  }
}

/** The SHA-256 of a file, read in pieces, so the whole file is never held in memory. */
async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const piece of createReadStream(path)) hash.update(piece);
  return hash.digest('hex');
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
