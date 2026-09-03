import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, parse, resolve, sep } from 'node:path';
import {
  ControlPlaneError,
  type Actor,
  type ControlPlane,
  type MediaAssetRecord,
} from './control-plane.js';
import { tagAssetWithHermes } from './asset-hermes-tags.js';
import type { PrivateObjectStore } from './private-object-store.js';

export const ORIGINAL_UPLOAD_PART_BYTES = 4 * 1024 * 1024;
export const MAX_ORIGINAL_UPLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_LIMIT = 32;
const MANIFEST_NAME = 'manifest.json';
const SESSION_RE = /^upload-[a-f0-9]{48}$/;

export type ResumableOriginalUploadState = 'uploading' | 'committing' | 'failed' | 'complete';

export interface ResumableOriginalUploadStatus {
  readonly sessionId: string;
  readonly state: ResumableOriginalUploadState;
  readonly partSize: number;
  readonly partCount: number;
  readonly uploadedParts: readonly number[];
}

interface UploadManifest {
  readonly version: 1;
  readonly sessionId: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly partSize: number;
  readonly partCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly attempts: number;
  readonly state: ResumableOriginalUploadState;
}

export interface ResumableOriginalUploadOptions {
  readonly rootDirectory: string;
  readonly controlPlane: ControlPlane;
  readonly privateObjectStore: PrivateObjectStore;
  readonly now?: () => number;
  readonly staleAfterMs?: number;
  readonly cleanupLimit?: number;
}

/**
 * File-backed, restart-resumable staging for browser originals. No filesystem
 * path or provider error crosses the HTTP boundary; callers receive only the
 * opaque session id and stable state.
 */
export class ResumableOriginalUploadCoordinator {
  readonly #root: string;
  readonly #controlPlane: ControlPlane;
  readonly #privateObjectStore: PrivateObjectStore;
  readonly #now: () => number;
  readonly #staleAfterMs: number;
  readonly #cleanupLimit: number;
  readonly #mutationTails = new Map<string, Promise<void>>();
  readonly #commits = new Map<string, Promise<void>>();
  #lastCleanupAt = 0;
  #cleanupCursor = 0;

