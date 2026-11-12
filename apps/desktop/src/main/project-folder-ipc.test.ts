import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../ipc.js';
import { PROJECT_FOLDER_CHANNELS, createProjectFolderHandlers } from './project-folder-ipc.js';
import type { ProjectFolderRequestOp } from '@joy-media/project-store';

/** A worker port that answers every request with an empty listing, and records what it was asked. */
function fakePort() {
  const request = vi.fn(
    async (_op: ProjectFolderRequestOp, _payload: unknown): Promise<unknown> => ({
      kind: 'listed',
      folders: [],
    }),
  );
  return { request };
}

const INVALID = { ok: false, error: 'Invalid project folder request' };

describe('the desktop.project-folder channels', () => {
  it('are all in the allow-listed IPC channels', () => {
    for (const channel of PROJECT_FOLDER_CHANNELS) {
      expect(IPC_CHANNELS).toContain(channel);
    }
  });

  it('are refused, with a plain message, when no worker is wired', async () => {
    const handlers = createProjectFolderHandlers(undefined);
    expect(await handlers['desktop.project-folder.list']({})).toEqual({
      ok: false,
      error: 'Project folders are not available in this build',
    });
  });

  it('pass a list request to the worker, and return its reply as data', async () => {
    const port = fakePort();
    const handlers = createProjectFolderHandlers(port);
    expect(await handlers['desktop.project-folder.list']({})).toEqual({
      ok: true,
      data: { kind: 'listed', folders: [] },
    });
    expect(port.request).toHaveBeenCalledWith('list', {});
  });

  it('trim a create title, and refuse a missing or overlong one without calling the worker', async () => {
    const port = fakePort();
    const handlers = createProjectFolderHandlers(port);
    await handlers['desktop.project-folder.create']({ title: '  Summer  ' });
    expect(port.request).toHaveBeenLastCalledWith('create', { title: 'Summer' });

    const calls = port.request.mock.calls.length;
    expect(await handlers['desktop.project-folder.create']({})).toEqual(INVALID);
    expect(await handlers['desktop.project-folder.create']({ title: 'x'.repeat(201) })).toEqual(
      INVALID,
    );
    expect(port.request.mock.calls.length).toBe(calls);
  });

  it('refuse an open without a key, and pass one with a key', async () => {
    const port = fakePort();
    const handlers = createProjectFolderHandlers(port);
    expect(await handlers['desktop.project-folder.open']({ key: '' })).toEqual(INVALID);
    await handlers['desktop.project-folder.open']({ key: 'folder-1' });
    expect(port.request).toHaveBeenLastCalledWith('open', { key: 'folder-1' });
  });

  it('accept only the answers original and copy', async () => {
    const port = fakePort();
    const handlers = createProjectFolderHandlers(port);
    expect(
      await handlers['desktop.project-folder.answer']({ key: 'folder-1', answer: 'maybe' }),
    ).toEqual(INVALID);
    await handlers['desktop.project-folder.answer']({ key: 'folder-1', answer: 'copy' });
    expect(port.request).toHaveBeenLastCalledWith('answer', { key: 'folder-1', answer: 'copy' });
  });

  it('pass a restore with its key and trimmed title, and refuse one without a title', async () => {
    const port = fakePort();
    const handlers = createProjectFolderHandlers(port);
    expect(await handlers['desktop.project-folder.restore']({ key: 'folder-1' })).toEqual(INVALID);
    await handlers['desktop.project-folder.restore']({ key: 'folder-1', title: ' Back ' });
    expect(port.request).toHaveBeenLastCalledWith('restore', { key: 'folder-1', title: 'Back' });
  });

  it('pass load and close with a key only', async () => {
    const port = fakePort();
    const handlers = createProjectFolderHandlers(port);
    expect(await handlers['desktop.project-folder.load']({})).toEqual(INVALID);
    await handlers['desktop.project-folder.load']({ key: 'folder-1', path: 'C:\\elsewhere' });
    expect(port.request).toHaveBeenLastCalledWith('load', { key: 'folder-1' });
    await handlers['desktop.project-folder.close']({ key: 'folder-1' });
    expect(port.request).toHaveBeenLastCalledWith('close', { key: 'folder-1' });
  });

  const SHA = 'a'.repeat(64);
  const save = {
    key: 'folder-1',
    projectId: 'project-1',
    baseRevisionId: '',
    revisionId: 'r1',
    title: ' Summer ',
    document: { visual: { id: 'project-1' } },
    media: [{ assetId: `joylib-${SHA}`, kind: 'video', displayName: 'beach.mp4', sha256: SHA }],
  };

  it('add the stored original place to a save, looked up by id in the main process', async () => {
    const port = fakePort();
    const originalPath = vi.fn((id: string) =>
      id === `joylib-${SHA}` ? 'D:\\originals\\a.bin' : undefined,
    );
    const handlers = createProjectFolderHandlers(port, { originalPath });
    await handlers['desktop.project-folder.save']({
      ...save,
      media: [
        { ...save.media[0], sourcePath: 'C:\\Windows\\secret.txt' },
        { assetId: 'joylib-other', kind: 'image', displayName: 'logo.png' },
      ],
    });
    expect(port.request).toHaveBeenLastCalledWith('save', {
      key: 'folder-1',
      projectId: 'project-1',
      baseRevisionId: '',
      revisionId: 'r1',
      title: 'Summer',
      document: { visual: { id: 'project-1' } },
      media: [
        {
          assetId: `joylib-${SHA}`,
          kind: 'video',
          displayName: 'beach.mp4',
          sha256: SHA,
          sourcePath: 'D:\\originals\\a.bin',
        },
        { assetId: 'joylib-other', kind: 'image', displayName: 'logo.png' },
      ],
    });
  });

  it('refuse a malformed save without calling the worker', async () => {
    const port = fakePort();
    const handlers = createProjectFolderHandlers(port);
    const bad = [
      { ...save, key: '' },
      { ...save, projectId: '../x' },
      { ...save, revisionId: '' },
      { ...save, title: '' },
      { ...save, document: 'text' },
      { ...save, document: [1] },
      { ...save, media: 'none' },
      { ...save, media: [{ assetId: 'a/b', kind: 'video', displayName: 'x' }] },
      { ...save, media: [{ assetId: 'a', kind: 'Video!', displayName: 'x' }] },
      { ...save, media: [{ assetId: 'a', kind: 'video', displayName: 'x', sha256: 'zz' }] },
    ];
    for (const payload of bad) {
      expect(await handlers['desktop.project-folder.save'](payload)).toEqual(INVALID);
    }
    expect(port.request).not.toHaveBeenCalled();
  });

  it('pass a media check by ids, or a media read by id and offset', async () => {
    const port = fakePort();
    const handlers = createProjectFolderHandlers(port);
    await handlers['desktop.project-folder.media']({ key: 'folder-1', assetIds: ['joylib-a'] });
    expect(port.request).toHaveBeenLastCalledWith('media', {
      key: 'folder-1',
      assetIds: ['joylib-a'],
    });
    await handlers['desktop.project-folder.media']({
      key: 'folder-1',
      assetId: 'joylib-a',
      offset: 16,
    });
    expect(port.request).toHaveBeenLastCalledWith('media', {
      key: 'folder-1',
      assetId: 'joylib-a',
      offset: 16,
    });
    const calls = port.request.mock.calls.length;
    expect(
      await handlers['desktop.project-folder.media']({ key: 'folder-1', assetIds: ['../a'] }),
    ).toEqual(INVALID);
    expect(
      await handlers['desktop.project-folder.media']({ key: 'folder-1', assetId: 'a', offset: -1 }),
    ).toEqual(INVALID);
    expect(port.request.mock.calls.length).toBe(calls);
  });
});
