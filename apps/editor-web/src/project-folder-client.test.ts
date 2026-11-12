import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  answerProjectFolder,
  closeProjectFolder,
  createProjectFolder,
  loadProjectFolder,
  projectFolderMediaStates,
  readProjectFolderMedia,
  saveProjectFolder,
  listProjectFolders,
  openProjectFolder,
  projectFoldersAvailable,
  restoreProjectFolder,
} from './project-folder-client.js';

/** Installs the desktop bridge the way preload.cjs does, and returns the invoke spy. */
function installBridge(reply: unknown = { kind: 'listed', folders: [] }) {
  const invoke = vi.fn(async (_channel: string, _payload?: unknown) => reply);
  (globalThis as { window?: unknown }).window = { joyDesktop: { channels: [], invoke } };
  return invoke;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('the project-folder client', () => {
  it('is unavailable, and refuses to call, outside the desktop app', async () => {
    expect(projectFoldersAvailable()).toBe(false);
    await expect(listProjectFolders()).rejects.toThrow('Project folders need the desktop app');
  });

  it('is available when the desktop bridge is present', () => {
    installBridge();
    expect(projectFoldersAvailable()).toBe(true);
  });

  it('lists folders through the list channel and returns the desktop reply', async () => {
    const invoke = installBridge({
      kind: 'listed',
      folders: [{ key: 'folder-1', name: 'A.joyproj' }],
    });
    await expect(listProjectFolders()).resolves.toEqual({
      kind: 'listed',
      folders: [{ key: 'folder-1', name: 'A.joyproj' }],
    });
    expect(invoke).toHaveBeenCalledWith('desktop.project-folder.list', {});
  });

  it('sends the title for a create, and the key for an open', async () => {
    const invoke = installBridge({ kind: 'refused', code: 'no-title' });
    await createProjectFolder('Summer');
    expect(invoke).toHaveBeenLastCalledWith('desktop.project-folder.create', { title: 'Summer' });
    await openProjectFolder('folder-1');
    expect(invoke).toHaveBeenLastCalledWith('desktop.project-folder.open', { key: 'folder-1' });
  });

  it('sends the key and the owner’s answer, and the key and title for a restore', async () => {
    const invoke = installBridge({ kind: 'restored' });
    await answerProjectFolder('folder-1', 'copy');
    expect(invoke).toHaveBeenLastCalledWith('desktop.project-folder.answer', {
      key: 'folder-1',
      answer: 'copy',
    });
    await restoreProjectFolder('folder-1', 'Back');
    expect(invoke).toHaveBeenLastCalledWith('desktop.project-folder.restore', {
      key: 'folder-1',
      title: 'Back',
    });
  });

  it('sends only the key to load and close an open folder', async () => {
    const invoke = installBridge({ kind: 'closed' });
    await loadProjectFolder('folder-1');
    expect(invoke).toHaveBeenLastCalledWith('desktop.project-folder.load', { key: 'folder-1' });
    await closeProjectFolder('folder-1');
    expect(invoke).toHaveBeenLastCalledWith('desktop.project-folder.close', { key: 'folder-1' });
  });

  it('sends a save with its key, and media by id only', async () => {
    const invoke = installBridge({ kind: 'saved', revisionId: 'r1', notStored: [] });
    const save = {
      projectId: 'project-1',
      baseRevisionId: '',
      revisionId: 'r1',
      title: 'Summer',
      document: { timeline: {}, visual: {} },
      media: [{ assetId: 'joylib-a', kind: 'video', displayName: 'beach.mp4' }],
    };
    await expect(saveProjectFolder('folder-1', save)).resolves.toEqual({
      kind: 'saved',
      revisionId: 'r1',
      notStored: [],
    });
    expect(invoke).toHaveBeenLastCalledWith('desktop.project-folder.save', {
      key: 'folder-1',
      ...save,
    });
  });

  it('asks for media states by ids, and media bytes by id and offset', async () => {
    const invoke = installBridge({ kind: 'media', states: [] });
    await projectFolderMediaStates('folder-1', ['joylib-a']);
    expect(invoke).toHaveBeenLastCalledWith('desktop.project-folder.media', {
      key: 'folder-1',
      assetIds: ['joylib-a'],
    });
    await readProjectFolderMedia('folder-1', 'joylib-a', 64);
    expect(invoke).toHaveBeenLastCalledWith('desktop.project-folder.media', {
      key: 'folder-1',
      assetId: 'joylib-a',
      offset: 64,
    });
  });
});
