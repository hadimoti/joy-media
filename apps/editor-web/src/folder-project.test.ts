import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EditorSession } from './editor-session.js';
import { getCatalogProject } from './project-catalog.js';
import { readProjectBundle } from './project-lifecycle.js';
import type {
  ProjectFolderLoadReply,
  ProjectFolderMediaBytesReply,
  ProjectFolderMediaStatesReply,
  ProjectFolderSaveReply,
  ProjectFolderSaveRequest,
} from './project-folder-client.js';
import {
  isFolderProjectUnsaved,
  markFolderProjectUnsaved,
  openFolderProject,
  saveFolderProject,
  type FolderMediaCache,
  type FolderProjectPort,
} from './folder-project.js';

const CLIP = new TextEncoder().encode('beach video bytes '.repeat(50));
const CLIP_SHA = createHash('sha256').update(CLIP).digest('hex');
const CLIP_ID = `joylib-${CLIP_SHA}`;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

function memoryCache(): FolderMediaCache & { readonly blobs: Map<string, Blob> } {
  const blobs = new Map<string, Blob>();
  return {
    blobs,
    get: async (assetId) => blobs.get(assetId),
    put: async (descriptor, file) => {
      const hash = createHash('sha256')
        .update(new Uint8Array(await file.arrayBuffer()))
        .digest('hex');
      if (hash !== descriptor.sha256) throw new Error('checksum');
      blobs.set(descriptor.assetId, file);
    },
  };
}

/**
 * A folder the way the desktop keeps it: one saved document, media by id, and the desktop's own stored originals that a
 * save copies in. `chunk` is small, so the media is read in several pieces.
 */
function fakeFolder(id = 'project-1', title = 'Summer') {
  const state = {
    id,
    title,
    document: null as unknown,
    revisionId: '',
    documentProjectId: id,
    media: new Map<string, { bytes: Uint8Array; sha256: string; displayName: string }>(),
    originals: new Map<string, Uint8Array>(),
    saves: [] as ProjectFolderSaveRequest[],
    chunk: 256,
  };
  const port: FolderProjectPort = {
    load: async (): Promise<ProjectFolderLoadReply> => ({
      kind: 'loaded',
      id: state.id,
      title: state.title,
      document: state.document === null ? null : structuredClone(state.document),
      revisionId: state.revisionId,
      documentProjectId: state.documentProjectId,
    }),
    save: async (_key, save): Promise<ProjectFolderSaveReply> => {
      state.saves.push(save);
      if (save.projectId !== state.id) return { kind: 'refused', code: 'wrong-project' };
      if (save.baseRevisionId !== state.revisionId)
        return { kind: 'refused', code: 'save-conflict' };
      const notStored: string[] = [];
      for (const media of save.media) {
        if (state.media.has(media.assetId)) continue;
        const original = state.originals.get(media.assetId);
        if (original === undefined) {
          notStored.push(media.assetId);
          continue;
        }
        state.media.set(media.assetId, {
          bytes: original,
          sha256: media.sha256 ?? '',
          displayName: media.displayName,
        });
      }
      state.document = structuredClone(save.document);
      state.revisionId = save.revisionId;
      state.documentProjectId = save.projectId;
      state.title = save.title;
      return { kind: 'saved', revisionId: save.revisionId, notStored };
    },
    mediaStates: async (_key, assetIds): Promise<ProjectFolderMediaStatesReply> => ({
      kind: 'media',
      states: assetIds.map((assetId) => {
        const media = state.media.get(assetId);
        return media === undefined
          ? { assetId, present: false }
          : {
              assetId,
              present: true,
              bytes: media.bytes.byteLength,
              sha256: media.sha256,
              displayName: media.displayName,
            };
      }),
    }),
    readMedia: async (_key, assetId, offset): Promise<ProjectFolderMediaBytesReply> => {
      const media = state.media.get(assetId);
      if (media === undefined) return { kind: 'refused', code: 'media-missing' };
      return {
        kind: 'media-bytes',
        assetId,
        offset,
        total: media.bytes.byteLength,
        bytes: media.bytes.slice(offset, offset + state.chunk),
      };
    },
  };
  return { state, port };
}

/** Adds a media file to the open project's working copy, as an import does. */
function addClip(storage: ReturnType<typeof memoryStorage>, id = 'project-1', name = 'beach.mp4') {
  const entry = getCatalogProject(storage, id);
  if (entry === undefined) throw new Error('no entry');
  const bundle = readProjectBundle(storage, entry);
  const session = new EditorSession(storage, bundle.timeline, bundle.visual);
  session.replaceVisualProject({
    ...session.visualProject,
    assets: {
      [CLIP_ID]: {
        id: CLIP_ID,
        kind: 'video',
        displayName: name,
        sha256: CLIP_SHA,
        bytes: CLIP.byteLength,
        descriptor: { mimeType: 'video/mp4' },
      },
    },
  });
}

