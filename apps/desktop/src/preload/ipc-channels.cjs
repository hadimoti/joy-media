// Plain data, no `electron` import: this file exists so tests (and preload.cjs) can share
// the allow-listed channel array without ever loading the real `electron` module outside an
// actual Electron process (requiring 'electron' from plain Node resolves to a path string,
// not the API, and would make the module below unsafe to `require()` in a unit test).
//
// MUST match ../ipc.ts's IPC_CHANNELS exactly - preload.test.ts asserts that.
'use strict';

const IPC_CHANNELS = Object.freeze([
  'desktop.select-file',
  'desktop.revoke-file',
  'desktop.request-derivative',
  'desktop.worker-status',
  'desktop.startup-preference',
  'desktop.job-status',
  'desktop.cancel-job',
  'desktop.provider-profile.save',
  'desktop.provider-profile.list',
  'desktop.provider-profile.delete',
  'desktop.provider-profile.begin-session',
  'desktop.provider-profile.test',
  'desktop.provider-profile.fetch-models',
  'desktop.check-for-update',
  'desktop.window-minimize',
  'desktop.window-maximize',
  'desktop.window-close',
  'desktop.window-is-maximized',
  'desktop.asset-library.get-settings',
  'desktop.asset-library.set-directory',
  'desktop.asset-library.select-directory',
  'desktop.asset-library.get-catalog',
  'desktop.asset-library.reset-directory',
]);

module.exports = { IPC_CHANNELS };
