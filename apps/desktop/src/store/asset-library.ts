import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { LocalAsset } from './local-assets.js';

export interface AssetLibraryPort {
  addAsset(
    assetId: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
}

interface AssetLibraryOptions {
  readonly directory: () => string;
  readonly registrations: { get(assetId: string): LocalAsset | undefined };
  readonly lockWaitMs?: number;
  /** Test seam for simulating owner-token write failures. */
  readonly writeOwnerToken?: (handle: FileHandle, token: string) => Promise<void>;
}

interface LibraryEntry {
  readonly id: string;
  readonly projectId: string;
  readonly kind: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: Readonly<Record<string, unknown>>;
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly cloudBacked: boolean;
  readonly relativePath: string;
  readonly displayName: string;
  readonly sortName: string;
}

const BUSY_MESSAGE = 'The asset library is busy. Try the import again.';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STALE_LOCK_MS = 60_000;
const LOCK_POLL_MS = 100;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function acquireLock(
  lockPath: string,
  lockWaitMs: number,
  ownerToken: string,
  onAcquired: () => void,
  writeOwnerToken: (handle: FileHandle, token: string) => Promise<void>,
): Promise<boolean> {
  const startedAt = Date.now();
  while (true) {
    let handle;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      try {
        const lockContent = await readFile(lockPath);
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
          const currentContent = await readFile(lockPath);
          const currentStat = await stat(lockPath);
          if (currentStat.mtimeMs === lockStat.mtimeMs && currentContent.equals(lockContent)) {
            // Rechecking narrows the race; atomic stale-lock reclamation is out of scope.
            await unlink(lockPath);
          }
          continue;
        }
      } catch (statError) {
        if (
          typeof statError === 'object' &&
          statError !== null &&
          'code' in statError &&
          statError.code === 'ENOENT'
        ) {
          continue;
        }
        throw statError;
      }
      if (Date.now() - startedAt >= lockWaitMs) return false;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(LOCK_POLL_MS, Math.max(1, lockWaitMs - (Date.now() - startedAt))),
        ),
      );
      continue;
    }
    onAcquired();
    try {
      await writeOwnerToken(handle, ownerToken);
    } finally {
      await handle.close();
    }
    return true;
  }
}

