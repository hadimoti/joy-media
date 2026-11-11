import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  answerProjectFolder,
  createProjectFolder,
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
});
