// Hand-written CommonJS preload script.
//
// Sandboxed Electron preload scripts must be CommonJS: ESM preload support is version-
// and platform-dependent and this bridge is the single most security-critical file in the
// desktop host, so it is kept out of the tsc/NodeNext ESM build entirely rather than risk a
// silent loader fallback. Keep it small and dependency-free.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { IPC_CHANNELS } = require('./ipc-channels.cjs');

const IPC_ENDPOINT = 'joy-desktop-ipc';

/** @param {string} channel @param {unknown} [payload] */
async function invoke(channel, payload) {
  if (!IPC_CHANNELS.includes(channel)) {
    throw new Error(`Blocked IPC channel: ${channel}`);
  }
  const request = { origin: window.location.origin, channel, payload };
  const result = await ipcRenderer.invoke(IPC_ENDPOINT, request);
  if (!result || result.ok !== true) {
    throw new Error((result && result.error) || 'IPC request failed');
  }
  return result.data;
}

contextBridge.exposeInMainWorld('joyDesktop', {
  channels: IPC_CHANNELS,
  invoke,
});

module.exports = { IPC_CHANNELS, IPC_ENDPOINT };