const NOW = () => '2026-11-12T00:00:00.000Z';

describe('opening a folder project in the editor', () => {
  it('opens a folder that was never saved as a blank project with the folder id and title', async () => {
    const storage = memoryStorage();
    const { port } = fakeFolder();
    const opened = await openFolderProject({
      key: 'k',
      storage,
      port,
      cache: memoryCache(),
      now: NOW,
    });
    expect(opened).toMatchObject({
      kind: 'opened',
      entry: { id: 'project-1', title: 'Summer', timelineProjectId: 'project-1' },
      revisionId: '',
      needsSave: true,
      missingMedia: [],
    });
    expect(getCatalogProject(storage, 'project-1')?.title).toBe('Summer');
    expect(readProjectBundle(storage, getCatalogProject(storage, 'project-1')!).visual.id).toBe(
      'project-1',
    );
  });

  it('passes a refusal from the desktop through, and changes nothing', async () => {
    const storage = memoryStorage();
    const port: FolderProjectPort = {
      ...fakeFolder().port,
      load: async () => ({ kind: 'refused', code: 'not-open' }),
    };
    await expect(
      openFolderProject({ key: 'k', storage, port, cache: memoryCache() }),
    ).resolves.toEqual({ kind: 'refused', code: 'not-open' });
    expect(getCatalogProject(storage, 'project-1')).toBeUndefined();
  });

  it('saves, closes and reopens on another computer with the media kept inside the folder', async () => {
    const storage = memoryStorage();
    const cache = memoryCache();
    const folder = fakeFolder();
    folder.state.originals.set(CLIP_ID, CLIP);
    const opened = await openFolderProject({
      key: 'k',
      storage,
      port: folder.port,
      cache,
      now: NOW,
    });
    if (opened.kind !== 'opened') throw new Error('expected opened');
    addClip(storage);
    const saved = await saveFolderProject({
      key: 'k',
      storage,
      port: folder.port,
      entry: opened.entry,
      baseRevisionId: opened.revisionId,
      revisionId: 'r1',
    });
    expect(saved).toEqual({ kind: 'saved', revisionId: 'r1', notStored: [] });
    expect(folder.state.media.get(CLIP_ID)?.bytes).toEqual(CLIP);
    expect(folder.state.saves[0]?.media).toEqual([
      { assetId: CLIP_ID, kind: 'video', displayName: 'beach.mp4', sha256: CLIP_SHA },
    ]);

    // Another computer: a fresh browser and an empty media cache. The desktop's originals are not there either.
    folder.state.originals.clear();
    const elsewhere = memoryStorage();
    const freshCache = memoryCache();
    const again = await openFolderProject({
      key: 'k2',
      storage: elsewhere,
      port: folder.port,
      cache: freshCache,
      now: NOW,
    });
    expect(again).toMatchObject({
      kind: 'opened',
      revisionId: 'r1',
      needsSave: false,
      missingMedia: [],
    });
    const bundle = readProjectBundle(elsewhere, getCatalogProject(elsewhere, 'project-1')!);
    expect(Object.keys(bundle.visual.assets)).toEqual([CLIP_ID]);
    const blob = freshCache.blobs.get(CLIP_ID);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(CLIP);
    expect(blob?.type).toBe('video/mp4');
  });

  it('takes the folder over an older working copy in this browser', async () => {
    const storage = memoryStorage();
    const folder = fakeFolder();
    folder.state.originals.set(CLIP_ID, CLIP);
    const opened = await openFolderProject({
      key: 'k',
      storage,
      port: folder.port,
      cache: memoryCache(),
    });
    if (opened.kind !== 'opened') throw new Error('expected opened');
    addClip(storage);
    await saveFolderProject({
      key: 'k',
      storage,
      port: folder.port,
      entry: opened.entry,
      baseRevisionId: '',
      revisionId: 'r1',
    });
    // The working copy drifts without a mark (for example, it was restored from an old backup).
    addClip(storage, 'project-1', 'old name.mp4');
    const again = await openFolderProject({
      key: 'k',
      storage,
      port: folder.port,
      cache: memoryCache(),
    });
    expect(again).toMatchObject({ kind: 'opened', needsSave: false });
    const bundle = readProjectBundle(storage, getCatalogProject(storage, 'project-1')!);
    expect(bundle.visual.assets[CLIP_ID]?.displayName).toBe('beach.mp4');
  });

  it('keeps a working copy with unsaved changes, and asks for a save', async () => {
    const storage = memoryStorage();
    const folder = fakeFolder();
    folder.state.originals.set(CLIP_ID, CLIP);
    const opened = await openFolderProject({
      key: 'k',
      storage,
      port: folder.port,
      cache: memoryCache(),
    });
    if (opened.kind !== 'opened') throw new Error('expected opened');
    await saveFolderProject({
      key: 'k',
      storage,
      port: folder.port,
      entry: opened.entry,
      baseRevisionId: '',
      revisionId: 'r1',
    });
    addClip(storage, 'project-1', 'newer.mp4');
    markFolderProjectUnsaved(storage, 'project-1');
    const again = await openFolderProject({
      key: 'k',
      storage,
      port: folder.port,
      cache: memoryCache(),
    });
    expect(again).toMatchObject({ kind: 'opened', needsSave: true, revisionId: 'r1' });
    const bundle = readProjectBundle(storage, getCatalogProject(storage, 'project-1')!);
    expect(bundle.visual.assets[CLIP_ID]?.displayName).toBe('newer.mp4');
    expect(isFolderProjectUnsaved(storage, 'project-1')).toBe(true);
  });

  it('names the media that is in neither the folder nor this browser', async () => {
    const storage = memoryStorage();
    const folder = fakeFolder();
    const opened = await openFolderProject({
      key: 'k',
      storage,
      port: folder.port,
      cache: memoryCache(),
    });
    if (opened.kind !== 'opened') throw new Error('expected opened');
    addClip(storage);
    // No original on this desktop: the folder cannot get a copy.
    const saved = await saveFolderProject({
      key: 'k',
      storage,
      port: folder.port,
      entry: opened.entry,
      baseRevisionId: '',
      revisionId: 'r1',
    });
    expect(saved).toEqual({ kind: 'saved', revisionId: 'r1', notStored: ['beach.mp4'] });
    const again = await openFolderProject({
      key: 'k',
      storage: memoryStorage(),
      port: folder.port,
      cache: memoryCache(),
    });
    expect(again).toMatchObject({ kind: 'opened', missingMedia: ['beach.mp4'] });
  });

  it('does not call media missing when this browser still has it', async () => {
    const storage = memoryStorage();
    const cache = memoryCache();
    cache.blobs.set(CLIP_ID, new Blob([CLIP]));
    const folder = fakeFolder();
    const opened = await openFolderProject({ key: 'k', storage, port: folder.port, cache });
    if (opened.kind !== 'opened') throw new Error('expected opened');
    addClip(storage);
    await saveFolderProject({
      key: 'k',
      storage,
      port: folder.port,
      entry: opened.entry,
      baseRevisionId: '',
      revisionId: 'r1',
    });
    const again = await openFolderProject({ key: 'k', storage, port: folder.port, cache });
    expect(again).toMatchObject({ kind: 'opened', missingMedia: [] });
  });

  it('opens a copy that still names its old id under the new one', async () => {
    const source = memoryStorage();
    const folder = fakeFolder();
    folder.state.originals.set(CLIP_ID, CLIP);
    const opened = await openFolderProject({
      key: 'k',
      storage: source,
      port: folder.port,
      cache: memoryCache(),
    });
    if (opened.kind !== 'opened') throw new Error('expected opened');
    addClip(source);
    await saveFolderProject({
      key: 'k',
      storage: source,
      port: folder.port,
      entry: opened.entry,
      baseRevisionId: '',
      revisionId: 'r1',
    });

    // The copy got a new id; its saved row still names the old one.
    folder.state.id = 'project-2';
    folder.state.title = 'Summer copy';
    const storage = memoryStorage();
    const copy = await openFolderProject({
      key: 'k',
      storage,
      port: folder.port,
      cache: memoryCache(),
    });
    expect(copy).toMatchObject({
      kind: 'opened',
      entry: { id: 'project-2', title: 'Summer copy' },
    });
    const bundle = readProjectBundle(storage, getCatalogProject(storage, 'project-2')!);
    expect(bundle.timeline.id).toBe('project-2');
    expect(bundle.visual.id).toBe('project-2');
    expect(Object.keys(bundle.visual.assets)).toEqual([CLIP_ID]);
  });

  it('refuses a saved document it cannot read, and opens nothing', async () => {
    const storage = memoryStorage();
    const folder = fakeFolder();
    folder.state.document = { timeline: 'broken' };
    folder.state.revisionId = 'r1';
    await expect(
      openFolderProject({ key: 'k', storage, port: folder.port, cache: memoryCache() }),
    ).resolves.toEqual({ kind: 'unreadable' });
    expect(getCatalogProject(storage, 'project-1')).toBeUndefined();
  });
});
