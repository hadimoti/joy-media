import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFileRegistry } from './file-registry.js';
import {
  createDroppedMediaImportService,
  type DroppedMediaImportService,
} from './dropped-media-import.js';
import type { LocalOriginalWriter } from './local-originals.js';
import type { LocalAssetRegistration } from '../store/local-assets.js';

interface FakeFileInfo {
  readonly kind: 'file' | 'directory';
  readonly bytes?: Uint8Array;
}

function makeHarness(
  options: {
    readonly onProgress?: (ticketId: string, stage: string) => void;
    readonly libraryError?: string;
  } = {},
) {
  const files = new Map<string, FakeFileInfo>();
  const assets = new Map<string, LocalAssetRegistration & { readonly storedPath?: string }>();
  const partial = new Map<string, Uint8Array>();
  const readPaths: string[] = [];
  const storedAssetIds: string[] = [];
  const abortedAssetIds: string[] = [];
  let ticketSequence = 0;
  const ticketRegistry = createFileRegistry(() => `ticket-${++ticketSequence}`);
  const originals: LocalOriginalWriter = {
    storeOriginal: vi.fn(async (_assetId: string, _bytes: Uint8Array) => ({
      ok: false,
      error: 'unused',
    })),
    appendOriginalChunk: vi.fn(async (assetId: string, offset: number, bytes: Uint8Array) => {
      if (offset === 0) partial.set(assetId, new Uint8Array());
      const current = partial.get(assetId) ?? new Uint8Array();
      const next = new Uint8Array(current.byteLength + bytes.byteLength);
      next.set(current);
      next.set(bytes, current.byteLength);
      partial.set(assetId, next);
      return { ok: true as const };
    }),
    finishOriginalUpload: vi.fn(async (assetId: string) => {
      partial.delete(assetId);
      const asset = assets.get(assetId);
      if (asset !== undefined) assets.set(assetId, { ...asset, storedPath: `stored:${assetId}` });
      storedAssetIds.push(assetId);
      return { ok: true as const };
    }),
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
    originals,
    library: {
      addAsset: async () =>
        options.libraryError === undefined
          ? { ok: true as const }
          : { ok: false as const, error: options.libraryError },
      removeEntry: async () => ({ removed: true }),
    },
    statPath: async (path) => {
      const found = files.get(path);
      return found?.kind === 'directory'
        ? { isFile: false, isDirectory: true, size: 0 }
        : {
            isFile: found?.kind === 'file',
            isDirectory: false,
            size: found?.bytes?.byteLength ?? 0,
          };
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
    readChunks: async function* (path) {
      readPaths.push(path);
      const bytes = files.get(path)?.bytes ?? new Uint8Array();
      const midpoint = Math.max(1, Math.floor(bytes.byteLength / 2));
      yield bytes.subarray(0, midpoint);
      yield bytes.subarray(midpoint);
    },
    fileExists: async (path) => [...assets.values()].some((asset) => asset.storedPath === path),
    onProgress: (event) => options.onProgress?.(event.ticketId, event.stage),
  });
  return { files, assets, partial, readPaths, storedAssetIds, abortedAssetIds, originals, service };
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
    expect(harness.partial.size).toBe(0);
    expect(harness.abortedAssetIds).toHaveLength(1);
    expect(harness.storedAssetIds).toHaveLength(0);
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
  });
});
