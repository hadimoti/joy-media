import { createRequire } from 'node:module';
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
});
