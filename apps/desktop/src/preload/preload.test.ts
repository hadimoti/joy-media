import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../ipc.js';

const require = createRequire(import.meta.url);

describe('preload channel allow-list', () => {
  it('ipc-channels.cjs (shared by preload.cjs) matches ../ipc.ts IPC_CHANNELS exactly', () => {
    // preload.cjs itself is not require()-able outside a real Electron process: requiring
    // 'electron' from plain Node resolves to a binary path, not the API, so the module-level
    // contextBridge.exposeInMainWorld() call would throw. ipc-channels.cjs is the electron-
    // free data file preload.cjs and this test both read, so the allow-list can be checked
    // without an Electron runtime.
    const channels = require('./ipc-channels.cjs') as { IPC_CHANNELS: readonly string[] };
    expect(channels.IPC_CHANNELS).toEqual(IPC_CHANNELS);
  });

  it('allows the session token channels and rejects an unknown channel in preload', async () => {
    const exposed = new Map<string, unknown>();
    const electron = {
      contextBridge: {
        exposeInMainWorld: (name: string, value: unknown) => exposed.set(name, value),
      },
      ipcRenderer: {
        invoke: async (_endpoint: string, request: { channel: string }) => ({
          ok: true,
          data: request.channel,
        }),
      },
    };
    const preloadPath = path.join(import.meta.dirname, 'preload.cjs');
    const source = fs.readFileSync(preloadPath, 'utf8');
    const module = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(source, {
      module,
      exports: module.exports,
      require: (name: string) =>
        name === 'electron' ? electron : require(path.resolve(path.dirname(preloadPath), name)),
      window: { location: { origin: 'http://localhost:5173' } },
    });

    const bridge = exposed.get('joyDesktop') as {
      channels: readonly string[];
      invoke: (channel: string, payload?: unknown) => Promise<unknown>;
    };
    expect(Object.keys(bridge).sort()).toEqual(['channels', 'invoke']);
    for (const channel of [
      'desktop.media-session.get',
      'desktop.media-session.set',
      'desktop.media-session.clear',
    ]) {
      await expect(bridge.invoke(channel)).resolves.toBe(channel);
    }
    await expect(bridge.invoke('desktop.execute')).rejects.toThrow('Blocked IPC channel');
  });
});