  constructor(options: ResumableOriginalUploadOptions) {
    const root = resolve(options.rootDirectory);
    if (root === parse(root).root) {
      throw new TypeError('upload staging directory must not be a filesystem root');
    }
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const cleanupLimit = options.cleanupLimit ?? DEFAULT_CLEANUP_LIMIT;
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 60_000) {
      throw new RangeError('upload staging retention must be at least one minute');
    }
    if (!Number.isSafeInteger(cleanupLimit) || cleanupLimit < 1 || cleanupLimit > 256) {
      throw new RangeError('upload staging cleanup limit is invalid');
    }
    this.#root = root;
    this.#controlPlane = options.controlPlane;
    this.#privateObjectStore = options.privateObjectStore;
    this.#now = options.now ?? Date.now;
    this.#staleAfterMs = staleAfterMs;
    this.#cleanupLimit = cleanupLimit;
  }

  async createOrResume(
    actor: Actor,
    projectId: string,
    asset: MediaAssetRecord,
  ): Promise<ResumableOriginalUploadStatus> {
    validateAsset(asset);
    const sessionId = sessionIdFor(actor.id, projectId, asset);
    await this.#prepareRoot();
    await this.#cleanupStale();
    return this.#mutate(sessionId, async () => {
      const existing = await this.#readManifest(sessionId, false);
      if (existing !== undefined) {
        assertManifestOwner(existing, actor, projectId, asset);
        if (asset.locations.some((location) => location.kind === 'private-object')) {
          const completed = { ...existing, state: 'complete' as const, updatedAt: this.#now() };
          await this.#writeManifest(completed);
          await this.#removeParts(completed);
          return this.#status(completed);
        }
        return this.#status(existing);
      }
      const now = this.#now();
      const manifest: UploadManifest = {
        version: 1,
        sessionId,
        ownerId: actor.id,
        projectId,
        assetId: asset.id,
        sha256: asset.sha256,
        bytes: asset.bytes,
        mimeType: asset.descriptor.mimeType,
        partSize: ORIGINAL_UPLOAD_PART_BYTES,
        partCount: Math.ceil(asset.bytes / ORIGINAL_UPLOAD_PART_BYTES),
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        state: asset.locations.some((location) => location.kind === 'private-object')
          ? 'complete'
          : 'uploading',
      };
      const sessionPath = this.#sessionPath(sessionId);
      await rm(sessionPath, { recursive: true, force: true });
      await mkdir(sessionPath, { recursive: false, mode: 0o700 });
      await this.#writeManifest(manifest);
      return this.#status(manifest);
    });
  }

  async putPart(
    actor: Actor,
    projectId: string,
    asset: MediaAssetRecord,
    sessionId: string,
    partIndex: number,
    declaredPartSha256: string,
    bytes: Uint8Array,
  ): Promise<ResumableOriginalUploadStatus> {
    validateSessionId(sessionId);
    return this.#mutate(sessionId, async () => {
      const manifest = await this.#requiredManifest(sessionId);
      assertManifestOwner(manifest, actor, projectId, asset);
      if (manifest.state !== 'uploading' && manifest.state !== 'failed') {
        throw new ControlPlaneError('UPLOAD_STATE_CONFLICT', 'upload is not accepting parts');
      }
      if (!Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex >= manifest.partCount) {
        throw new ControlPlaneError('REQUEST_INVALID', 'upload part index is invalid');
      }
      if (!/^[a-f0-9]{64}$/.test(declaredPartSha256)) {
        throw new ControlPlaneError('REQUEST_INVALID', 'upload part integrity header is invalid');
      }
      const expectedBytes = expectedPartBytes(manifest, partIndex);
      if (bytes.byteLength !== expectedBytes) {
        throw new ControlPlaneError('REQUEST_INVALID', 'upload part length is invalid');
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== declaredPartSha256) {
        throw new ControlPlaneError('REQUEST_INVALID', 'upload part integrity check failed');
      }
      const path = this.#partPath(manifest, partIndex);
      const existing = await readFileIfPresent(path);
      if (existing !== undefined) {
        const existingDigest = createHash('sha256').update(existing).digest('hex');
        if (existing.byteLength !== bytes.byteLength || existingDigest !== digest) {
          throw new ControlPlaneError('UPLOAD_PART_CONFLICT', 'upload part conflicts with retry');
        }
      } else {
        await atomicWrite(path, bytes);
      }
      const updated: UploadManifest = {
        ...manifest,
        state: 'uploading',
        updatedAt: this.#now(),
      };
      await this.#writeManifest(updated);
      return this.#status(updated);
    });
  }

  async finalize(
    actor: Actor,
    projectId: string,
    asset: MediaAssetRecord,
    sessionId: string,
  ): Promise<ResumableOriginalUploadStatus> {
    validateSessionId(sessionId);
    const status = await this.#mutate(sessionId, async () => {
      const manifest = await this.#requiredManifest(sessionId);
      assertManifestOwner(manifest, actor, projectId, asset);
      if (manifest.state === 'complete') return this.#status(manifest);
      await this.#assertAllParts(manifest);
      const updated: UploadManifest = {
        ...manifest,
        state: 'committing',
        attempts: manifest.attempts + 1,
        updatedAt: this.#now(),
      };
      await this.#writeManifest(updated);
      return this.#status(updated);
    });
    this.#startCommit(sessionId);
    return status;
  }

  async status(
    actor: Actor,
    projectId: string,
    asset: MediaAssetRecord,
    sessionId: string,
  ): Promise<ResumableOriginalUploadStatus> {
    validateSessionId(sessionId);
    const manifest = await this.#requiredManifest(sessionId);
    assertManifestOwner(manifest, actor, projectId, asset);
    if (manifest.state === 'committing') this.#startCommit(sessionId);
    return this.#status(manifest);
  }

  #startCommit(sessionId: string): void {
    if (this.#commits.has(sessionId)) return;
    const commit = this.#commit(sessionId)
      .catch(() => undefined)
      .finally(() => this.#commits.delete(sessionId));
    this.#commits.set(sessionId, commit);
    void commit;
  }

  async #commit(sessionId: string): Promise<void> {
    try {
      const manifest = await this.#requiredManifest(sessionId);
      if (manifest.state !== 'committing') return;
      const bytes = await this.#assemble(manifest);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== manifest.sha256 || bytes.byteLength !== manifest.bytes) {
        throw new Error('staged original integrity mismatch');
      }
      const actor: Actor = { id: manifest.ownerId };
      const assets = await this.#controlPlane.assetsForProject(actor, manifest.projectId);
      const asset = assets.find((candidate) => candidate.id === manifest.assetId);
      if (asset === undefined) throw new Error('registered asset is unavailable');
      assertManifestOwner(manifest, actor, manifest.projectId, asset);
      await this.#controlPlane.setAssetSync(actor, manifest.projectId, true);
      const ref = ownerScopedOriginalRef(actor.id, asset.sha256);
      await this.#privateObjectStore.put(
        { ref, sha256: asset.sha256, bytes: asset.bytes, mimeType: asset.descriptor.mimeType },
        bytes,
      );
      const tagged = await tagAssetWithHermes({
        kind: asset.kind,
        displayName: asset.displayName,
        mimeType: asset.descriptor.mimeType,
        bytes: asset.bytes,
        ...(asset.descriptor.width === undefined ? {} : { width: asset.descriptor.width }),
        ...(asset.descriptor.height === undefined ? {} : { height: asset.descriptor.height }),
        ...(asset.kind === 'image' && bytes.byteLength <= 8 * 1024 * 1024
          ? { imageBytes: bytes }
          : {}),
      });
      await this.#controlPlane.updateAssetMetadata(actor, manifest.projectId, asset.id, {
        tags: tagged.tags,
        sortName: tagged.sortName,
      });
      // Attach last so a private-object location is a durable completion marker:
      // a restart can safely finish only the manifest/part cleanup after this.
      await this.#controlPlane.attachCloudOriginal(actor, manifest.projectId, asset.id, {
        kind: 'private-object',
        ref,
      });
      await this.#mutate(sessionId, async () => {
        const latest = await this.#requiredManifest(sessionId);
        await this.#writeManifest({ ...latest, state: 'complete', updatedAt: this.#now() });
        await this.#removeParts(latest);
      });
    } catch {
      await this.#mutate(sessionId, async () => {
        const latest = await this.#readManifest(sessionId, false);
        if (latest !== undefined && latest.state !== 'complete') {
          await this.#writeManifest({ ...latest, state: 'failed', updatedAt: this.#now() });
        }
      });
    }
  }

  async #assemble(manifest: UploadManifest): Promise<Uint8Array> {
    await this.#assertAllParts(manifest);
    const output = new Uint8Array(manifest.bytes);
    let offset = 0;
    for (let index = 0; index < manifest.partCount; index += 1) {
      const part = await readFile(this.#partPath(manifest, index));
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }

  async #assertAllParts(manifest: UploadManifest): Promise<void> {
    const uploaded = await this.#uploadedParts(manifest);
    if (uploaded.length !== manifest.partCount) {
      throw new ControlPlaneError('UPLOAD_INCOMPLETE', 'upload parts are incomplete');
    }
  }

  async #status(manifest: UploadManifest): Promise<ResumableOriginalUploadStatus> {
    return {
      sessionId: manifest.sessionId,
      state: manifest.state,
      partSize: manifest.partSize,
      partCount: manifest.partCount,
      uploadedParts: await this.#uploadedParts(manifest),
    };
  }

  async #uploadedParts(manifest: UploadManifest): Promise<number[]> {
    const uploaded: number[] = [];
    for (let index = 0; index < manifest.partCount; index += 1) {
      try {
        const metadata = await stat(this.#partPath(manifest, index));
        if (metadata.isFile() && metadata.size === expectedPartBytes(manifest, index)) {
          uploaded.push(index);
        }
      } catch {
        // Missing or unreadable parts are omitted from the resumable bitmap.
      }
    }
    return uploaded;
  }

  async #removeParts(manifest: UploadManifest): Promise<void> {
    for (let index = 0; index < manifest.partCount; index += 1) {
      await rm(this.#partPath(manifest, index), { force: true });
    }
  }

  async #prepareRoot(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
  }

  async #cleanupStale(): Promise<void> {
    const now = this.#now();
    if (now - this.#lastCleanupAt < 60_000) return;
    this.#lastCleanupAt = now;
    const entries = (await readdir(this.#root, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && SESSION_RE.test(entry.name),
    );
    if (entries.length === 0) {
      this.#cleanupCursor = 0;
      return;
    }
    const start = this.#cleanupCursor % entries.length;
    const count = Math.min(this.#cleanupLimit, entries.length);
    this.#cleanupCursor = (start + count) % entries.length;
    for (let offset = 0; offset < count; offset += 1) {
      const sessionId = entries[(start + offset) % entries.length]!.name;
      if (this.#commits.has(sessionId)) continue;
      await this.#mutate(sessionId, async () => {
        if (this.#commits.has(sessionId)) return;
        const manifest = await this.#readManifest(sessionId, false);
        if (manifest === undefined || now - manifest.updatedAt > this.#staleAfterMs) {
          await this.#removeSession(sessionId);
        }
      });
    }
  }

  async #removeSession(sessionId: string): Promise<void> {
    const path = this.#sessionPath(sessionId);
    if (!path.startsWith(`${this.#root}${sep}`)) throw new Error('unsafe upload staging path');
    await rm(path, { recursive: true, force: true });
  }

  async #requiredManifest(sessionId: string): Promise<UploadManifest> {
    const manifest = await this.#readManifest(sessionId, false);
    if (manifest === undefined) throw new ControlPlaneError('UPLOAD_NOT_FOUND', 'upload not found');
    return manifest;
  }

  async #readManifest(
    sessionId: string,
    throwOnInvalid: boolean,
  ): Promise<UploadManifest | undefined> {
    validateSessionId(sessionId);
    try {
      const parsed: unknown = JSON.parse(
        await readFile(resolve(this.#sessionPath(sessionId), MANIFEST_NAME), 'utf8'),
      );
      if (!isManifest(parsed) || parsed.sessionId !== sessionId) {
        if (throwOnInvalid) throw new Error('invalid upload manifest');
        return undefined;
      }
      return parsed;
    } catch (error) {
      if (throwOnInvalid) throw error;
      return undefined;
    }
  }

  async #writeManifest(manifest: UploadManifest): Promise<void> {
    await atomicWrite(
      resolve(this.#sessionPath(manifest.sessionId), MANIFEST_NAME),
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
  }

  #sessionPath(sessionId: string): string {
    validateSessionId(sessionId);
    const path = resolve(this.#root, sessionId);
    if (!path.startsWith(`${this.#root}${sep}`) || basename(path) !== sessionId) {
      throw new Error('unsafe upload staging path');
    }
    return path;
  }

  #partPath(manifest: UploadManifest, partIndex: number): string {
    return resolve(
      this.#sessionPath(manifest.sessionId),
      `part-${String(partIndex).padStart(4, '0')}.bin`,
    );
  }

  async #mutate<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(() => gate);
    this.#mutationTails.set(sessionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#mutationTails.get(sessionId) === tail) this.#mutationTails.delete(sessionId);
    }
  }
}

