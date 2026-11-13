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
const DROP_AUTH_WINDOW_MS = 2000;
let authorizedDrop;

/** @param {unknown} file */
function droppedFileEntry(file) {
  const name = file && typeof file.name === 'string' ? file.name.slice(0, 255) : 'unnamed file';
  let path = '';
  try {
    path = webUtils.getPathForFile(file);
  } catch {
    // A JavaScript-created File has no filesystem-backed path. Main will skip it.
  }
  return {
    path,
    name,
    size: file && typeof file.size === 'number' ? file.size : -1,
    lastModified: file && typeof file.lastModified === 'number' ? file.lastModified : -1,
    type: file && typeof file.type === 'string' ? file.type : '',
  };
}

function sameDroppedFiles(expected, received) {
  return (
    expected.length === received.length &&
    expected.every((entry, index) => {
      const candidate = received[index];
      return (
        candidate !== undefined &&
        entry.path === candidate.path &&
        entry.name === candidate.name &&
        entry.size === candidate.size &&
        entry.lastModified === candidate.lastModified &&
        entry.type === candidate.type
      );
    })
  );
}

// The editor must consume this capture-phase authorization from its drop handler.
window.addEventListener(
  'drop',
  (event) => {
    authorizedDrop = undefined;
    if (event.isTrusted !== true || !event.dataTransfer) return;
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0 || files.length > 512) return;
    authorizedDrop = {
      entries: files.map(droppedFileEntry),
      expiresAt: Date.now() + DROP_AUTH_WINDOW_MS,
    };
  },
  true,
);

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
    const drop = authorizedDrop;
    authorizedDrop = undefined;
    const entries = files.map(droppedFileEntry);
    if (
      drop === undefined ||
      Date.now() >= drop.expiresAt ||
      !sameDroppedFiles(drop.entries, entries)
    ) {
      throw new Error('Dropped files must come from the current trusted drop event');
    }
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
