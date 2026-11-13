import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../ipc.js';

const require = createRequire(import.meta.url);

function loadPreloadForTest() {
  const listeners = new Map<string, (event: unknown) => void>();
  const exposed: Record<string, unknown> = {};
  const ipcRenderer = {
    invoke: vi.fn(async () => ({ ok: true, data: { tickets: [] } })),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name: string, value: unknown) => {
        exposed[name] = value;
      },
    },
    ipcRenderer,
    webUtils: {
      getPathForFile: (file: { readonly path?: string }) => file.path ?? '',
    },
  };
  const module = { exports: {} as Record<string, unknown> };
  const sandbox = {
    require: (id: string) => (id === 'electron' ? electron : require(id)),
    module,
    window: {
      location: { origin: 'joy-media-app://renderer' },
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === 'drop') listeners.set(type, listener);
      },
    },
  };
  const source = readFileSync(fileURLToPath(new URL('./preload.cjs', import.meta.url)), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: 'preload.cjs' });
  return {
    api: exposed['joyDesktop'] as {
      importDroppedFiles(files: readonly unknown[]): Promise<unknown>;
    },
    dropListener: listeners.get('drop'),
    ipcRenderer,
  };
}

describe('preload channel allow-list', () => {
  it('exposes the generation job lifecycle through the shared channel list', () => {
    expect(IPC_CHANNELS).toEqual(
      expect.arrayContaining([
        'desktop.generation.start',
        'desktop.generation.status',
        'desktop.generation.cancel',
        'desktop.generation.list',
      ]),
    );
  });

  it('ipc-channels.cjs (shared by preload.cjs) matches ../ipc.ts IPC_CHANNELS exactly', () => {
    // preload.cjs itself is not require()-able outside a real Electron process: requiring
    // 'electron' from plain Node resolves to a binary path, not the API, so the module-level
    // contextBridge.exposeInMainWorld() call would throw. ipc-channels.cjs is the electron-
    // free data file preload.cjs and this test both read, so the allow-list can be checked
    // without an Electron runtime.
    const channels = require('./ipc-channels.cjs') as { IPC_CHANNELS: readonly string[] };
    expect(channels.IPC_CHANNELS).toEqual(IPC_CHANNELS);
  });

  it('keeps the drop-path endpoint outside the generic renderer invoke list', () => {
    const channels = require('./ipc-channels.cjs') as {
      IPC_CHANNELS: readonly string[];
      DROP_FILES_ENDPOINT: string;
    };
    expect(channels.IPC_CHANNELS).not.toContain(channels.DROP_FILES_ENDPOINT);
  });

  it('does not mint drop tickets when the bridge is called outside a drop event', async () => {
    const preload = loadPreloadForTest();
    const file = {
      name: 'clip.mp4',
      size: 12,
      lastModified: 1,
      type: 'video/mp4',
      path: 'C:\\drop\\clip.mp4',
    };

    await expect(preload.api.importDroppedFiles([file])).rejects.toThrow(/drop/i);
    expect(preload.ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('refuses an untrusted synthetic drop event before creating tickets', async () => {
    const preload = loadPreloadForTest();
    const file = {
      name: 'clip.mp4',
      size: 12,
      lastModified: 1,
      type: 'video/mp4',
      path: 'C:\\drop\\clip.mp4',
    };
    preload.dropListener?.({ isTrusted: false, dataTransfer: { files: [file] } });

    await expect(preload.api.importDroppedFiles([file])).rejects.toThrow(/drop/i);
    expect(preload.ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('only creates tickets for the files in the most recent trusted drop', async () => {
    const preload = loadPreloadForTest();
    const file = {
      name: 'clip.mp4',
      size: 12,
      lastModified: 1,
      type: 'video/mp4',
      path: 'C:\\drop\\clip.mp4',
    };
    const otherFile = { ...file, path: 'C:\\other\\clip.mp4' };
    preload.dropListener?.({ isTrusted: true, dataTransfer: { files: [file] } });

    await expect(preload.api.importDroppedFiles([otherFile])).rejects.toThrow(/drop/i);
    expect(preload.ipcRenderer.invoke).not.toHaveBeenCalled();

    preload.dropListener?.({ isTrusted: true, dataTransfer: { files: [file] } });
    await expect(preload.api.importDroppedFiles([file])).resolves.toEqual({ tickets: [] });
    expect(preload.ipcRenderer.invoke).toHaveBeenCalledOnce();
  });
});
