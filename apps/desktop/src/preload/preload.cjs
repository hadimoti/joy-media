// Hand-written CommonJS preload script.
//
// Sandboxed Electron preload scripts must be CommonJS: ESM preload support is version-
// and platform-dependent and this bridge is the single most security-critical file in the
// desktop host, so it is kept out of the tsc/NodeNext ESM build entirely rather than risk a
// silent loader fallback. Keep it small and dependency-free.
'use strict';
/* global process */

const { contextBridge, ipcRenderer } = require('electron');
const { IPC_CHANNELS } = require('./ipc-channels.cjs');

const IPC_ENDPOINT = 'joy-desktop-ipc';
const PROJECT_STORAGE_IPC_ENDPOINT = 'joy-desktop-project-storage';
const TEST_API_BASE_ARGUMENT = '--joy-media-test-api-base-url=';
const PROJECT_STORAGE_CHANNELS = Object.freeze([
  'desktop.project-storage.get',
  'desktop.project-storage.set',
  'desktop.project-storage.remove',
  'desktop.project-storage.keys',
]);

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

/** @param {'desktop.project-storage.get'|'desktop.project-storage.set'|'desktop.project-storage.remove'|'desktop.project-storage.keys'} channel @param {unknown} payload */
function invokeProjectStorage(channel, payload) {
  if (!PROJECT_STORAGE_CHANNELS.includes(channel)) {
    throw new Error(`Blocked project storage channel: ${channel}`);
  }
  const request = { origin: window.location.origin, channel, payload };
  const result = ipcRenderer.sendSync(PROJECT_STORAGE_IPC_ENDPOINT, request);
  if (!result || result.ok !== true) {
    throw new Error((result && result.error) || 'Project storage request failed');
  }
  return result.data;
}

const projectStorage = Object.freeze({
  /** @param {string} key */
  getItem(key) {
    const value = invokeProjectStorage('desktop.project-storage.get', { key });
    if (value !== null && typeof value !== 'string') {
      throw new Error('Invalid project storage value');
    }
    return value;
  },
  /** @param {string} key @param {string} value */
  setItem(key, value) {
    invokeProjectStorage('desktop.project-storage.set', { key, value });
  },
  /** @param {string} key */
  removeItem(key) {
    invokeProjectStorage('desktop.project-storage.remove', { key });
  },
  keys() {
    const keys = invokeProjectStorage('desktop.project-storage.keys');
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) {
      throw new Error('Invalid project storage key list');
    }
    return keys;
  },
});

contextBridge.exposeInMainWorld('joyDesktop', {
  channels: IPC_CHANNELS,
  invoke,
  projectStorage,
});

// Main process adds this argument only after its explicit test-mode flag and
// loopback-only endpoint validation. Do not read renderer-controlled location
// state to select an API destination.
const testApiArgument = process.argv.find((argument) =>
  argument.startsWith(TEST_API_BASE_ARGUMENT),
);
if (testApiArgument !== undefined) {
  contextBridge.exposeInMainWorld(
    '__JOY_MEDIA_API_BASE__',
    testApiArgument.slice(TEST_API_BASE_ARGUMENT.length),
  );
}

module.exports = { IPC_CHANNELS, IPC_ENDPOINT, PROJECT_STORAGE_IPC_ENDPOINT };
