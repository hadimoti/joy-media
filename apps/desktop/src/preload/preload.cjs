// Hand-written CommonJS preload script.
//
// Sandboxed Electron preload scripts must be CommonJS: ESM preload support is version-
// and platform-dependent and this bridge is the single most security-critical file in the
// desktop host, so it is kept out of the tsc/NodeNext ESM build entirely rather than risk a
// silent loader fallback. Keep it small and dependency-free.
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const {
  IPC_CHANNELS,
  DROP_FILES_ENDPOINT,
  DROPPED_IMPORT_PROGRESS_CHANNEL,
} = require('./ipc-channels.cjs');

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
  async importDroppedFiles(files) {
    if (!Array.isArray(files) || files.length > 512) {
      throw new Error('Dropped media list is invalid');
    }
    const entries = files.map((file) => {
      const name = file && typeof file.name === 'string' ? file.name.slice(0, 255) : 'unnamed file';
      let path = '';
      try {
        path = webUtils.getPathForFile(file);
      } catch {
        // A JavaScript-created File has no filesystem-backed path. Main will name it as skipped.
      }
      return { path, name };
    });
    const result = await ipcRenderer.invoke(DROP_FILES_ENDPOINT, entries);
    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || 'Dropped files could not be prepared');
    }
    return result.data;
  },
  onDroppedImportProgress(listener) {
    if (typeof listener !== 'function') throw new Error('Progress listener must be a function');
    const handler = (_event, progress) => {
      if (
        !progress ||
        typeof progress.ticketId !== 'string' ||
        (progress.stage !== 'hash' && progress.stage !== 'store') ||
        typeof progress.ratio !== 'number'
      ) {
        return;
      }
      listener({
        ticketId: progress.ticketId,
        stage: progress.stage,
        ratio: Math.min(1, Math.max(0, progress.ratio)),
      });
    };
    ipcRenderer.on(DROPPED_IMPORT_PROGRESS_CHANNEL, handler);
    return () => ipcRenderer.removeListener(DROPPED_IMPORT_PROGRESS_CHANNEL, handler);
  },
});

module.exports = {
  IPC_CHANNELS,
  IPC_ENDPOINT,
  DROP_FILES_ENDPOINT,
  DROPPED_IMPORT_PROGRESS_CHANNEL,
};
