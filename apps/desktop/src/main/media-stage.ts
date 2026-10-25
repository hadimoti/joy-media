import { createHash, randomUUID, type Hash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { open, readdir, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpaqueFileRef } from '../file-boundary.js';
import type { FileRegistry } from './file-registry.js';
import { checksumFile, classifyMediaKind } from './media-checksum.js';
import type { MediaManifestEntry } from '../store/local-database.js';

/**
 * Makes an editor-imported original readable by the local Worker.
 *
 * The browser keeps its own copy of every original (OPFS) and the project never records a desktop
 * path, so this module receives the bytes in bounded chunks, verifies them against the asset's
 * SHA-256 and size, and stores them under the desktop media root keyed by that hash. A later
 * request for the same hash reuses the verified copy instead of uploading the file again.
 */

/** Same ceiling the local job API enforces for Worker source reads. */
export const MAX_STAGED_BYTES = 512 * 1024 * 1024;
/** Upper bound for one chunk so no single IPC message carries a large buffer. */
export const MAX_STAGE_CHUNK_BYTES = 8 * 1024 * 1024;
/** Abandoned partial uploads are removed after this much inactivity. */
export const STAGE_UPLOAD_IDLE_MS = 10 * 60_000;
/** Verified copies beyond this total are evicted, oldest first, when no session still uses them. */
export const DEFAULT_STAGE_CACHE_BUDGET_BYTES = 4 * 1024 * 1024 * 1024;

const INCOMING_DIRECTORY = 'incoming';
const CACHED_SUFFIX = '.bin';

export interface StageBeginRequest {
  readonly sha256: string;
  readonly bytes: number;
  readonly displayName: string;
}

export type StageBeginResult =
  | { readonly status: 'cached'; readonly ref: OpaqueFileRef }
  | { readonly status: 'upload'; readonly uploadId: string };

export interface MediaStageOptions {
  /** Root for staged media; the directory is created if missing. */
  readonly directory: string;
  readonly registry: FileRegistry;
  readonly localDatabase: { recordMedia(entry: MediaManifestEntry): void };
  readonly now: () => string;
  readonly nowMs?: () => number;
  readonly cacheBudgetBytes?: number;
}

export interface MediaStage {
  begin(request: StageBeginRequest): Promise<StageBeginResult>;
  chunk(request: {
    readonly uploadId: string;
    readonly offset: number;
    readonly data: Uint8Array;
  }): Promise<{ readonly received: number }>;
  finish(request: { readonly uploadId: string }): Promise<OpaqueFileRef>;
  abort(request: { readonly uploadId: string }): Promise<void>;
  /** The verified cached copy for a hash, if one exists with the expected size. */
  cachedPath(sha256: string, bytes: number): Promise<string | undefined>;
  close(): Promise<void>;
}

interface Upload {
  readonly request: StageBeginRequest;
  readonly path: string;
  readonly handle: FileHandle;
  readonly hash: Hash;
  received: number;
  lastTouchedMs: number;
  /** Serializes chunk writes so offsets are applied in order even if calls overlap. */
  queue: Promise<unknown>;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function validateStageRequest(request: StageBeginRequest): void {
  if (!SHA256_PATTERN.test(request.sha256)) throw new Error('Staged media hash is invalid');
  if (!Number.isSafeInteger(request.bytes) || request.bytes < 1)
    throw new Error('Staged media size is invalid');
  if (request.bytes > MAX_STAGED_BYTES)
    throw new Error('Media is larger than the local Worker can read');
  if (
    request.displayName.length < 1 ||
    request.displayName.length > 255 ||
    /[\\/\0]/.test(request.displayName)
  )
    throw new Error('Staged media name is invalid');
}

export function createMediaStage(options: MediaStageOptions): MediaStage {
  const nowMs = options.nowMs ?? (() => Date.now());
  const budget = options.cacheBudgetBytes ?? DEFAULT_STAGE_CACHE_BUDGET_BYTES;
  const incomingDirectory = join(options.directory, INCOMING_DIRECTORY);
  // Partial uploads never survive a restart: the renderer that owned them is gone.
  rmSync(incomingDirectory, { recursive: true, force: true });
  mkdirSync(incomingDirectory, { recursive: true });

  const uploads = new Map<string, Upload>();
  // Copies registered by this session. Their paths stay in use, so eviction must skip them.
  const inUse = new Set<string>();

  // Only a validated hash ever becomes a file name, so a renderer cannot steer a path.
  const cachedFile = (sha256: string) => {
    if (!SHA256_PATTERN.test(sha256)) throw new Error('Staged media hash is invalid');
    return join(options.directory, `${sha256}${CACHED_SUFFIX}`);
  };

  async function register(path: string, request: StageBeginRequest): Promise<OpaqueFileRef> {
    const ref = options.registry.registerSelection(path, request.displayName);
    inUse.add(path);
    options.localDatabase.recordMedia({
      refId: ref.id,
      checksum: request.sha256,
      kind: classifyMediaKind(request.displayName),
      byteSize: request.bytes,
      lastVerifiedAt: options.now(),
    });
    return ref;
  }

  async function evictOverBudget(): Promise<void> {
    const entries = await Promise.all(
      (await readdir(options.directory))
        .filter((name) => name.endsWith(CACHED_SUFFIX))
        .map(async (name) => {
          const path = join(options.directory, name);
          const info = await stat(path);
          return { path, size: info.size, modified: info.mtimeMs };
        }),
    );
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const evictable = entries
      .filter((entry) => !inUse.has(entry.path))
      .sort((left, right) => left.modified - right.modified);
    for (const entry of evictable) {
      if (total <= budget) break;
      await rm(entry.path, { force: true });
      total -= entry.size;
    }
  }

  async function pruneIdleUploads(): Promise<void> {
    const cutoff = nowMs() - STAGE_UPLOAD_IDLE_MS;
    for (const [uploadId, upload] of uploads) {
      if (upload.lastTouchedMs >= cutoff) continue;
      uploads.delete(uploadId);
      await upload.handle.close().catch(() => undefined);
      await rm(upload.path, { force: true });
    }
  }

  function requireUpload(uploadId: string): Upload {
    const upload = uploads.get(uploadId);
    if (upload === undefined) throw new Error('Unknown or expired media upload');
    upload.lastTouchedMs = nowMs();
    return upload;
  }

  return {
    async begin(request) {
      validateStageRequest(request);
      await pruneIdleUploads();
      const cached = await cachedPath(request.sha256, request.bytes);
      if (cached !== undefined) {
        // A cached copy is trusted only after it re-hashes to the hash the asset was imported with.
        const verified = await checksumFile(cached);
        if (verified.checksum === request.sha256 && verified.byteSize === request.bytes)
          return { status: 'cached', ref: await register(cached, request) };
        await rm(cached, { force: true });
      }
      const uploadId = randomUUID();
      const partial = join(incomingDirectory, `${uploadId}.part`);
      const handle = await open(partial, 'wx');
      uploads.set(uploadId, {
        request,
        path: partial,
        handle,
        hash: createHash('sha256'),
        received: 0,
        lastTouchedMs: nowMs(),
        queue: Promise.resolve(),
      });
      return { status: 'upload', uploadId };
    },

    async chunk(request) {
      const upload = requireUpload(request.uploadId);
      const run = upload.queue.then(async () => {
        const { data, offset } = request;
        if (!(data instanceof Uint8Array)) throw new Error('Media chunk must be bytes');
        if (data.byteLength < 1 || data.byteLength > MAX_STAGE_CHUNK_BYTES)
          throw new Error('Media chunk size is invalid');
        if (offset !== upload.received) throw new Error('Media chunk arrived out of order');
        if (upload.received + data.byteLength > upload.request.bytes)
          throw new Error('Media chunk exceeds the declared size');
        const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        await upload.handle.write(buffer, 0, buffer.byteLength, upload.received);
        upload.hash.update(buffer);
        upload.received += buffer.byteLength;
        upload.lastTouchedMs = nowMs();
        return { received: upload.received };
      });
      upload.queue = run.catch(() => undefined);
      return run;
    },

    async finish(request) {
      const upload = requireUpload(request.uploadId);
      await upload.queue;
      uploads.delete(request.uploadId);
      await upload.handle.close();
      const digest = upload.hash.digest('hex');
      if (upload.received !== upload.request.bytes || digest !== upload.request.sha256) {
        await rm(upload.path, { force: true });
        throw new Error('Staged media did not match the hash it was imported with');
      }
      const finalPath = cachedFile(upload.request.sha256);
      await rename(upload.path, finalPath);
      const ref = await register(finalPath, upload.request);
      await evictOverBudget();
      return ref;
    },

    abort(request) {
      return abortUpload(request.uploadId);
    },

    cachedPath,

    async close() {
      for (const uploadId of [...uploads.keys()]) await abortUpload(uploadId);
    },
  };

  async function abortUpload(uploadId: string): Promise<void> {
    const upload = uploads.get(uploadId);
    if (upload === undefined) return;
    uploads.delete(uploadId);
    await upload.queue;
    await upload.handle.close().catch(() => undefined);
    await rm(upload.path, { force: true });
  }

  async function cachedPath(sha256: string, bytes: number): Promise<string | undefined> {
    if (!SHA256_PATTERN.test(sha256)) return undefined;
    const path = cachedFile(sha256);
    try {
      const info = await stat(path);
      return info.isFile() && info.size === bytes ? path : undefined;
    } catch {
      return undefined;
    }
  }
}
