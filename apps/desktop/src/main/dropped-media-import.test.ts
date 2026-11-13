import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createFileRegistry } from './file-registry.js';
import {
  createDroppedMediaImportService,
  sameCanonicalRealPath,
  type DroppedMediaImportService,
} from './dropped-media-import.js';
import type { LocalOriginalWriter } from './local-originals.js';
import type { LocalAssetRegistration } from '../store/local-assets.js';

interface FakeFileInfo {
  readonly kind: 'file' | 'directory';
  readonly bytes?: Uint8Array;
  mtimeNs?: bigint;
  ctimeNs?: bigint;
}

interface TestFileSystem {
  readonly open: (filePath: string, flags: 'r') => Promise<FileHandle>;
  readonly stat: (filePath: string) => Promise<BigIntStats>;
  readonly realpathNative: (filePath: string) => Promise<string>;
}

function makeHarness(
  options: {
    readonly onProgress?: (ticketId: string, stage: string) => void;
    readonly onFinished?: (assetId: string) => void;
    readonly libraryError?: string;
    readonly fileSystem?: TestFileSystem;
    readonly afterOpen?: (filePath: string, files: Map<string, FakeFileInfo>) => void;
    readonly afterStream?: (file: FakeFileInfo, streamNumber: number) => void;
    readonly duringStream?: (file: FakeFileInfo, streamNumber: number) => void;
    readonly sourceBytesForStream?: (
      file: FakeFileInfo,
      streamNumber: number,
    ) => Uint8Array | undefined;
    readonly zeroInode?: boolean;
  } = {},
) {
  const files = new Map<string, FakeFileInfo>();
  const assets = new Map<string, LocalAssetRegistration & { readonly storedPath?: string }>();
  const partial = new Map<string, Uint8Array>();
  const readPaths: string[] = [];
  const readHandles: FileHandle[] = [];
  const openedPaths: string[] = [];
  const pathByHandle = new WeakMap<object, string>();
  const fileByHandle = new WeakMap<object, FakeFileInfo>();
  const inodeByFile = new WeakMap<FakeFileInfo, bigint>();
  let nextInode = 1n;
  let streamNumber = 0;
  const getInode = (file: FakeFileInfo | undefined): bigint => {
    if (file === undefined) return 0n;
    let inode = inodeByFile.get(file);
    if (inode === undefined) {
      inode = nextInode++;
      inodeByFile.set(file, inode);
    }
    return inode;
  };
  const makeStats = (file: FakeFileInfo | undefined): BigIntStats =>
    ({
      dev: 1n,
      ino: options.zeroInode ? 0n : getInode(file),
      size: BigInt(file?.bytes?.byteLength ?? 0),
      mtimeNs: file?.mtimeNs ?? 1n,
      ctimeNs: file?.ctimeNs ?? 1n,
      isFile: () => file?.kind === 'file',
    }) as unknown as BigIntStats;
  const storedAssetIds: string[] = [];
  const storedAssetBytes = new Map<string, Uint8Array>();
  const abortedAssetIds: string[] = [];
  const libraryAddedAssetIds: string[] = [];
  let ticketSequence = 0;
  const ticketRegistry = createFileRegistry(() => `ticket-${++ticketSequence}`);
  const fileSystem = options.fileSystem ?? {
    open: async (filePath: string, _flags: 'r') => {
      openedPaths.push(filePath);
      const found = files.get(filePath);
      if (found === undefined) throw new Error('test file does not exist');
      const handle = {
        stat: async () => makeStats(found),
        close: vi.fn(async () => undefined),
      } as unknown as FileHandle;
      pathByHandle.set(handle as object, filePath);
      fileByHandle.set(handle as object, found);
      options.afterOpen?.(filePath, files);
      return handle;
    },
    stat: async (filePath: string) => makeStats(files.get(filePath)),
    realpathNative: async (filePath: string) => filePath,
  };
  const originals: LocalOriginalWriter = {
    storeOriginal: vi.fn(async (_assetId: string, _bytes: Uint8Array) => ({
      ok: false,
      error: 'unused',
    })),
    beginOriginalUpload: vi.fn(async (uploadId: string, _expectedBytes: number) => {
      partial.set(uploadId, new Uint8Array());
      return { ok: true as const };
    }),
    appendOriginalChunk: vi.fn(async (assetId: string, offset: number, bytes: Uint8Array) => {
      if (offset === 0) partial.set(assetId, new Uint8Array());
      const current = partial.get(assetId) ?? new Uint8Array();
      const next = new Uint8Array(current.byteLength + bytes.byteLength);
      next.set(current);
      next.set(bytes, current.byteLength);
      partial.set(assetId, next);
      return { ok: true as const };
    }),
    finishOriginalUpload: vi.fn(async (uploadId: string, assetId = uploadId) => {
      const bytes = partial.get(uploadId);
      partial.delete(uploadId);
      const asset = assets.get(assetId);
      if (
        bytes === undefined ||
        asset === undefined ||
        bytes.byteLength !== asset.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== asset.sha256
      ) {
        return { ok: false as const, error: 'Original does not match its registered checksum' };
      }
      assets.set(assetId, { ...asset, storedPath: `stored:${assetId}` });
      storedAssetIds.push(assetId);
      storedAssetBytes.set(assetId, bytes);
      options.onFinished?.(assetId);
      return { ok: true as const };
    }),
    commitOriginalUpload: vi.fn(() => undefined),
    abortOriginalUpload: vi.fn(async (assetId: string) => {
      partial.delete(assetId);
      abortedAssetIds.push(assetId);
    }),
    abortAllOriginalUploads: vi.fn(async () => undefined),
  };
  const service: DroppedMediaImportService = createDroppedMediaImportService({
    fileRegistry: ticketRegistry,
    assets: {
      get: (id) => assets.get(id),
      remove: (id) => {
        assets.delete(id);
      },
      register: (asset) => {
        const current = assets.get(asset.id);
        if (
          current !== undefined &&
          (current.sha256 !== asset.sha256 || current.bytes !== asset.bytes)
        ) {
          return { kind: 'conflict' };
        }
        assets.set(asset.id, current ?? asset);
        return { kind: 'registered' };
      },
    },
    resolveDroppedPath: async (path: string) => {
      if (
        !/^[A-Za-z]:[\\/]/.test(path) ||
        path
          .replaceAll('/', '\\')
          .split('\\')
          .some((segment) => /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment))
      ) {
        throw new Error('Dropped path is not a supported local path');
      }
      const found = files.get(path);
      if (found === undefined) throw new Error('Dropped path does not exist');
      return {
        path,
        kind: found.kind,
        size: found.bytes?.byteLength ?? 0,
      };
    },
    originals,
    fileSystem,
    library: {
      addAsset: async (assetId: string) => {
        libraryAddedAssetIds.push(assetId);
        return options.libraryError === undefined
          ? { ok: true as const }
          : { ok: false as const, error: options.libraryError };
      },
      removeEntry: async () => ({ removed: true }),
    },
    readDirectory: async (path) => {
      const prefix = path.endsWith('\\') ? path : `${path}\\`;
      return [...files.keys()]
        .filter((candidate) => candidate.startsWith(prefix))
        .map((candidate) => candidate.slice(prefix.length))
        .filter((name) => !name.includes('\\'))
        .map((name) => ({
          name,
          isFile: files.get(prefix + name)?.kind === 'file',
          isDirectory: files.get(prefix + name)?.kind === 'directory',
        }));
    },
    readChunks: async function* (handle) {
      readHandles.push(handle);
      const currentStream = ++streamNumber;
      const sourcePath = pathByHandle.get(handle as object);
      const file = fileByHandle.get(handle as object);
      if (sourcePath === undefined || file === undefined)
        throw new Error('test file handle is not registered');
      readPaths.push(sourcePath);
      const bytes =
        options.sourceBytesForStream?.(file, currentStream) ?? file.bytes ?? new Uint8Array();
      const midpoint = Math.max(1, Math.floor(bytes.byteLength / 2));
      yield bytes.subarray(0, midpoint);
      options.duringStream?.(file, currentStream);
      yield bytes.subarray(midpoint);
      options.afterStream?.(file, currentStream);
    },
    fileExists: async (path) => [...assets.values()].some((asset) => asset.storedPath === path),
    onProgress: (event) => options.onProgress?.(event.ticketId, event.stage),
  });
  return {
    files,
    assets,
    partial,
    readPaths,
    readHandles,
    openedPaths,
    storedAssetIds,
    storedAssetBytes,
    abortedAssetIds,
    libraryAddedAssetIds,
    originals,
    service,
  };
}

