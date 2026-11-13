import { createHash } from 'node:crypto';
import { realpath as realpathCallback, type BigIntStats } from 'node:fs';
import { access, open, readdir, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  resolveDroppedPath,
  type DroppedPathSource,
  type OpaqueFileRef,
  type ResolvedDroppedPath,
} from '../file-boundary.js';
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
  revokeTickets(ticketIds: readonly string[]): void;
}

interface DroppedMediaImportDeps {
  readonly fileRegistry: FileRegistry;
  readonly assets: {
    get(assetId: string): LocalAsset | undefined;
    register(asset: LocalAssetRegistration): LocalAssetRegistrationResult;
    remove(assetId: string): void;
  };
  readonly originals: LocalOriginalWriter;
  readonly library?: AssetLibraryPort;
  readonly resolveDroppedPath?: (
    value: string,
    source?: DroppedPathSource,
  ) => Promise<ResolvedDroppedPath>;
  readonly fileSystem?: {
    open(filePath: string, flags: 'r'): Promise<FileHandle>;
    stat(filePath: string): Promise<BigIntStats>;
    realpathNative(filePath: string): Promise<string>;
  };
  readonly readDirectory?: (
    directory: string,
  ) => Promise<readonly { readonly name: string; readonly isFile: boolean }[]>;
  readonly readChunks?: (
    file: FileHandle,
    signal: AbortSignal,
    expectedBytes: number,
  ) => AsyncIterable<Uint8Array>;
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
const DROPPED_TICKET_TTL_MS = 2 * 60 * 1000;

async function* defaultReadChunks(
  file: FileHandle,
  signal: AbortSignal,
  expectedBytes: number,
): AsyncIterable<Uint8Array> {
  const stream = file.createReadStream({
    autoClose: false,
    end: expectedBytes - 1,
    highWaterMark: STREAM_CHUNK_BYTES,
    signal,
    start: 0,
  });
  for await (const chunk of stream) yield chunk;
}

function sameRealPath(left: string, right: string): boolean {
  const normalize = process.platform === 'win32' ? path.win32.normalize : path.normalize;
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function nativeRealpath(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    realpathCallback.native(filePath, (error, resolvedPath) => {
      if (error !== null) reject(error);
      else resolve(resolvedPath);
    });
  });
}

/**
 * Resolving both spellings with fs.realpath.native accepts a Windows 8.3 alias
 * only when it identifies the same canonical real path.
 */
export async function sameCanonicalRealPath(
  left: string,
  right: string,
  canonicalize: (filePath: string) => Promise<string> = nativeRealpath,
): Promise<boolean> {
  try {
    const [canonicalLeft, canonicalRight] = await Promise.all([
      canonicalize(left),
      canonicalize(right),
    ]);
    return sameRealPath(canonicalLeft, canonicalRight);
  } catch {
    return false;
  }
}

function sameFileVersion(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.ino !== 0n &&
    right.ino !== 0n &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    sameFileMetadata(left, right)
  );
}

function sameFileMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
  );
}

function sameOpenedFileVersion(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileMetadata(left, right) &&
    (left.ino === 0n || right.ino === 0n || sameFileVersion(left, right))
  );
}