function validateAsset(asset: MediaAssetRecord): void {
  if (asset.bytes < 1 || asset.bytes > MAX_ORIGINAL_UPLOAD_BYTES) {
    throw new ControlPlaneError('REQUEST_INVALID', 'original upload size is invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new ControlPlaneError('REQUEST_INVALID', 'registered asset integrity is invalid');
  }
  if (!new RegExp(`^${asset.kind}/[a-z0-9.+-]+$`).test(asset.descriptor.mimeType)) {
    throw new ControlPlaneError('REQUEST_INVALID', 'registered asset MIME type is invalid');
  }
}

function assertManifestOwner(
  manifest: UploadManifest,
  actor: Actor,
  projectId: string,
  asset: MediaAssetRecord,
): void {
  validateAsset(asset);
  if (
    manifest.ownerId !== actor.id ||
    manifest.projectId !== projectId ||
    manifest.assetId !== asset.id ||
    manifest.sha256 !== asset.sha256 ||
    manifest.bytes !== asset.bytes ||
    manifest.mimeType !== asset.descriptor.mimeType
  ) {
    throw new ControlPlaneError('UPLOAD_IDENTITY_MISMATCH', 'upload identity does not match asset');
  }
}

function sessionIdFor(ownerId: string, projectId: string, asset: MediaAssetRecord): string {
  const digest = createHash('sha256')
    .update(`${ownerId}\0${projectId}\0${asset.id}\0${asset.sha256}\0${asset.bytes}`)
    .digest('hex')
    .slice(0, 48);
  return `upload-${digest}`;
}

function ownerScopedOriginalRef(ownerId: string, sha256: string): string {
  const ownerDigest = createHash('sha256').update(ownerId).digest('hex').slice(0, 32);
  return `orig-${ownerDigest}-${sha256}`;
}

function expectedPartBytes(manifest: UploadManifest, partIndex: number): number {
  const offset = partIndex * manifest.partSize;
  return Math.min(manifest.partSize, manifest.bytes - offset);
}

function validateSessionId(sessionId: string): void {
  if (!SESSION_RE.test(sessionId)) {
    throw new ControlPlaneError('REQUEST_INVALID', 'upload session id is invalid');
  }
}

async function readFileIfPresent(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return undefined;
  }
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function isManifest(value: unknown): value is UploadManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return (
    manifest.version === 1 &&
    typeof manifest.sessionId === 'string' &&
    SESSION_RE.test(manifest.sessionId) &&
    typeof manifest.ownerId === 'string' &&
    typeof manifest.projectId === 'string' &&
    typeof manifest.assetId === 'string' &&
    typeof manifest.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(manifest.sha256) &&
    Number.isSafeInteger(manifest.bytes) &&
    (manifest.bytes as number) > 0 &&
    (manifest.bytes as number) <= MAX_ORIGINAL_UPLOAD_BYTES &&
    typeof manifest.mimeType === 'string' &&
    manifest.partSize === ORIGINAL_UPLOAD_PART_BYTES &&
    Number.isSafeInteger(manifest.partCount) &&
    manifest.partCount === Math.ceil((manifest.bytes as number) / ORIGINAL_UPLOAD_PART_BYTES) &&
    Number.isSafeInteger(manifest.createdAt) &&
    (manifest.createdAt as number) >= 0 &&
    Number.isSafeInteger(manifest.updatedAt) &&
    (manifest.updatedAt as number) >= (manifest.createdAt as number) &&
    Number.isSafeInteger(manifest.attempts) &&
    (manifest.attempts as number) >= 0 &&
    (manifest.state === 'uploading' ||
      manifest.state === 'committing' ||
      manifest.state === 'failed' ||
      manifest.state === 'complete')
  );
}