describe('dropped media import', () => {
  it('mints opaque tickets and reports unsupported files in one plain skip message', async () => {
    const harness = makeHarness();
    harness.files.set('C:\\drop\\clip.mp4', { kind: 'file', bytes: new Uint8Array([1]) });
    harness.files.set('C:\\drop\\notes.docx', { kind: 'file', bytes: new Uint8Array([2]) });
    harness.files.set('C:\\drop\\data.zip', { kind: 'file', bytes: new Uint8Array([3]) });

    const result = await harness.service.prepareDroppedPaths([
      { path: 'C:\\drop\\clip.mp4', name: 'clip.mp4' },
      { path: 'C:\\drop\\notes.docx', name: 'notes.docx' },
      { path: 'C:\\drop\\data.zip', name: 'data.zip' },
    ]);

    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0]).toMatchObject({ displayName: 'clip.mp4', mediaKind: 'video' });
    expect(result.skippedMessage).toBe('2 files were skipped: notes.docx, data.zip');
    expect(JSON.stringify(result)).not.toContain('C:\\drop');
  });

  it('does not import a ticket id that the main process did not mint', async () => {
    const harness = makeHarness();

    const result = await harness.service.importTicket('renderer-forged-ticket');

    expect(result).toEqual({ ok: false, error: 'Dropped media ticket is invalid' });
    expect(harness.originals.appendOriginalChunk).not.toHaveBeenCalled();
  });

  it('rejects UNC, device, and reserved-name paths before stat or read', async () => {
    const harness = makeHarness();
    const batch = await harness.service.prepareDroppedPaths([
      { path: '\\\\server\\share\\clip.mp4', name: 'clip.mp4' },
      { path: '\\\\.\\C:\\clip.mp4', name: 'clip.mp4' },
      { path: 'C:\\drop\\NUL.mp4', name: 'NUL.mp4' },
    ]);

    expect(batch.tickets).toEqual([]);
    expect(harness.readPaths).toEqual([]);
  });

  it('expires unused tickets after two minutes', async () => {
    const harness = makeHarness();
    harness.files.set('C:\\drop\\clip.mp4', { kind: 'file', bytes: new Uint8Array([1, 2]) });
    vi.useFakeTimers();
    try {
      const batch = await harness.service.prepareDroppedPaths([
        { path: 'C:\\drop\\clip.mp4', name: 'clip.mp4' },
      ]);
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(harness.service.importTicket(batch.tickets[0]!.id)).resolves.toEqual({
        ok: false,
        error: 'Dropped media ticket is invalid',
      });
      expect(harness.readPaths).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('revokes every ticket when a prepared batch is abandoned', async () => {
    const harness = makeHarness();
    harness.files.set('C:\\drop\\first.mp4', { kind: 'file', bytes: new Uint8Array([1]) });
    harness.files.set('C:\\drop\\second.mp4', { kind: 'file', bytes: new Uint8Array([2]) });
    const batch = await harness.service.prepareDroppedPaths([
      { path: 'C:\\drop\\first.mp4', name: 'first.mp4' },
      { path: 'C:\\drop\\second.mp4', name: 'second.mp4' },
    ]);
    const revokeTickets = (
      harness.service as unknown as { revokeTickets?: (ticketIds: readonly string[]) => void }
    ).revokeTickets;

    expect(typeof revokeTickets).toBe('function');
    revokeTickets?.call(
      harness.service,
      batch.tickets.map((ticket) => ticket.id),
    );

    for (const ticket of batch.tickets) {
      await expect(harness.service.importTicket(ticket.id)).resolves.toEqual({
        ok: false,
        error: 'Dropped media ticket is invalid',
      });
    }
    expect(harness.readPaths).toEqual([]);
  });

  it('walks a dropped folder one level and ignores nested folders', async () => {
    const harness = makeHarness();
    harness.files.set('C:\\drop\\folder', { kind: 'directory' });
    harness.files.set('C:\\drop\\folder\\clip.mp4', { kind: 'file', bytes: new Uint8Array([1]) });
    harness.files.set('C:\\drop\\folder\\nested', { kind: 'directory' });
    harness.files.set('C:\\drop\\folder\\nested\\hidden.mp4', {
      kind: 'file',
      bytes: new Uint8Array([2]),
    });

    const result = await harness.service.prepareDroppedPaths([
      { path: 'C:\\drop\\folder', name: 'folder' },
    ]);

    expect(result.tickets.map((ticket) => ticket.displayName)).toEqual(['clip.mp4']);
    expect(result.folderDepth).toBe(1);
  });

  it('uses the existing asset when a second import has the same hash', async () => {
    const harness = makeHarness();
    const bytes = new TextEncoder().encode('same media bytes');
    harness.files.set('C:\\drop\\first.mp4', { kind: 'file', bytes });
    harness.files.set('C:\\drop\\copy.mp4', { kind: 'file', bytes });
    const first = await harness.service.prepareDroppedPaths([
      { path: 'C:\\drop\\first.mp4', name: 'first.mp4' },
    ]);
    const second = await harness.service.prepareDroppedPaths([
      { path: 'C:\\drop\\copy.mp4', name: 'copy.mp4' },
    ]);

    const imported = await harness.service.importTicket(first.tickets[0]!.id);
    const duplicate = await harness.service.importTicket(second.tickets[0]!.id);

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(imported).toMatchObject({ ok: true, data: { id: `joylib-${sha256}` } });
    expect(duplicate).toMatchObject({
      ok: true,
      data: { id: `joylib-${sha256}`, deduplicated: true },
    });
    expect(JSON.stringify(imported)).not.toContain('C:\\drop');
    expect(JSON.stringify(imported)).not.toContain('path');
    expect(harness.storedAssetIds).toEqual([`joylib-${sha256}`]);
  });

  it('stores exactly the bytes hashed from one source stream', async () => {
    const path = 'C:\\drop\\clip.mp4';
    const bytes = new TextEncoder().encode('first stream bytes');
    const secondReadBytes = new TextEncoder().encode('different second read');
    const harness = makeHarness({
      sourceBytesForStream: (_file, streamNumber) =>
        streamNumber === 1 ? bytes : secondReadBytes,
    });
    harness.files.set(path, { kind: 'file', bytes });
    const batch = await harness.service.prepareDroppedPaths([{ path, name: 'clip.mp4' }]);

    const result = await harness.service.importTicket(batch.tickets[0]!.id);

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(result).toMatchObject({ ok: true, data: { id: `joylib-${sha256}`, sha256 } });
    expect(harness.readPaths).toEqual([path]);
    expect(harness.storedAssetBytes.get(`joylib-${sha256}`)).toEqual(bytes);
  });

  it('imports a zero-inode file using one hashed staging stream', async () => {
    const path = 'C:\\drop\\clip.mp4';
    const bytes = new TextEncoder().encode('zero inode media');
    const harness = makeHarness({ zeroInode: true });
    harness.files.set(path, { kind: 'file', bytes });
    const batch = await harness.service.prepareDroppedPaths([{ path, name: 'clip.mp4' }]);

    const result = await harness.service.importTicket(batch.tickets[0]!.id);

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(result).toMatchObject({ ok: true, data: { id: `joylib-${sha256}`, sha256 } });
    expect(harness.readPaths).toEqual([path]);
    expect(harness.storedAssetBytes.get(`joylib-${sha256}`)).toEqual(bytes);
  });

  it('detects a zero-inode source change during streaming and removes the staged bytes', async () => {
    const path = 'C:\\drop\\clip.mp4';
    const harness = makeHarness({
      zeroInode: true,
      duringStream: (file, streamNumber) => {
        if (streamNumber === 1) {
          file.bytes?.set([1, 2, 99, 4]);
          file.ctimeNs = 2n;
        }
      },
    });
    harness.files.set(path, { kind: 'file', bytes: new Uint8Array([1, 2, 3, 4]) });
    const batch = await harness.service.prepareDroppedPaths([{ path, name: 'clip.mp4' }]);

    const result = await harness.service.importTicket(batch.tickets[0]!.id);

    expect(result).toEqual({ ok: false, error: 'The selected media file changed during import' });
    expect(harness.readPaths).toEqual([path]);
    expect(harness.originals.appendOriginalChunk).toHaveBeenCalled();
    expect(harness.partial.size).toBe(0);
    expect(harness.abortedAssetIds).toHaveLength(1);
    expect(harness.storedAssetIds).toEqual([]);
  });

  it('serializes concurrent imports with the same hash into one stored asset', async () => {
    const harness = makeHarness();
    const bytes = new TextEncoder().encode('same concurrent media bytes');
    harness.files.set('C:\\drop\\first.mp4', { kind: 'file', bytes });
    harness.files.set('C:\\drop\\copy.mp4', { kind: 'file', bytes });
    const first = await harness.service.prepareDroppedPaths([
      { path: 'C:\\drop\\first.mp4', name: 'first.mp4' },
    ]);
    const second = await harness.service.prepareDroppedPaths([
      { path: 'C:\\drop\\copy.mp4', name: 'copy.mp4' },
    ]);

    const results = await Promise.all([
      harness.service.importTicket(first.tickets[0]!.id),
      harness.service.importTicket(second.tickets[0]!.id),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(results.filter((result) => result.ok && result.data.deduplicated)).toHaveLength(1);
    expect(harness.storedAssetIds).toHaveLength(1);
  });

  it('does not return filesystem paths from an asset-library failure', async () => {
    const harness = makeHarness({ libraryError: 'EACCES: C:\\private\\media-root\\catalog.json' });
    harness.files.set('C:\\drop\\clip.mp4', { kind: 'file', bytes: new Uint8Array([1, 2]) });
    const batch = await harness.service.prepareDroppedPaths([
      { path: 'C:\\drop\\clip.mp4', name: 'clip.mp4' },
    ]);

    const result = await harness.service.importTicket(batch.tickets[0]!.id);

    expect(result).toEqual({ ok: false, error: 'The asset library could not be updated' });
    expect(JSON.stringify(result)).not.toContain('C:\\private');
  });

  it('refuses a same-size target replacement after opening the file handle', async () => {
    const path = 'C:\\drop\\clip.mp4';
    const harness = makeHarness({
      afterOpen: (openedPath, files) => {
        expect(openedPath).toBe(path);
        files.set(path, { kind: 'file', bytes: new Uint8Array([4, 5, 6]) });
      },
    });
    harness.files.set(path, { kind: 'file', bytes: new Uint8Array([1, 2, 3]) });
    const batch = await harness.service.prepareDroppedPaths([{ path, name: 'clip.mp4' }]);

    const result = await harness.service.importTicket(batch.tickets[0]!.id);

    expect(result).toEqual({ ok: false, error: 'The selected media file changed during import' });
    expect(harness.readHandles).toHaveLength(1);
    expect(harness.originals.appendOriginalChunk).not.toHaveBeenCalled();
  });

  it('aborts the staged copy when the opened file changes during streaming', async () => {
    const harness = makeHarness({
      duringStream: (file, streamIndex) => {
        if (streamIndex === 1) file.mtimeNs = 2n;
      },
    });
    harness.files.set('C:\\drop\\clip.mp4', {
      kind: 'file',
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    const batch = await harness.service.prepareDroppedPaths([
      { path: 'C:\\drop\\clip.mp4', name: 'clip.mp4' },
    ]);

    const result = await harness.service.importTicket(batch.tickets[0]!.id);

    expect(result).toEqual({ ok: false, error: 'The selected media file changed during import' });
    expect(harness.readPaths).toHaveLength(1);
    expect(harness.originals.appendOriginalChunk).toHaveBeenCalled();
    expect(harness.abortedAssetIds).toHaveLength(1);
    expect(harness.storedAssetIds).toEqual([]);
    expect(harness.assets.size).toBe(0);
  });

  it('accepts a Windows short-name alias only when native canonicalization resolves to the same real path', async () => {
    const shortPath = 'C:\\MEDIA~1\\clip.mp4';
    const realPath = 'C:\\Media Folder\\clip.mp4';
    const otherPath = 'C:\\Other Folder\\clip.mp4';
    const canonicalize = async (filePath: string) => (filePath === shortPath ? realPath : filePath);
    await expect(sameCanonicalRealPath(shortPath, realPath, canonicalize)).resolves.toBe(true);
    await expect(sameCanonicalRealPath(shortPath, otherPath, canonicalize)).resolves.toBe(false);
  });

  it('cancels an in-progress stream and removes its partial original', async () => {
    const serviceRef: { current?: DroppedMediaImportService } = {};
    const harness = makeHarness({
      onProgress: (ticketId, stage) => {
        if (stage === 'store' && serviceRef.current !== undefined)
          void serviceRef.current.cancel(ticketId);
      },
    });
    const service = harness.service;
    serviceRef.current = service;
    harness.files.set('C:\\drop\\clip.mp4', {
      kind: 'file',
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    const batch = await service.prepareDroppedPaths([
      { path: 'C:\\drop\\clip.mp4', name: 'clip.mp4' },
    ]);

    const result = await service.importTicket(batch.tickets[0]!.id);

    expect(result).toEqual({ ok: false, error: 'Import cancelled' });
    expect(harness.readPaths).toHaveLength(1);
    expect(harness.partial.size).toBe(0);
    expect(harness.abortedAssetIds).toHaveLength(1);
    expect(harness.storedAssetIds).toHaveLength(0);
    expect(harness.assets.size).toBe(0);
  });

  it('cancels after finishing the original but before writing the library catalogue', async () => {
    const serviceRef: { current?: DroppedMediaImportService } = {};
    const harness = makeHarness({
      onFinished: () => {
        void serviceRef.current?.cancel('ticket-1');
      },
    });
    serviceRef.current = harness.service;
    harness.files.set('C:\\drop\\clip.mp4', { kind: 'file', bytes: new Uint8Array([4, 5, 6]) });
    const batch = await harness.service.prepareDroppedPaths([
      { path: 'C:\\drop\\clip.mp4', name: 'clip.mp4' },
    ]);

    const result = await harness.service.importTicket(batch.tickets[0]!.id);

    expect(result).toEqual({ ok: false, error: 'Import cancelled' });
    expect(harness.libraryAddedAssetIds).toEqual([]);
    expect(harness.abortedAssetIds).toHaveLength(1);
    expect(harness.assets.size).toBe(0);
  });

  it('preserves Persian names and absolute paths longer than MAX_PATH', async () => {
    const harness = makeHarness();
    const directory = new Array(15).fill('long-directory-segment').join('\\');
    const path = `C:\\${directory}\\موسیقی.mp3`;
    expect(path.length).toBeGreaterThan(260);
    harness.files.set(path, { kind: 'file', bytes: new Uint8Array([8, 9]) });
    const batch = await harness.service.prepareDroppedPaths([{ path, name: 'موسیقی.mp3' }]);

    const result = await harness.service.importTicket(batch.tickets[0]!.id);

    expect(batch.tickets[0]).toMatchObject({ displayName: 'موسیقی.mp3', mediaKind: 'audio' });
    expect(result.ok).toBe(true);
    expect(harness.readPaths).toContain(path);
    expect(harness.openedPaths).toEqual([path]);
    expect(harness.readHandles).toHaveLength(1);
  });
});