async function stillMatchesOpenedFile(
  fileSystem: NonNullable<DroppedMediaImportDeps['fileSystem']>,
  file: FileHandle,
  sourcePath: string,
  validatedPath: string,
  initialPathInfo: BigIntStats,
  initialHandleInfo: BigIntStats,
  hasUsableFileIdentity: boolean,
): Promise<boolean> {
  try {
    const currentHandleInfo = await file.stat({ bigint: true });
    if (
      !currentHandleInfo.isFile() ||
      !sameOpenedFileVersion(initialHandleInfo, currentHandleInfo)
    ) {
      return false;
    }
    if (!hasUsableFileIdentity) return true;

    const [currentPathInfo, pathStillResolvesToTarget] = await Promise.all([
      fileSystem.stat(validatedPath),
      sameCanonicalRealPath(sourcePath, validatedPath, fileSystem.realpathNative),
    ]);
    return (
      currentPathInfo.isFile() &&
      pathStillResolvesToTarget &&
      sameFileVersion(initialPathInfo, initialHandleInfo) &&
      sameFileVersion(initialHandleInfo, currentPathInfo)
    );
  } catch {
    return false;
  }
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
  const resolvePath = deps.resolveDroppedPath ?? resolveDroppedPath;
  const fileSystem = deps.fileSystem ?? {
    open,
    stat: (filePath: string) => stat(filePath, { bigint: true }),
    realpathNative: nativeRealpath,
  };
  const readDirectory = deps.readDirectory ?? defaultReadDirectory;
  const readChunks = deps.readChunks ?? defaultReadChunks;
  const fileExists = deps.fileExists ?? defaultFileExists;
  const active = new Map<string, AbortController>();
  const pendingTickets = new Map<
    string,
    {
      readonly timer: ReturnType<typeof setTimeout>;
      readonly displayName: string;
      readonly mimeType: string;
    }
  >();
  const assetQueues = new Map<string, Promise<void>>();
  const revokePendingTicket = (ticketId: string): void => {
    const pending = pendingTickets.get(ticketId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    pendingTickets.delete(ticketId);
    deps.fileRegistry.revoke({
      kind: 'local-file',
      id: ticketId,
      displayName: pending.displayName,
    });
  };
  const rememberTicket = (ticket: DroppedMediaTicket): void => {
    const timer = setTimeout(() => revokePendingTicket(ticket.id), DROPPED_TICKET_TTL_MS);
    timer.unref?.();
    pendingTickets.set(ticket.id, {
      timer,
      displayName: ticket.displayName,
      mimeType: ticket.mimeType,
    });
  };
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

  const addCandidate = async (
    filePath: string,
    fallbackName: string,
    sourceIndex: number,
    source: DroppedPathSource,
    tickets: DroppedMediaTicket[],
    skippedNames: string[],
  ): Promise<void> => {
    let resolved: ResolvedDroppedPath;
    try {
      resolved = await resolvePath(filePath, source);
    } catch {
      skippedNames.push(safeName(fallbackName));
      return;
    }
    if (resolved.kind !== 'file') {
      skippedNames.push(safeName(fallbackName));
      return;
    }
    const mimeType = mediaType(fallbackName) ?? mediaType(resolved.path);
    if (mimeType === undefined) {
      skippedNames.push(safeName(fallbackName));
      return;
    }
    try {
      const ref = deps.fileRegistry.registerSelection(resolved.path, fallbackName);
      const ticket = { ...ref, mediaKind: mediaKind(mimeType), mimeType, sourceIndex };
      rememberTicket(ticket);
      tickets.push(ticket);
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
        let resolved: ResolvedDroppedPath;
        try {
          resolved = await resolvePath(input.path, 'direct');
        } catch {
          skippedNames.push(input.name);
          continue;
        }
        if (resolved.kind === 'directory') {
          folderCount += 1;
          let entries: readonly { readonly name: string; readonly isFile: boolean }[];
          try {
            entries = await readDirectory(resolved.path);
          } catch {
            skippedNames.push(input.name);
            continue;
          }
          for (const entry of entries) {
            if (!entry.isFile) continue;
            const childPath = path.join(resolved.path, entry.name);
            await addCandidate(childPath, entry.name, index, 'folder-entry', tickets, skippedNames);
          }
          continue;
        }
        await addCandidate(resolved.path, input.name, index, 'registered', tickets, skippedNames);
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
      const pending = pendingTickets.get(ticketId);
      if (
        !/^[A-Za-z0-9._-]{1,128}$/.test(ticketId) ||
        pending === undefined ||
        active.has(ticketId)
      ) {
        return { ok: false, error: 'Dropped media ticket is invalid' };
      }
      clearTimeout(pending.timer);
      pendingTickets.delete(ticketId);
      const ref: OpaqueFileRef = { kind: 'local-file', id: ticketId, displayName: '' };
      let sourcePath: string;
      try {
        sourcePath = deps.fileRegistry.resolvePath(ref);
      } catch {
        deps.fileRegistry.revoke(ref);
        return { ok: false, error: 'Dropped media ticket is invalid' };
      }
      const controller = new AbortController();
      active.set(ticketId, controller);
      let uploadStarted = false;
      let committed = false;
      let originalFinished = false;
      let openedFile: FileHandle | undefined;
      let registeredAssetId: string | undefined;
      const uploadId = `dropped-${ticketId}`;
      const addToLibrary = async (id: string) => {
        if (isCancelled(controller.signal)) throw cancellationError();
        const result = await deps.library?.addAsset(id);
        if (isCancelled(controller.signal)) {
          if (result?.ok) await deps.library?.removeEntry(id).catch(() => undefined);
          throw cancellationError();
        }
        return result;
      };
      try {
        const info = await resolvePath(sourcePath, 'registered');
        const mimeType = pending.mimeType;
        if (info.kind !== 'file' || mimeType === undefined) {
          return { ok: false, error: 'Dropped media ticket is invalid' };
        }
        if (info.size < 1) return { ok: false, error: 'Selected media file is empty' };
        if (info.size > MAX_LOCAL_ORIGINAL_BYTES) {
          return { ok: false, error: 'The selected media file is too large' };
        }

        if (isCancelled(controller.signal)) throw cancellationError();
        const validatedPathInfo = await fileSystem.stat(info.path);
        if (!validatedPathInfo.isFile()) {
          return { ok: false, error: 'Dropped media ticket is invalid' };
        }
        if (validatedPathInfo.size < 1n) {
          return { ok: false, error: 'Selected media file is empty' };
        }
        if (validatedPathInfo.size > BigInt(MAX_LOCAL_ORIGINAL_BYTES)) {
          return { ok: false, error: 'The selected media file is too large' };
        }
        if (validatedPathInfo.size !== BigInt(info.size)) {
          return { ok: false, error: 'The selected media file changed during import' };
        }
        if (!(await sameCanonicalRealPath(sourcePath, info.path, fileSystem.realpathNative))) {
          return { ok: false, error: 'The selected media file changed during import' };
        }

        openedFile = await fileSystem.open(sourcePath, 'r');
        const openedInfo = await openedFile.stat({ bigint: true });
        if (!openedInfo.isFile()) {
          return { ok: false, error: 'Dropped media ticket is invalid' };
        }
        if (openedInfo.size < 1n) return { ok: false, error: 'Selected media file is empty' };
        if (openedInfo.size > BigInt(MAX_LOCAL_ORIGINAL_BYTES)) {
          return { ok: false, error: 'The selected media file is too large' };
        }
        const hasUsableFileIdentity = validatedPathInfo.ino !== 0n && openedInfo.ino !== 0n;
        // An inode of 0 cannot prove path/handle identity. In that case, the single stream below
        // hashes the staged bytes, and finishOriginalUpload verifies the copy without rereading
        // the source path.
        if (
          openedInfo.size !== BigInt(info.size) ||
          (hasUsableFileIdentity && !sameFileVersion(validatedPathInfo, openedInfo))
        ) {
          return { ok: false, error: 'The selected media file changed during import' };
        }
        const openedSize = Number(openedInfo.size);
        if (isCancelled(controller.signal)) throw cancellationError();

        const hash = createHash('sha256');
        let hashedBytes = 0;
        let written = 0;
        const started = await deps.originals.beginOriginalUpload(uploadId, openedSize);
        if (!started.ok) return { ok: false, error: 'The original could not be stored' };
        uploadStarted = true;
        for await (const piece of readChunks(openedFile, controller.signal, openedSize)) {
          if (isCancelled(controller.signal)) throw cancellationError();
          const bytes = Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
          if (
            hashedBytes + bytes.byteLength > openedSize ||
            hashedBytes + bytes.byteLength > MAX_LOCAL_ORIGINAL_BYTES
          ) {
            return { ok: false, error: 'The selected media file changed during import' };
          }
          for (let offset = 0; offset < bytes.byteLength; offset += MAX_ORIGINAL_CHUNK_BYTES) {
            if (isCancelled(controller.signal)) throw cancellationError();
            const chunk = Buffer.from(
              bytes.subarray(offset, Math.min(bytes.byteLength, offset + MAX_ORIGINAL_CHUNK_BYTES)),
            );
            const result = await deps.originals.appendOriginalChunk(uploadId, written, chunk);
            if (!result.ok) return { ok: false, error: 'The original could not be stored' };
            hash.update(chunk);
            hashedBytes += chunk.byteLength;
            written += chunk.byteLength;
            reportProgress({
              ticketId,
              stage: 'hash',
              ratio: Math.min(1, hashedBytes / openedSize),
            });
            reportProgress({
              ticketId,
              stage: 'store',
              ratio: Math.min(1, written / openedSize),
            });
          }
        }
        if (isCancelled(controller.signal)) throw cancellationError();
        if (
          hashedBytes !== openedSize ||
          written !== openedSize ||
          !(await stillMatchesOpenedFile(
            fileSystem,
            openedFile,
            sourcePath,
            info.path,
            validatedPathInfo,
            openedInfo,
            hasUsableFileIdentity,
          ))
        ) {
          return { ok: false, error: 'The selected media file changed during import' };
        }
        const sha256 = hash.digest('hex');
        const importAssetId = `joylib-${sha256}`;
        const kind = mediaKind(mimeType);
        const displayName = pending.displayName;
        const descriptor = safeDescriptor(mimeType, rawDescriptor);
        return await withAssetQueue(importAssetId, async () => {
          if (isCancelled(controller.signal)) throw cancellationError();
          const existing = deps.assets.get(importAssetId);
          if (
            existing !== undefined &&
            (existing.sha256 !== sha256 || existing.bytes !== openedSize)
          ) {
            return { ok: false, error: 'Asset ID is already registered with other content' };
          }

          if (existing?.storedPath !== undefined && (await fileExists(existing.storedPath))) {
            await deps.originals.abortOriginalUpload(uploadId);
            uploadStarted = false;
            if (isCancelled(controller.signal)) throw cancellationError();
            const libraryResult = await addToLibrary(importAssetId);
            if (isCancelled(controller.signal)) {
              if (libraryResult?.ok)
                await deps.library?.removeEntry(importAssetId).catch(() => undefined);
              throw cancellationError();
            }
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
                bytes: openedSize,
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
            bytes: openedSize,
            descriptor,
          });
          if (registration.kind === 'conflict') {
            return { ok: false, error: 'Asset ID is already registered with other content' };
          }
          registeredAssetId = importAssetId;

          const finished = await deps.originals.finishOriginalUpload(uploadId, importAssetId);
          if (!finished.ok) {
            if (isCancelled(controller.signal)) throw cancellationError();
            return { ok: false, error: 'The original could not be stored' };
          }
          originalFinished = true;
          if (isCancelled(controller.signal)) throw cancellationError();
          const libraryResult = await addToLibrary(importAssetId);
          if (isCancelled(controller.signal)) {
            if (libraryResult?.ok)
              await deps.library?.removeEntry(importAssetId).catch(() => undefined);
            throw cancellationError();
          }
          if (libraryResult !== undefined && !libraryResult.ok) {
            return { ok: false, error: 'The asset library could not be updated' };
          }
          deps.originals.commitOriginalUpload(uploadId);
          committed = true;
          return {
            ok: true,
            data: {
              id: importAssetId,
              kind,
              displayName,
              sha256,
              bytes: openedSize,
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
        await openedFile?.close().catch(() => undefined);
        if (uploadStarted && !committed) {
          if (originalFinished && !isCancelled(controller.signal)) {
            deps.originals.commitOriginalUpload(uploadId);
          } else {
            await deps.originals.abortOriginalUpload(uploadId).catch(() => undefined);
          }
        }
        if (
          registeredAssetId !== undefined &&
          !committed &&
          (!originalFinished || isCancelled(controller.signal))
        ) {
          if (isCancelled(controller.signal)) {
            await deps.library?.removeEntry(registeredAssetId).catch(() => undefined);
          }
          deps.assets.remove(registeredAssetId);
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

    revokeTickets(ticketIds) {
      for (const ticketId of ticketIds) revokePendingTicket(ticketId);
    },
  };
}
