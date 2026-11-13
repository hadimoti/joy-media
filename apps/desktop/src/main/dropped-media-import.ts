import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { OpaqueFileRef } from '../file-boundary.js';
import type { FileRegistry } from './file-registry.js';
import {
  MAX_LOCAL_ORIGINAL_BYTES,
  MAX_ORIGINAL_CHUNK_BYTES,
  type LocalOriginalWriter,
} from './local-originals.js';
import type { AssetLibraryPort } from '../store/asset-library.js';
import type {
  LocalAsset,
  LocalAssetRegistration,
  LocalAssetRegistrationResult,
} from '../store/local-assets.js';

export interface DroppedFileInput {
  readonly path: string;
  readonly name: string;
}

export interface DroppedMediaTicket extends OpaqueFileRef {
  readonly mediaKind: 'video' | 'audio' | 'image';
  readonly mimeType: string;
  readonly sourceIndex: number;
}

export interface DroppedFileBatch {
  readonly tickets: readonly DroppedMediaTicket[];
  readonly skippedMessage?: string;
  /** Dropped directories are expanded into immediate files only. */
  readonly folderDepth: 1;
  readonly folderCount: number;
}

export interface DroppedMediaProgress {
  readonly ticketId: string;
  readonly stage: 'hash' | 'store';
  readonly ratio: number;
}

export interface DroppedMediaAsset {
  readonly id: string;
  readonly kind: 'video' | 'audio' | 'image';
  readonly displayName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: Readonly<Record<string, unknown>>;
  readonly deduplicated: boolean;
}

export type DroppedMediaResult =
  | { readonly ok: true; readonly data: DroppedMediaAsset }
  | { readonly ok: false; readonly error: string };

export interface DroppedMediaImportService {
  prepareDroppedPaths(value: unknown): Promise<DroppedFileBatch>;
  importTicket(ticketId: string, descriptor?: unknown): Promise<DroppedMediaResult>;
  cancel(ticketId: string): Promise<{ readonly ok: boolean }>;
}

interface DroppedMediaImportDeps {
  readonly fileRegistry: FileRegistry;
  readonly assets: {
    get(assetId: string): LocalAsset | undefined;
    register(asset: LocalAssetRegistration): LocalAssetRegistrationResult;
  };
  readonly originals: LocalOriginalWriter;
  readonly library?: AssetLibraryPort;
  readonly statPath?: (filePath: string) => Promise<{
    readonly isFile: boolean;
    readonly isDirectory: boolean;
    readonly size: number;
  }>;
  readonly readDirectory?: (
    directory: string,
  ) => Promise<readonly { readonly name: string; readonly isFile: boolean }[]>;
  readonly readChunks?: (filePath: string, signal: AbortSignal) => AsyncIterable<Uint8Array>;
  readonly fileExists?: (filePath: string) => Promise<boolean>;
  readonly onProgress?: (progress: DroppedMediaProgress) => void;
}

const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  aac: 'audio/aac',
  aiff: 'audio/aiff',
  avif: 'image/avif',
  bmp: 'image/bmp',
  flac: 'audio/flac',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  m4a: 'audio/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  ogv: 'video/ogg',
  png: 'image/png',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
};

const MAX_DROPPED_ITEMS = 512;
const MAX_DROPPED_PATH_LENGTH = 32_768;
const STREAM_CHUNK_BYTES = 1024 * 1024;

function defaultStat(filePath: string): Promise<{
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
}> {
  return stat(filePath).then((result) => ({
    isFile: result.isFile(),
    isDirectory: result.isDirectory(),
    size: result.size,
  }));
}

async function* defaultReadChunks(
  filePath: string,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const stream = createReadStream(filePath, { highWaterMark: STREAM_CHUNK_BYTES, signal });
  for await (const chunk of stream) yield chunk;
}

function defaultReadDirectory(
  directory: string,
): Promise<readonly { readonly name: string; readonly isFile: boolean }[]> {
  return readdir(directory, { withFileTypes: true }).then((entries) =>
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, isFile: true }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
}

async function defaultFileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

function safeName(value: string): string {
  return path.basename(value.replaceAll('\0', '')).slice(0, 255) || 'unnamed file';
}

function mediaType(filePath: string): string | undefined {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return MEDIA_TYPE_BY_EXTENSION[extension];
}

function mediaKind(mimeType: string): 'video' | 'audio' | 'image' {
  return mimeType.startsWith('video/')
    ? 'video'
    : mimeType.startsWith('audio/')
      ? 'audio'
      : 'image';
}

function parseInput(value: unknown): DroppedFileInput | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['path'] !== 'string' ||
    candidate['path'].length > MAX_DROPPED_PATH_LENGTH ||
    candidate['path'].includes('\0') ||
    typeof candidate['name'] !== 'string'
  ) {
    return undefined;
  }
  return { path: candidate['path'], name: safeName(candidate['name']) };
}

