import { describe, expect, it, vi } from 'vitest';
import { EditorSession } from './editor-session.js';
import { getCatalogProject } from './project-catalog.js';
import { readProjectBundle, renameLocalProject } from './project-lifecycle.js';
import {
  isFolderProjectUnsaved,
  openFolderProject,
  type FolderProjectPort,
} from './folder-project.js';
import { FolderProjectSync } from './folder-project-sync.js';
import type { ProjectFolderSaveRequest } from './project-folder-client.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

function fakePort(
  reply: (save: ProjectFolderSaveRequest) => unknown = (save) => ({
    kind: 'saved',
    revisionId: save.revisionId,
    notStored: [],
  }),
) {
  const saves: ProjectFolderSaveRequest[] = [];
  const port = {
    load: vi.fn(async () => ({
      kind: 'loaded' as const,
      id: 'project-1',
      title: 'Summer',
      document: null,
      revisionId: '',
      documentProjectId: 'project-1',
    })),
    save: vi.fn(async (_key: string, save: ProjectFolderSaveRequest) => {
      saves.push(save);
      return reply(save) as never;
    }),
    mediaStates: vi.fn(async () => ({ kind: 'media' as const, states: [] })),
    readMedia: vi.fn(async () => ({ kind: 'refused' as const, code: 'media-missing' })),
    close: vi.fn(async () => undefined),
  } satisfies FolderProjectPort & { close(key: string): Promise<void> };
  return { port, saves };
}

const cache = { get: async () => undefined, put: async () => undefined };

async function opened(storage: ReturnType<typeof memoryStorage>, port: FolderProjectPort) {
  const result = await openFolderProject({ key: 'k', storage, port, cache });
  if (result.kind !== 'opened') throw new Error('expected opened');
  return result;
}

function edit(storage: ReturnType<typeof memoryStorage>, name: string): void {
  const entry = getCatalogProject(storage, 'project-1');
  if (entry === undefined) throw new Error('no entry');
  const bundle = readProjectBundle(storage, entry);
  const session = new EditorSession(storage, bundle.timeline, bundle.visual);
  session.replaceVisualProject({
    ...session.visualProject,
    assets: { a: { id: 'a', kind: 'image', displayName: name } },
  });
}

let counter = 0;
const nextRevision = () => `r${++counter}`;

describe('keeping a folder project saved', () => {
  it('saves a never-saved folder at once, then stays quiet until something changes', async () => {
    const storage = memoryStorage();
    const { port, saves } = fakePort();
    const open = await opened(storage, port);
    const sync = new FolderProjectSync({
      ...open,
      key: 'k',
      storage,
      port,
      newRevisionId: nextRevision,
    });
    expect(isFolderProjectUnsaved(storage, 'project-1')).toBe(true);
    await sync.flush();
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ projectId: 'project-1', baseRevisionId: '', title: 'Summer' });
    expect(isFolderProjectUnsaved(storage, 'project-1')).toBe(false);
    // Reading the project for the save must not count as a change.
    expect(sync.check()).toBe(false);
    await sync.flush();
    expect(saves).toHaveLength(1);
  });

  it('marks a change at once, and saves it on the next flush on top of the last revision', async () => {
    const storage = memoryStorage();
    const { port, saves } = fakePort();
    const open = await opened(storage, port);
    const sync = new FolderProjectSync({
      ...open,
      key: 'k',
      storage,
      port,
      newRevisionId: nextRevision,
    });
    await sync.flush();
    const first = saves[0]?.revisionId;
    edit(storage, 'poster.png');
    expect(sync.check()).toBe(true);
    expect(isFolderProjectUnsaved(storage, 'project-1')).toBe(true);
    await sync.flush();
    expect(saves).toHaveLength(2);
    expect(saves[1]?.baseRevisionId).toBe(first);
    expect(saves[1]?.media).toEqual([{ assetId: 'a', kind: 'image', displayName: 'poster.png' }]);
    expect(isFolderProjectUnsaved(storage, 'project-1')).toBe(false);
  });

  it('saves a renamed title into the folder', async () => {
    const storage = memoryStorage();
    const { port, saves } = fakePort();
    const open = await opened(storage, port);
    const sync = new FolderProjectSync({
      ...open,
      key: 'k',
      storage,
      port,
      newRevisionId: nextRevision,
    });
    await sync.flush();
    renameLocalProject(storage, getCatalogProject(storage, 'project-1')!, 'Summer final');
    await sync.flush();
    expect(saves[1]?.title).toBe('Summer final');
  });

  it('saves a last time on close, then lets the folder go', async () => {
    const storage = memoryStorage();
    const { port, saves } = fakePort();
    const open = await opened(storage, port);
    const sync = new FolderProjectSync({
      ...open,
      key: 'k',
      storage,
      port,
      newRevisionId: nextRevision,
    });
    await sync.flush();
    edit(storage, 'last.png');
    await sync.close();
    expect(saves).toHaveLength(2);
    expect(port.close).toHaveBeenCalledWith('k');
    expect(sync.check()).toBe(false);
  });

  it('keeps the unsaved mark and tells the owner once when a save fails, then tries again', async () => {
    const storage = memoryStorage();
    let fail = true;
    const { port, saves } = fakePort((save) =>
      fail
        ? { kind: 'refused', code: 'failed' }
        : { kind: 'saved', revisionId: save.revisionId, notStored: [] },
    );
    const onNotice = vi.fn();
    const open = await opened(storage, port);
    const sync = new FolderProjectSync({
      ...open,
      key: 'k',
      storage,
      port,
      onNotice,
      newRevisionId: nextRevision,
    });
    await sync.flush();
    await sync.flush();
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice.mock.calls[0]?.[0]).toMatch(/kept in the app/);
    expect(isFolderProjectUnsaved(storage, 'project-1')).toBe(true);
    fail = false;
    await sync.flush();
    expect(saves).toHaveLength(3);
    expect(isFolderProjectUnsaved(storage, 'project-1')).toBe(false);
  });

  it('stops saving after the folder says it changed elsewhere, and keeps the changes marked', async () => {
    const storage = memoryStorage();
    const { port, saves } = fakePort(() => ({ kind: 'refused', code: 'save-conflict' }));
    const onNotice = vi.fn();
    const open = await opened(storage, port);
    const sync = new FolderProjectSync({
      ...open,
      key: 'k',
      storage,
      port,
      onNotice,
      newRevisionId: nextRevision,
    });
    await sync.flush();
    edit(storage, 'more.png');
    await sync.flush();
    expect(saves).toHaveLength(1);
    expect(onNotice.mock.calls[0]?.[0]).toMatch(/changed somewhere else/);
    expect(isFolderProjectUnsaved(storage, 'project-1')).toBe(true);
  });

  it('tells the owner which media the folder could not get', async () => {
    const storage = memoryStorage();
    const { port } = fakePort((save) => ({
      kind: 'saved',
      revisionId: save.revisionId,
      notStored: ['a'],
    }));
    const onNotice = vi.fn();
    const open = await opened(storage, port);
    const sync = new FolderProjectSync({
      ...open,
      key: 'k',
      storage,
      port,
      onNotice,
      newRevisionId: nextRevision,
    });
    edit(storage, 'logo.png');
    await sync.flush();
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('logo.png'), 'info');
  });
});