export function createAssetLibrary(options: AssetLibraryOptions): AssetLibraryPort {
  const lockWaitMs = options.lockWaitMs ?? 10_000;
  return {
    async addAsset(assetId) {
      let locked = false;
      let catalogWritten = false;
      let temporaryPath: string | undefined;
      let result:
        { readonly ok: true } | { readonly ok: false; readonly error: string } | undefined;
      let operationError: string | undefined;
      let cleanupError: string | undefined;
      let lockPath: string | undefined;
      let ownerToken: string | undefined;
      try {
        const registration = options.registrations.get(assetId);
        if (registration === undefined) throw new Error('Asset is not registered');
        if (!registration.storedPath) throw new Error('The original has not been stored yet');
        if (!SHA256_PATTERN.test(registration.sha256)) {
          throw new Error('Asset has an invalid SHA-256 checksum');
        }
        if (
          registration.kind !== 'image' &&
          registration.kind !== 'audio' &&
          registration.kind !== 'video'
        ) {
          throw new Error('Asset kind is not supported by the asset library');
        }

        const directory = options.directory();
        const folder = registration.kind === 'image' ? 'images' : registration.kind;
        const id = `joylib-${registration.sha256}`;
        const relativePath = `${folder}/${id}`;
        const target = path.join(directory, relativePath);
        const catalogPath = path.join(directory, 'catalog.json');
        const backupPath = `${catalogPath}.joy-media-backup`;
        lockPath = `${catalogPath}.lock`;
        ownerToken = randomUUID();
        await mkdir(directory, { recursive: true });
        await mkdir(path.dirname(target), { recursive: true });
        // The media is staged before the lock so a slow copy cannot hold it, but a
        // content-addressed file that is already stored is kept: rename() replaces its
        // destination, so renaming over it would rewrite stored bytes and fails
        // outright on Windows while that file is open elsewhere.
        if (!(await pathExists(target))) {
          const mediaTemporaryPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
          temporaryPath = mediaTemporaryPath;
          await copyFile(registration.storedPath, mediaTemporaryPath, constants.COPYFILE_EXCL);
          try {
            await rename(mediaTemporaryPath, target);
            temporaryPath = undefined;
          } catch (error) {
            // The rename failed, so the media is only staged when another writer put the
            // same content-addressed file there first; keep the file that is there.
            const staged = await pathExists(target).catch(() => false);
            if (!staged) throw error;
            await unlink(mediaTemporaryPath).catch(() => undefined);
            temporaryPath = undefined;
          }
        }
        locked = await acquireLock(
          lockPath,
          lockWaitMs,
          ownerToken,
          () => {
            locked = true;
          },
          options.writeOwnerToken ?? ((handle, token) => handle.writeFile(token)),
        );
        if (!locked) {
          result = { ok: false, error: BUSY_MESSAGE };
        } else {
          let catalog: Record<string, unknown> & { assets: unknown[] };
          let catalogExists = true;
          let previousCatalog: Buffer | undefined;
          try {
            previousCatalog = await readFile(catalogPath);
            const parsed: unknown = JSON.parse(previousCatalog.toString('utf8'));
            if (
              typeof parsed !== 'object' ||
              parsed === null ||
              Array.isArray(parsed) ||
              !Array.isArray((parsed as Record<string, unknown>).assets)
            ) {
              throw new Error('catalog.json does not contain an assets array');
            }
            catalog = parsed as Record<string, unknown> & { assets: unknown[] };
          } catch (error) {
            if (
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === 'ENOENT'
            ) {
              catalogExists = false;
              catalog = { version: 1, assets: [] };
            } else {
              throw error;
            }
          }

          if (
            catalog.assets.some(
              (entry) =>
                typeof entry === 'object' &&
                entry !== null &&
                (entry as Record<string, unknown>).id === id,
            )
          ) {
            result = { ok: true };
          } else {
            if (catalogExists && previousCatalog !== undefined) {
              try {
                await copyFile(catalogPath, backupPath, constants.COPYFILE_EXCL);
              } catch (error) {
                if (!isAlreadyExists(error)) throw error;
              }
            }
            const entry: LibraryEntry = {
              id,
              projectId: '',
              kind: registration.kind,
              sha256: registration.sha256,
              bytes: registration.bytes,
              descriptor: { mimeType: 'application/octet-stream', ...registration.descriptor },
              tags: [],
              createdAt: Date.now(),
              cloudBacked: false,
              relativePath,
              displayName: registration.displayName,
              sortName: registration.displayName.toLowerCase(),
            };
            const assets = [...catalog.assets, entry];
            const counts = {
              total: assets.length,
              audio: assets.filter(
                (item) =>
                  typeof item === 'object' &&
                  item !== null &&
                  (item as Record<string, unknown>).kind === 'audio',
              ).length,
              image: assets.filter(
                (item) =>
                  typeof item === 'object' &&
                  item !== null &&
                  (item as Record<string, unknown>).kind === 'image',
              ).length,
              video: assets.filter(
                (item) =>
                  typeof item === 'object' &&
                  item !== null &&
                  (item as Record<string, unknown>).kind === 'video',
              ).length,
            };
            const updatedCatalog = { ...catalog, counts, assets };
            temporaryPath = `${catalogPath}.${process.pid}.${randomUUID()}.tmp`;
            await writeFile(temporaryPath, JSON.stringify(updatedCatalog, null, 2));
            await rename(temporaryPath, catalogPath);
            temporaryPath = undefined;
            catalogWritten = true;
            result = { ok: true };
          }
        }
      } catch (error) {
        operationError = errorMessage(error);
      } finally {
        if (temporaryPath !== undefined) await unlink(temporaryPath).catch(() => undefined);
        if (locked && lockPath !== undefined && ownerToken !== undefined) {
          try {
            const lockContent = await readFile(lockPath, 'utf8');
            // A replacement lock may be empty or partial; only a full token proves ownership, so failed writes wait for 60-second stale cleanup.
            if (lockContent === ownerToken) await unlink(lockPath);
          } catch (error) {
            if (!isNotFound(error)) cleanupError = errorMessage(error);
          }
        }
      }
      if (operationError !== undefined || (cleanupError !== undefined && !catalogWritten)) {
        const message = [operationError, cleanupError && `Lock cleanup failed: ${cleanupError}`]
          .filter((part): part is string => part !== undefined)
          .join('; ');
        return { ok: false, error: `The asset library could not be updated: ${message}` };
      }
      // A written catalog is usable; its leftover lock expires after 60 seconds.
      return (
        result ?? { ok: false, error: `The asset library could not be updated: ${BUSY_MESSAGE}` }
      );
    },
  };
}