function safeDescriptor(mimeType: string, value: unknown): Readonly<Record<string, unknown>> {
  const descriptor: Record<string, unknown> = { mimeType };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return descriptor;
  const candidate = value as Record<string, unknown>;
  for (const key of ['durationUs', 'width', 'height'] as const) {
    const number = candidate[key];
    if (typeof number === 'number' && Number.isSafeInteger(number) && number > 0) {
      descriptor[key] = number;
    }
  }
  return descriptor;
}

function isCancelled(signal: AbortSignal): boolean {
  return signal.aborted;
}

function cancellationError(): Error {
  return new Error('Import cancelled');
}

export function createDroppedMediaImportService(
  deps: DroppedMediaImportDeps,
): DroppedMediaImportService {
  const statPath = deps.statPath ?? defaultStat;
  const readDirectory = deps.readDirectory ?? defaultReadDirectory;
  const readChunks = deps.readChunks ?? defaultReadChunks;
  const fileExists = deps.fileExists ?? defaultFileExists;
  const active = new Map<string, AbortController>();
  const assetQueues = new Map<string, Promise<void>>();
  const reportProgress = (progress: DroppedMediaProgress): void => {
    try {
      deps.onProgress?.(progress);
    } catch {
      // A closed renderer cannot interrupt the main-process import.
    }
  };
  const withAssetQueue = async <T>(assetId: string, task: () => Promise<T>): Promise<T> => {
    const previous = assetQueues.get(assetId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    assetQueues.set(assetId, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (assetQueues.get(assetId) === tail) assetQueues.delete(assetId);
    }
  };

  const addCandidate = (
    filePath: string,
    fallbackName: string,
    sourceIndex: number,
    tickets: DroppedMediaTicket[],
    skippedNames: string[],
  ): void => {
    const mimeType = mediaType(filePath);
    if (mimeType === undefined) {
      skippedNames.push(safeName(fallbackName));
      return;
    }
    try {
      const ref = deps.fileRegistry.registerSelection(filePath, fallbackName);
      tickets.push({ ...ref, mediaKind: mediaKind(mimeType), mimeType, sourceIndex });
    } catch {
      skippedNames.push(safeName(fallbackName));
    }
  };

  return {
    async prepareDroppedPaths(value) {
      const inputs = Array.isArray(value) ? value.slice(0, MAX_DROPPED_ITEMS) : [];
      const tickets: DroppedMediaTicket[] = [];
      const skippedNames: string[] = [];
      let folderCount = 0;
      for (let index = 0; index < inputs.length; index += 1) {
        const input = parseInput(inputs[index]);
        if (input === undefined) continue;
        let info: Awaited<ReturnType<typeof statPath>>;
        try {
          info = await statPath(input.path);
        } catch {
          skippedNames.push(input.name);
          continue;
        }
        if (info.isDirectory) {
          folderCount += 1;
          let entries: readonly { readonly name: string; readonly isFile: boolean }[];
          try {
            entries = await readDirectory(input.path);
          } catch {
            skippedNames.push(input.name);
            continue;
          }
          for (const entry of entries) {
            if (!entry.isFile) continue;
            const childPath = path.join(input.path, entry.name);
            addCandidate(childPath, entry.name, index, tickets, skippedNames);
          }
          continue;
        }
        if (info.isFile) addCandidate(input.path, input.name, index, tickets, skippedNames);
        else skippedNames.push(input.name);
      }
      const skippedMessage =
        skippedNames.length === 0
          ? undefined
          : `${skippedNames.length} ${skippedNames.length === 1 ? 'file was' : 'files were'} skipped: ${skippedNames.join(', ')}`;
      return {
        tickets,
        ...(skippedMessage === undefined ? {} : { skippedMessage }),
        folderDepth: 1,
        folderCount,
      };
    },

    async importTicket(ticketId, rawDescriptor) {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(ticketId) || active.has(ticketId)) {
        return { ok: false, error: 'Dropped media ticket is invalid' };
      }
      const ref: OpaqueFileRef = { kind: 'local-file', id: ticketId, displayName: '' };
      let sourcePath: string;
      try {
        sourcePath = deps.fileRegistry.resolvePath(ref);
      } catch {
        return { ok: false, error: 'Dropped media ticket is invalid' };
      }
      const controller = new AbortController();
      active.set(ticketId, controller);
      let uploadStarted = false;
      let committed = false;
      let assetId: string | undefined;
      try {
        const info = await statPath(sourcePath);
        const mimeType = mediaType(sourcePath);
        if (!info.isFile || mimeType === undefined) {
          return { ok: false, error: 'Dropped media ticket is invalid' };
        }
        if (info.size < 1) return { ok: false, error: 'Selected media file is empty' };
        if (info.size > MAX_LOCAL_ORIGINAL_BYTES) {
          return { ok: false, error: 'The selected media file is too large' };
        }

        const hash = createHash('sha256');
        let hashedBytes = 0;
        for await (const piece of readChunks(sourcePath, controller.signal)) {
          if (isCancelled(controller.signal)) throw cancellationError();
          const bytes = Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
          hashedBytes += bytes.byteLength;
          if (hashedBytes > info.size || hashedBytes > MAX_LOCAL_ORIGINAL_BYTES) {
            return { ok: false, error: 'The selected media file changed during import' };
          }
          hash.update(bytes);
          reportProgress({ ticketId, stage: 'hash', ratio: Math.min(1, hashedBytes / info.size) });
        }
        if (isCancelled(controller.signal)) throw cancellationError();
        if (hashedBytes !== info.size) {
          return { ok: false, error: 'The selected media file changed during import' };
        }
        const sha256 = hash.digest('hex');
        const importAssetId = `joylib-${sha256}`;
        assetId = importAssetId;
        const kind = mediaKind(mimeType);
        const displayName = path.basename(sourcePath).slice(0, 255) || 'selected media';
        const descriptor = safeDescriptor(mimeType, rawDescriptor);
        return await withAssetQueue(importAssetId, async () => {
          if (isCancelled(controller.signal)) throw cancellationError();
          const existing = deps.assets.get(importAssetId);
          if (
            existing !== undefined &&
            (existing.sha256 !== sha256 || existing.bytes !== info.size)
          ) {
            return { ok: false, error: 'Asset ID is already registered with other content' };
          }

          if (existing?.storedPath !== undefined && (await fileExists(existing.storedPath))) {
            const libraryResult = await deps.library?.addAsset(importAssetId);
            if (libraryResult !== undefined && !libraryResult.ok) {
              return { ok: false, error: 'The asset library could not be updated' };
            }
            return {
              ok: true,
              data: {
                id: importAssetId,
                kind: existing.kind as 'video' | 'audio' | 'image',
                displayName: existing.displayName,
                sha256,
                bytes: info.size,
                descriptor: existing.descriptor ?? descriptor,
                deduplicated: true,
              },
            };
          }

          const registration = deps.assets.register({
            id: importAssetId,
            kind,
            displayName,
            sha256,
            bytes: info.size,
            descriptor,
          });
          if (registration.kind === 'conflict') {
            return { ok: false, error: 'Asset ID is already registered with other content' };
          }

          let written = 0;
          for await (const piece of readChunks(sourcePath, controller.signal)) {
            if (isCancelled(controller.signal)) throw cancellationError();
            const bytes = Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
            for (let offset = 0; offset < bytes.byteLength; offset += MAX_ORIGINAL_CHUNK_BYTES) {
              if (isCancelled(controller.signal)) throw cancellationError();
              const chunk = bytes.subarray(
                offset,
                Math.min(bytes.byteLength, offset + MAX_ORIGINAL_CHUNK_BYTES),
              );
              uploadStarted = true;
              const result = await deps.originals.appendOriginalChunk(
                importAssetId,
                written,
                chunk,
              );
              if (!result.ok) return { ok: false, error: 'The original could not be stored' };
              written += chunk.byteLength;
              reportProgress({ ticketId, stage: 'store', ratio: Math.min(1, written / info.size) });
            }
          }
          if (isCancelled(controller.signal)) throw cancellationError();
          if (written !== info.size) {
            return { ok: false, error: 'The selected media file changed during import' };
          }
          const finished = await deps.originals.finishOriginalUpload(importAssetId);
          if (!finished.ok) return { ok: false, error: 'The original could not be stored' };
          committed = true;
          const libraryResult = await deps.library?.addAsset(importAssetId);
          if (libraryResult !== undefined && !libraryResult.ok) {
            return { ok: false, error: 'The asset library could not be updated' };
          }
          return {
            ok: true,
            data: {
              id: importAssetId,
              kind,
              displayName,
              sha256,
              bytes: info.size,
              descriptor,
              deduplicated: false,
            },
          };
        });
      } catch {
        return {
          ok: false,
          error: isCancelled(controller.signal)
            ? 'Import cancelled'
            : 'The selected media file could not be imported',
        };
      } finally {
        if (uploadStarted && !committed && assetId !== undefined) {
          await deps.originals.abortOriginalUpload(assetId).catch(() => undefined);
        }
        deps.fileRegistry.revoke(ref);
        active.delete(ticketId);
      }
    },

    async cancel(ticketId) {
      const controller = active.get(ticketId);
      if (controller === undefined) return { ok: false };
      controller.abort();
      return { ok: true };
    },
  };
}
